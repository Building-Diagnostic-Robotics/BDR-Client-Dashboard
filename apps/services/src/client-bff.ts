import { artifactAccessRequestSchema, reportTypeSchema } from "@bdr/contracts";
import { DomainError } from "@bdr/domain";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { ZodError } from "zod";

import { CognitoClientOAuth, DynamoClientAuthStore, KmsTokenCipher, clientRuntimeConfig } from "./auth/aws-client";
import { ClientAuthService, loginCookie, query } from "./auth/client";
import {
  CLIENT_CSRF_COOKIE,
  CLIENT_LOGIN_COOKIE,
  CLIENT_SESSION_COOKIE,
  assertMutationRequest,
} from "./auth/primitives";
import { JSON_HEADERS, clearCookie, json, redirect, requestId, secureCookie } from "./shared/http";
import { ClientResourceService } from "./client/resources";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_MAX_AGE_SECONDS = 10 * 60;

type Dependencies = Readonly<{
  service: Pick<ClientAuthService, "startLogin" | "finishLogin" | "authenticate" | "logout">;
  portalOrigin: string;
  resources?: ClientResourceService;
}>;

type HttpHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

function sessionCookies(rawSessionId: string, csrfToken: string): string[] {
  return [
    secureCookie(CLIENT_SESSION_COOKIE, rawSessionId, {
      httpOnly: true,
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      sameSite: "Lax",
    }),
    secureCookie(CLIENT_CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      sameSite: "Strict",
    }),
  ];
}

const clearClientCookies = [
  clearCookie(CLIENT_SESSION_COOKIE, true),
  clearCookie(CLIENT_CSRF_COOKIE, false),
  clearCookie(CLIENT_LOGIN_COOKIE, true),
];

function loginRetryResponse(event: APIGatewayProxyEventV2): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 401,
    headers: {
      ...JSON_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "x-request-id": requestId(event),
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
    body: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in again — BDR Inspections Dashboard</title>
<style>body{margin:0;background:#f9fafb;color:#111827;font:16px/1.6 Arial,sans-serif}main{max-width:480px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:12px}img{max-width:240px;width:100%;height:auto}h1{font-size:26px}a{display:inline-block;padding:12px 20px;background:#15803d;color:#fff;border-radius:6px;text-decoration:none}a:focus-visible{outline:3px solid #111827;outline-offset:3px}</style></head>
<body><main><img src="/bdr_logo_name_cropped.png" alt="Building Diagnostic Robotics"><h1>Please sign in again</h1><p>This sign-in attempt could not be completed. It may have expired or already been used.</p><a href="/bff/auth/login?returnTo=%2Fprojects">Sign in again</a></main></body></html>`,
  };
}

async function recoverLogin(
  dependencies: Dependencies,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    // The rejected callback grants nothing. Authenticate the existing session separately.
    const active = await dependencies.service.authenticate(event);
    return redirect("/projects", active.csrfToken
      ? sessionCookies(active.rawSessionId, active.csrfToken)
      : []);
  } catch (error) {
    if (error instanceof DomainError &&
      (error.code === "AUTHENTICATION_REQUIRED" || error.code === "FORBIDDEN")) {
      // Do not delete cookies that may belong to another tab's valid session/login attempt.
      return loginRetryResponse(event);
    }
    throw error;
  }
}

function errorResponse(
  error: unknown,
  event: APIGatewayProxyEventV2,
): APIGatewayProxyStructuredResultV2 {
  if (error instanceof DomainError) {
    const statusCode = error.code === "AUTHENTICATION_REQUIRED" ? 401 : error.code === "NOT_FOUND" ? 404 : 403;
    return json(
      statusCode,
      { error: statusCode === 401 ? "authentication_required" : statusCode === 404 ? "not_found" : "access_denied" },
      {
        headers: { "x-request-id": requestId(event) },
        ...(statusCode === 401 ? { cookies: clearClientCookies } : {}),
      },
    );
  }
  if (error instanceof ZodError) return json(400, { error: "invalid_request" });
  console.error(JSON.stringify({
    requestId: requestId(event),
    error: "client_bff_failure",
    ...(error instanceof Error ? { errorName: error.name, errorMessage: error.message } : {}),
  }));
  return json(500, { error: "internal_error" });
}

export function createClientBffHandler(dependencies: Dependencies): HttpHandler {
  return async (event) => {
    try {
      const method = event.requestContext.http.method;
      const path = event.rawPath;
      if (method === "GET" && path === "/health") return json(200, { status: "ok" });

      if (method === "GET" && path === "/bff/auth/login") {
        const started = await dependencies.service.startLogin(query(event, "returnTo"));
        return redirect(started.authorizationUrl, [
          secureCookie(CLIENT_LOGIN_COOKIE, started.state, {
            httpOnly: true,
            maxAgeSeconds: LOGIN_MAX_AGE_SECONDS,
            sameSite: "Lax",
          }),
        ]);
      }

      if (method === "GET" && path === "/bff/auth/callback") {
        if (query(event, "error")) {
          console.warn(JSON.stringify({
            requestId: requestId(event),
            error: "client_login_rejected",
            reason: "cognito_authorization_error",
          }));
          return await recoverLogin(dependencies, event);
        }
        let established: Awaited<ReturnType<Dependencies["service"]["finishLogin"]>>;
        try {
          established = await dependencies.service.finishLogin({
            code: query(event, "code"),
            state: query(event, "state"),
            loginCookie: loginCookie(event),
            requestId: requestId(event),
          });
        } catch (error) {
          if (error instanceof DomainError && error.code === "AUTHENTICATION_REQUIRED") {
            return await recoverLogin(dependencies, event);
          }
          throw error;
        }
        return redirect(established.returnTo, [
          ...sessionCookies(established.rawSessionId, established.csrfToken),
          clearCookie(CLIENT_LOGIN_COOKIE, true),
        ]);
      }

      if (method === "GET" && path === "/bff/auth/session") {
        const active = await dependencies.service.authenticate(event);
        return json(
          200,
          { authenticated: true },
          active.csrfToken
            ? { cookies: sessionCookies(active.rawSessionId, active.csrfToken) }
            : {},
        );
      }

      if (method === "POST" && path === "/bff/logout") {
        const active = await dependencies.service.authenticate(event, false);
        assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
        const logoutUrl = await dependencies.service.logout(event, requestId(event));
        return json(200, { logoutUrl }, { cookies: clearClientCookies });
      }

      if (path.startsWith("/bff/") && dependencies.resources) {
        const active = await dependencies.service.authenticate(event);
        const context = await dependencies.resources.policy.loadActiveClientContext({ rawSessionId: active.rawSessionId, now: new Date() });
        let matched: RegExpExecArray | null;
        if (method === "GET" && path === "/bff/me") return json(200, dependencies.resources.me(context));
        if (method === "GET" && path === "/bff/me/projects") return json(200, { items: await dependencies.resources.projects(context) });
        if (method === "GET" && path === "/bff/me/documents/how-to-read") return json(200, await dependencies.resources.howToRead(context));
        if (method === "POST" && path === "/bff/me/documents/how-to-read/access") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          const disposition = artifactAccessRequestSchema.parse(JSON.parse(event.body ?? "{}")).disposition;
          return json(200, await dependencies.resources.documentAccess(context, disposition, requestId(event)));
        }
        matched = /^\/bff\/projects\/([^/]+)$/.exec(path);
        if (method === "GET" && matched) return json(200, await dependencies.resources.project(context, decodeURIComponent(matched[1]!)));
        matched = /^\/bff\/projects\/([^/]+)\/inspections$/.exec(path);
        if (method === "GET" && matched) return json(200, { items: await dependencies.resources.inspections(context, decodeURIComponent(matched[1]!)) });
        matched = /^\/bff\/projects\/([^/]+)\/inspections\/([^/]+)$/.exec(path);
        if (method === "GET" && matched) return json(200, await dependencies.resources.inspection(context, decodeURIComponent(matched[1]!), decodeURIComponent(matched[2]!)));
        matched = /^\/bff\/projects\/([^/]+)\/inspections\/([^/]+)\/reports$/.exec(path);
        if (method === "GET" && matched) return json(200, { items: await dependencies.resources.reports(context, decodeURIComponent(matched[1]!), decodeURIComponent(matched[2]!)) });
        matched = /^\/bff\/projects\/([^/]+)\/inspections\/([^/]+)\/reports\/([^/]+)\/access$/.exec(path);
        if (method === "POST" && matched) {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          const disposition = artifactAccessRequestSchema.parse(JSON.parse(event.body ?? "{}")).disposition;
          return json(200, await dependencies.resources.reportAccess(context, decodeURIComponent(matched[1]!), decodeURIComponent(matched[2]!), reportTypeSchema.parse(decodeURIComponent(matched[3]!)), disposition, requestId(event)));
        }
      }

      return json(404, { error: "not_found" });
    } catch (error) {
      return errorResponse(error, event);
    }
  };
}

let runtimeHandler: HttpHandler | undefined;

export const handler: HttpHandler = async (event) => {
  if (!runtimeHandler) {
    const config = clientRuntimeConfig();
    const artifactSignerFunctionName = process.env.ARTIFACT_SIGNER_FUNCTION_NAME;
    if (!artifactSignerFunctionName) throw new Error("Missing required environment variable ARTIFACT_SIGNER_FUNCTION_NAME");
    runtimeHandler = createClientBffHandler({
      portalOrigin: config.portalOrigin,
      service: new ClientAuthService(
        new DynamoClientAuthStore(config),
        new KmsTokenCipher(config.applicationKeyArn),
        new CognitoClientOAuth(config),
      ),
      resources: new ClientResourceService({ ...config, artifactSignerFunctionName }),
    });
  }
  return runtimeHandler(event);
};
