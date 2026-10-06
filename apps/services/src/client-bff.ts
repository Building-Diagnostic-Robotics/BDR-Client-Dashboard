import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import {
  artifactAccessRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  reportTypeSchema,
} from "@bdr/contracts";
import { DomainError } from "@bdr/domain";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { ZodError } from "zod";

import { AdminPoolOAuth } from "./auth/admin-oauth";
import { cognitoUserExists } from "./auth/cognito-user-pools";
import { passwordLogin } from "./auth/password-login";
import {
  confirmPasswordReset,
  PasswordResetServiceError,
  requestPasswordReset,
} from "./auth/password-reset";

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
import { emailBlocked } from "./portal/email";
import { allowedClientKey, clientCanSee, commitHowToRead, createClientAccount, createPortalAdmin, currentHowToReadForOrg, grantPortalAdmin, howToReadFor, howToReadUpload, linkClient, listClientUsers, listLinkedClients, listPortalBuildings, listUnlinkedFolders, loadPortalStatus, loadPortalStatusVersion, ownsPrefix, PORTAL_ADMIN_ORGANIZATION_ID, renameClient, replaceClientEmail, reportFileMatches, resendClientInvite, revokeClientUser, savePortalStatus, signedRead, signedReadWithDisposition, signedUpload } from "./portal/buildings";

const cognito = new CognitoIdentityProviderClient({});
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const LOGIN_MAX_AGE_SECONDS = 10 * 60;

type Dependencies = Readonly<{
  service: Pick<ClientAuthService, "startLogin" | "finishLogin" | "authenticate" | "logout" | "establishVerifiedSession">;
  adminService?: Pick<ClientAuthService, "startLogin" | "finishLogin">;
  ensureAdmin?: (input: { issuer: string; sub: string; organizationId: string; userId: string }) => Promise<unknown>;
  portalOrigin: string;
  adminIssuer?: string;
  clientOauth?: CognitoClientOAuth;
  adminOauth?: AdminPoolOAuth;
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
<body><main><img src="/bdr_logo_name_cropped.png" alt="Building Diagnostic Robotics"><h1>Please sign in again</h1><p>This sign-in attempt could not be completed. It may have expired or already been used.</p><a href="/sign-in?returnTo=%2Fprojects">Sign in again</a></main></body></html>`,
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
    const statusCode = error.code === "AUTHENTICATION_REQUIRED"
      ? 401
      : error.code === "NOT_FOUND"
        ? 404
        : error.code === "CONFLICT"
          ? 409
          : 403;
    const errorCode = statusCode === 401
      ? "authentication_required"
      : statusCode === 404
        ? "not_found"
        : statusCode === 409
          ? "conflict"
          : "access_denied";
    return json(
      statusCode,
      { error: errorCode, ...(statusCode === 409 ? { message: error.message } : {}) },
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

      if (method === "POST" && path === "/bff/auth/password") {
        const body = JSON.parse(event.body ?? "{}") as {
          email?: string;
          password?: string;
          returnTo?: string;
          mfaCode?: string;
          mfaSession?: string;
          newPassword?: string;
        };
        const adminPoolId = dependencies.adminIssuer?.split("/").pop();
        try {
          const result = await passwordLogin({
            email: body.email ?? "",
            password: body.password ?? "",
            ...(body.mfaCode ? { mfaCode: body.mfaCode } : {}),
            ...(body.mfaSession ? { mfaSession: body.mfaSession } : {}),
            ...(body.newPassword ? { newPassword: body.newPassword } : {}),
            ...(adminPoolId ? { adminPoolId } : {}),
            ...(process.env.ADMIN_APP_CLIENT_ID ? { adminClientId: process.env.ADMIN_APP_CLIENT_ID } : {}),
            ...(process.env.CLIENT_USER_POOL_ID ? { clientPoolId: process.env.CLIENT_USER_POOL_ID } : {}),
            ...(process.env.CLIENT_APP_CLIENT_ID ? { clientClientId: process.env.CLIENT_APP_CLIENT_ID } : {}),
            ...(process.env.CLIENT_APP_SECRET_ARN ? { clientSecretArn: process.env.CLIENT_APP_SECRET_ARN } : {}),
          });
          if (result.kind === "mfa") return json(200, { mfa: true, session: result.session });
          if (result.kind === "new-password") return json(200, { newPassword: true, session: result.session });
          const oauth = result.admin ? dependencies.adminOauth : dependencies.clientOauth;
          if (!oauth) return json(401, { error: "sign_in_failed" });
          const verified = await oauth.verifyIssued(result.tokens);
          if (result.admin) {
            if (!dependencies.ensureAdmin) return json(401, { error: "sign_in_failed" });
            const userId = `adm${verified.sub.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
            await dependencies.ensureAdmin({
              issuer: verified.issuer,
              sub: verified.sub,
              organizationId: PORTAL_ADMIN_ORGANIZATION_ID,
              userId,
            });
            await grantPortalAdmin(PORTAL_ADMIN_ORGANIZATION_ID);
          }
          const started = await dependencies.service.startLogin(body.returnTo);
          const established = await dependencies.service.establishVerifiedSession({
            verified,
            tokens: result.tokens,
            returnTo: body.returnTo && body.returnTo.startsWith("/") ? body.returnTo : "/projects",
            requestId: requestId(event),
            state: started.state,
          });
          return json(200, { returnTo: established.returnTo }, {
            cookies: [
              ...sessionCookies(established.rawSessionId, established.csrfToken),
              clearCookie(CLIENT_LOGIN_COOKIE, true),
            ],
          });
        } catch (error) {
          console.warn(JSON.stringify({
            requestId: requestId(event),
            error: "password_login_failed",
            message: error instanceof Error ? error.message : "unknown",
          }));
          return json(401, { error: "sign_in_failed" });
        }
      }

      if (method === "POST" && path === "/bff/auth/password/reset/request") {
        let body: unknown;
        try {
          body = JSON.parse(event.body ?? "{}");
        } catch {
          return json(400, { error: "invalid_request", message: "Invalid JSON body" });
        }
        const parsed = passwordResetRequestSchema.safeParse(body);
        if (!parsed.success) {
          return json(400, { error: "invalid_request", message: "A valid email is required" });
        }
        const adminPoolId = dependencies.adminIssuer?.split("/").pop();
        try {
          const result = await requestPasswordReset({
            email: parsed.data.email,
            ...(adminPoolId ? { adminPoolId } : {}),
            ...(process.env.ADMIN_APP_CLIENT_ID ? { adminClientId: process.env.ADMIN_APP_CLIENT_ID } : {}),
            ...(process.env.CLIENT_USER_POOL_ID ? { clientPoolId: process.env.CLIENT_USER_POOL_ID } : {}),
            ...(process.env.CLIENT_APP_CLIENT_ID ? { clientClientId: process.env.CLIENT_APP_CLIENT_ID } : {}),
            ...(process.env.CLIENT_APP_SECRET_ARN ? { clientSecretArn: process.env.CLIENT_APP_SECRET_ARN } : {}),
          });
          return json(200, result);
        } catch (error) {
          if (error instanceof PasswordResetServiceError) {
            return json(error.statusCode, { error: error.code, message: error.message });
          }
          console.warn(JSON.stringify({
            requestId: requestId(event),
            error: "password_reset_request_failed",
            message: error instanceof Error ? error.message : "unknown",
          }));
          return json(500, { error: "reset_failed", message: "Unable to request password reset. Please try again." });
        }
      }

      if (method === "POST" && path === "/bff/auth/password/reset/confirm") {
        let body: unknown;
        try {
          body = JSON.parse(event.body ?? "{}");
        } catch {
          return json(400, { error: "invalid_request", message: "Invalid JSON body" });
        }
        const parsed = passwordResetConfirmSchema.safeParse(body);
        if (!parsed.success) {
          return json(400, { error: "invalid_request", message: "Invalid reset confirmation details" });
        }
        const adminPoolId = dependencies.adminIssuer?.split("/").pop();
        try {
          const result = await confirmPasswordReset({
            email: parsed.data.email,
            confirmationCode: parsed.data.confirmationCode,
            newPassword: parsed.data.newPassword,
            ...(adminPoolId ? { adminPoolId } : {}),
            ...(process.env.ADMIN_APP_CLIENT_ID ? { adminClientId: process.env.ADMIN_APP_CLIENT_ID } : {}),
            ...(process.env.CLIENT_USER_POOL_ID ? { clientPoolId: process.env.CLIENT_USER_POOL_ID } : {}),
            ...(process.env.CLIENT_APP_CLIENT_ID ? { clientClientId: process.env.CLIENT_APP_CLIENT_ID } : {}),
            ...(process.env.CLIENT_APP_SECRET_ARN ? { clientSecretArn: process.env.CLIENT_APP_SECRET_ARN } : {}),
          });
          return json(200, result);
        } catch (error) {
          if (error instanceof PasswordResetServiceError) {
            return json(error.statusCode, { error: error.code, message: error.message });
          }
          console.warn(JSON.stringify({
            requestId: requestId(event),
            error: "password_reset_confirm_failed",
            message: error instanceof Error ? error.message : "unknown",
          }));
          return json(500, { error: "reset_failed", message: "Unable to reset password. Please try again." });
        }
      }

      if (method === "GET" && path === "/bff/auth/start") {
        const email = (query(event, "email") ?? "").trim().toLowerCase();
        const returnTo = query(event, "returnTo") ?? "/projects";
        const back = `/sign-in?returnTo=${encodeURIComponent(returnTo)}&error=unknown`;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect(back);
        const adminPoolId = dependencies.adminIssuer?.split("/").pop();
        const clientPoolId = process.env.CLIENT_USER_POOL_ID;
        const useClient = Boolean(clientPoolId && await cognitoUserExists(cognito, clientPoolId, email));
        const useAdmin = !useClient && Boolean(
          adminPoolId &&
          dependencies.adminService &&
          await cognitoUserExists(cognito, adminPoolId, email),
        );
        if (!useAdmin && !useClient) return redirect(back);
        const started = useAdmin
          ? await dependencies.adminService!.startLogin(returnTo, email)
          : await dependencies.service.startLogin(returnTo, email);
        return redirect(started.authorizationUrl, [
          secureCookie(CLIENT_LOGIN_COOKIE, started.state, {
            httpOnly: true,
            maxAgeSeconds: LOGIN_MAX_AGE_SECONDS,
            sameSite: "Lax",
          }),
        ]);
      }

      if (method === "GET" && path === "/bff/auth/admin/login" && dependencies.adminService) {
        const started = await dependencies.adminService.startLogin(query(event, "returnTo"));
        return redirect(started.authorizationUrl, [
          secureCookie(CLIENT_LOGIN_COOKIE, started.state, {
            httpOnly: true,
            maxAgeSeconds: LOGIN_MAX_AGE_SECONDS,
            sameSite: "Lax",
          }),
        ]);
      }

      if (method === "GET" && path === "/bff/auth/admin/callback" && dependencies.adminService) {
        if (query(event, "error")) return await recoverLogin(dependencies, event);
        let established: Awaited<ReturnType<Dependencies["service"]["finishLogin"]>>;
        try {
          established = await dependencies.adminService.finishLogin({
            code: query(event, "code"),
            state: query(event, "state"),
            loginCookie: loginCookie(event),
            requestId: requestId(event),
          }, async (verified) => {
            const userId = `adm${verified.sub.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
            if (!dependencies.ensureAdmin) throw new Error("Admin identity store is not configured");
            await dependencies.ensureAdmin({
              issuer: verified.issuer,
              sub: verified.sub,
              organizationId: PORTAL_ADMIN_ORGANIZATION_ID,
              userId,
            });
            await grantPortalAdmin(PORTAL_ADMIN_ORGANIZATION_ID);
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
        const admin = Boolean(dependencies.adminIssuer) && context.issuer === dependencies.adminIssuer;
        let matched: RegExpExecArray | null;
        if (method === "GET" && path === "/bff/me") return json(200, dependencies.resources.me(context, admin));
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
        const organizationId = context.organization.organizationId;
        if (method === "GET" && path === "/bff/portal/buildings") {
          return json(200, { items: await listPortalBuildings(organizationId, admin), admin });
        }
        if (method === "GET" && path === "/bff/portal/how-to-read/current") {
          const guide = await currentHowToReadForOrg(organizationId);
          if (!guide) return json(404, { error: "not_found" });
          return json(200, { updatedAt: guide.updatedAt });
        }
        if (method === "POST" && path === "/bff/portal/how-to-read/current/access") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          const disposition = artifactAccessRequestSchema.parse(JSON.parse(event.body ?? "{}")).disposition;
          const guide = await currentHowToReadForOrg(organizationId);
          if (!guide) return json(404, { error: "not_found" });
          return json(200, await signedReadWithDisposition(guide.key, disposition));
        }
        if (method === "GET" && path === "/bff/portal/clients") {
          if (!admin) return json(403, { error: "forbidden" });
          return json(200, { items: await listLinkedClients(), folders: await listUnlinkedFolders() });
        }
        if (method === "POST" && path === "/bff/portal/clients") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { displayName?: string; clientPrefix?: string };
          return json(200, await linkClient({ displayName: String(payload.displayName ?? ""), clientPrefix: String(payload.clientPrefix ?? "") }));
        }
        if (method === "POST" && path === "/bff/portal/admins") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { email?: string };
          return json(200, await createPortalAdmin(String(payload.email ?? "")));
        }
        if (method === "POST" && path === "/bff/portal/client-rename") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { displayName?: string; clientPrefix?: string };
          await renameClient(String(payload.clientPrefix ?? ""), String(payload.displayName ?? ""));
          return json(200, { ok: true });
        }
        if (method === "POST" && path === "/bff/portal/client-account") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { email?: string; clientPrefix?: string };
          const created = await createClientAccount({
            email: String(payload.email ?? ""),
            clientPrefix: String(payload.clientPrefix ?? ""),
          });
          return json(200, created);
        }
        if (method === "GET" && path === "/bff/portal/client-users") {
          if (!admin) return json(403, { error: "forbidden" });
          const clientPrefix = query(event, "client") ?? "";
          return json(200, { items: await listClientUsers(clientPrefix) });
        }
        if (method === "POST" && path === "/bff/portal/client-revoke") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { email?: string; clientPrefix?: string };
          await revokeClientUser(String(payload.clientPrefix || ""), String(payload.email || ""));
          return json(200, { ok: true });
        }
        if (method === "POST" && path === "/bff/portal/client-resend") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { email?: string; clientPrefix?: string };
          await resendClientInvite(String(payload.clientPrefix || ""), String(payload.email || ""));
          return json(200, { ok: true });
        }
        if (method === "POST" && path === "/bff/portal/client-email") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { email?: string; nextEmail?: string; clientPrefix?: string };
          await replaceClientEmail(String(payload.clientPrefix || ""), String(payload.email || ""), String(payload.nextEmail || ""));
          return json(200, { ok: true });
        }
        if (method === "GET" && path === "/bff/portal/how-to-read") {
          if (!admin) return json(403, { error: "forbidden" });
          return json(200, await howToReadFor(query(event, "client") ?? ""));
        }
        if (method === "POST" && path === "/bff/portal/how-to-read") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          if (!admin) return json(403, { error: "forbidden" });
          const payload = JSON.parse(event.body ?? "{}") as { action?: string; clientPrefix?: string; key?: string };
          if (payload.action === "upload") return json(200, await howToReadUpload(String(payload.clientPrefix || "")));
          if (payload.action === "commit") {
            await commitHowToRead(String(payload.clientPrefix || ""), String(payload.key || ""));
            return json(200, { ok: true });
          }
          return json(400, { error: "invalid_request" });
        }
        if (method === "GET" && path === "/bff/portal/file") {
          const prefix = query(event, "prefix") ?? "";
          const key = query(event, "key") ?? "";
          const status = await loadPortalStatus(prefix);
          if (!(await ownsPrefix(organizationId, admin, prefix))) return json(404, { error: "not_found" });
          if (!allowedClientKey(prefix, key)) return json(400, { error: "invalid_request" });
          if (!admin && !clientMayOpenKey(status, key)) return json(404, { error: "not_found" });
          return json(200, { url: await signedRead(key) });
        }
        if (method === "GET" && path === "/bff/portal/building") {
          const prefix = query(event, "prefix") ?? "";
          if (!(await ownsPrefix(organizationId, admin, prefix))) return json(404, { error: "not_found" });
          const status = await loadPortalStatus(prefix);
          if (!clientCanSee(status, organizationId, admin)) return json(404, { error: "not_found" });
          const clientView = { ...status };
          delete clientView.operatorError;
          delete clientView.pendingAdminEmail;
          clientView.history = historyForCaller(status, admin);
          if (!admin) {
            delete clientView.historyHidden;
            delete clientView.historyHideReason;
            delete clientView.hiddenHistoryKeys;
          }
          if (!admin && (clientView.buildingMark === "no_report" || clientView.buildingMark === "test_scan")) {
            const reports = clientView.reports as Record<string, Record<string, unknown>> | undefined;
            if (reports) {
              for (const report of Object.values(reports)) {
                report.clientVisible = false;
                report.approvedKey = null;
              }
            }
          }
          return json(200, { ...clientView, admin });
        }
        if (method === "POST" && path === "/bff/portal/building") {
          assertMutationRequest(event, dependencies.portalOrigin, active.session.csrfTokenHash);
          const payload = JSON.parse(event.body ?? "{}") as Record<string, unknown>;
          const prefix = String(payload.prefix || "");
          const statusSnapshot = await loadPortalStatusVersion(prefix);
          const status = statusSnapshot.status;
          if (!(await ownsPrefix(organizationId, admin, prefix))) return json(404, { error: "not_found" });
          const action = String(payload.action || "");
          if (action === "approve" && admin) {
            const reportType = String(payload.reportType || "");
            const report = (status.reports as Record<string, Record<string, unknown>> | undefined)?.[reportType];
            if (!report?.awaitingClientAdmin) return json(400, { error: "invalid_request" });
            const source = String(report.sourceKey || report.approvedKey || "");
            if (!reportFileMatches(reportType, source)) return json(400, { error: "invalid_request" });
            report.clientVisible = true;
            report.awaitingClientAdmin = false;
            report.stale = false;
            status.released = true;
            rememberReport(status, reportType, report, false);
            if (reportType === "ASSESSMENT" || reportType === "EVIDENCE") {
              status.mapReady = true;
              const { CopyObjectCommand, PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
              const client = new S3Client({});
              const root = prefix.replace(/\/?$/, "/");
              const bucket = process.env.DATA_BUCKET_NAME;
              try {
                await client.send(new CopyObjectCommand({
                  Bucket: bucket,
                  Key: `${root}reportgen/client_portal/map/aerial.png`,
                  CopySource: `${bucket}/${root}reportgen/aerial/aerial.png`,
                }));
              } catch {
                status.mapReady = false;
              }
              await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: `${root}reportgen/client_portal/map/manifest.json`,
                Body: JSON.stringify({
                  aerial: `${root}reportgen/client_portal/map/aerial.png`,
                  moisture: `${root}reportgen/client_portal/map/moisture.png`,
                  anomalies: `${root}reportgen/client_portal/map/anomalies.geojson`,
                  filters: ["moisture", "anomalyType", "severity", "section"],
                }),
                ContentType: "application/json",
              }));
            }
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "notes" && admin) {
            status.pendingAdminEmail = {
              kind: "client-admin-notes",
              notes: String(payload.notes || ""),
              markStale: Boolean(payload.markStale),
              reportType: String(payload.reportType || ""),
            };
            if (payload.markStale) {
              const report = (status.reports as Record<string, Record<string, unknown>> | undefined)?.[String(payload.reportType || "")];
              if (report) {
                report.clientVisible = false;
                report.stale = true;
              }
            }
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "section-mark") {
            const marks = (status.marks && typeof status.marks === "object" ? status.marks : {}) as Record<string, string>;
            const sectionId = String(payload.sectionId || "");
            if (payload.mark) marks[sectionId] = String(payload.mark);
            else delete marks[sectionId];
            status.marks = marks;
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "hide-history" && admin) {
            const reason = String(payload.reason || "").trim();
            if (!reason) return json(400, { error: "invalid_request" });
            status.historyHidden = true;
            status.historyHideReason = reason;
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "restore-history" && admin) {
            status.historyHidden = false;
            status.historyHideReason = null;
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "hide-history-item" && admin) {
            const key = String(payload.key || "").trim();
            if (!key) return json(400, { error: "invalid_request" });
            const keys = hiddenHistoryKeys(status);
            if (!keys.includes(key)) keys.push(key);
            status.hiddenHistoryKeys = keys;
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "restore-history-item" && admin) {
            const key = String(payload.key || "").trim();
            if (!key) return json(400, { error: "invalid_request" });
            status.hiddenHistoryKeys = hiddenHistoryKeys(status).filter((item) => item !== key);
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "building-mark" && admin) {
            const mark = payload.mark ? String(payload.mark) : null;
            status.buildingMark = mark;
            if (mark === "no_report" || mark === "test_scan") {
              status.pendingAdminEmail = { kind: "building-mark", mark, buildingPrefix: prefix, sendBlocked: emailBlocked() };
            }
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (blockedBuilding(status)) return json(400, { error: "invalid_request" });
          if (action === "mark-stale" && admin) {
            const report = (status.reports as Record<string, Record<string, unknown>> | undefined)?.[String(payload.reportType || "")];
            if (!report) return json(400, { error: "invalid_request" });
            rememberReport(status, String(payload.reportType || ""), report, true);
            report.stale = true;
            report.clientVisible = false;
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "undo-stale" && admin) {
            const report = (status.reports as Record<string, Record<string, unknown>> | undefined)?.[String(payload.reportType || "")];
            if (!report?.stale) return json(400, { error: "invalid_request" });
            report.stale = false;
            if (report.approvedKey) report.clientVisible = true;
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "capital-plan") {
            if (String(prefix).split("/").includes("roof_takeoff")) return json(400, { error: "invalid_request" });
            const inputs = payload.inputs;
            if (!inputs || typeof inputs !== "object") return json(400, { error: "invalid_request" });
            const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
            await new S3Client({}).send(new PutObjectCommand({
              Bucket: process.env.DATA_BUCKET_NAME,
              Key: `${prefix.replace(/\/?$/, "/")}capital_plan.json`,
              Body: JSON.stringify({ ...(inputs as Record<string, unknown>), schema_version: 1 }),
              ContentType: "application/json",
            }));
            stampEdit(status, context.userId);
            if (!admin) {
              if (!visibleReport(status, "CAPITAL_PLAN")) return json(400, { error: "invalid_request" });
              markEditedReportsStale(status, "CAPITAL_PLAN");
            }
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "identity") {
            const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
            const current = await loadPortalStatus(prefix);
            const general = {
              displayName: String(payload.displayName || current.displayName || ""),
              address: String(payload.address || current.address || ""),
              engineers: String(payload.engineers || ""),
            };
            await new S3Client({}).send(new PutObjectCommand({
              Bucket: process.env.DATA_BUCKET_NAME,
              Key: `${prefix.replace(/\/?$/, "/")}general_data.json`,
              Body: JSON.stringify(general),
              ContentType: "application/json",
            }));
            Object.assign(status, general);
            stampEdit(status, context.userId);
            if (!admin) {
              if (!anyVisible(status)) return json(400, { error: "invalid_request" });
              markEditedReportsStale(status);
            }
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "reject-asbuilt" && admin) {
            const report = (status.reports as Record<string, Record<string, unknown>> | undefined)?.ROOF_TAKEOFF;
            if (report) {
              rememberReport(status, "ROOF_TAKEOFF", report, true);
              report.clientVisible = false;
              report.stale = true;
            }
            status.asBuiltRejected = true;
            status.pendingAdminEmail = { kind: "as-built-rejected", buildingPrefix: prefix };
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          if (action === "asbuilt-upload") {
            const ext = String(payload.ext || "png").replace(/[^a-z0-9]/gi, "") || "png";
            const key = `${prefix.replace(/\/?$/, "/")}reportgen/takeoff/asbuilt.${ext}`;
            return json(200, { url: await signedUpload(key, String(payload.contentType || "image/png")), key });
          }
          if (action === "takeoff-building" && (admin || organizationId)) {
            const org = String(payload.clientPrefix || "").replace(/^\/+|\/+$/g, "");
            if (!admin && !(await ownsPrefix(organizationId, false, org))) return json(403, { error: "forbidden" });
            const name = String(payload.displayName || "").trim();
            if (!org || !name) return json(400, { error: "invalid_request" });
            const date = new Date().toISOString().slice(0, 10);
            const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "building";
            const created = `${org}/roof_takeoff/${date}/${id}/`;
            status.buildingPrefix = created;
            const fresh: Record<string, unknown> = {
              displayName: name,
              address: String(payload.address || ""),
              roofTakeoffOnly: true,
              released: true,
              reports: {},
            };
            const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
            await new S3Client({}).send(new PutObjectCommand({
              Bucket: process.env.DATA_BUCKET_NAME,
              Key: `${created}general_data.json`,
              Body: JSON.stringify({ displayName: name, address: fresh.address }),
              ContentType: "application/json",
            }));
            await savePortalStatus(created, fresh, null);
            return json(200, { buildingPrefix: created });
          }
          if (action === "edit-visible") {
            const reportType = String(payload.reportType || "");
            const report = (status.reports as Record<string, Record<string, unknown>> | undefined)?.[reportType];
            if (!report?.clientVisible) return json(400, { error: "invalid_request" });
            report.clientVisible = false;
            report.stale = true;
            report.rerun = "pdf-only";
            status.pendingRerun = { reportType, mode: "pdf-only" };
            status.clientMessage = "Updating the report. The previous file stays available as stale.";
            await savePortalStatus(prefix, status, statusSnapshot.eTag);
            return json(200, { ok: true });
          }
          return json(400, { error: "invalid_request" });
        }
      }

      return json(404, { error: "not_found" });
    } catch (error) {
      return errorResponse(error, event);
    }
  };
}

function blockedBuilding(status: Record<string, unknown>): boolean {
  return status.buildingMark === "no_report" || status.buildingMark === "test_scan";
}

function visibleReport(status: Record<string, unknown>, reportType: string): boolean {
  const reports = status.reports as Record<string, { clientVisible?: boolean }> | undefined;
  if (reports?.[reportType]?.clientVisible) return true;
  return Object.values(reports ?? {}).some((report) => report.clientVisible);
}

function anyVisible(status: Record<string, unknown>): boolean {
  const reports = status.reports as Record<string, { clientVisible?: boolean }> | undefined;
  return Object.values(reports ?? {}).some((report) => report.clientVisible);
}

function stampEdit(status: Record<string, unknown>, userId: string): void {
  const edits = Array.isArray(status.edits) ? status.edits as object[] : [];
  edits.push({ userId, at: new Date().toISOString() });
  status.edits = edits.slice(-20);
}

function historyItemKey(item: Record<string, unknown>): string {
  return String(item.key || item.approvedKey || "");
}

function hiddenHistoryKeys(status: Record<string, unknown>): string[] {
  if (!Array.isArray(status.hiddenHistoryKeys)) return [];
  return status.hiddenHistoryKeys.map((key) => String(key)).filter(Boolean);
}

function currentReportKeys(status: Record<string, unknown>): Set<string> {
  const reports = status.reports && typeof status.reports === "object"
    ? status.reports as Record<string, Record<string, unknown>>
    : {};
  const keys = new Set<string>();
  for (const report of Object.values(reports)) {
    const key = String(report.approvedKey || "");
    if (key) keys.add(key);
  }
  return keys;
}

function assembledHistory(status: Record<string, unknown>): Array<Record<string, unknown>> {
  const stored = Array.isArray(status.history) ? status.history as Array<Record<string, unknown>> : [];
  const seen = new Set(stored.map(historyItemKey).filter(Boolean));
  const reports = status.reports && typeof status.reports === "object"
    ? status.reports as Record<string, Record<string, unknown>>
    : {};
  const extra: Array<Record<string, unknown>> = [];
  for (const [name, report] of Object.entries(reports)) {
    const key = String(report.approvedKey || "");
    if (report.stale && key && !seen.has(key)) {
      extra.push({
        reportType: name,
        key,
        stale: true,
        label: "Stale",
        generatedAt: report.generatedAt,
      });
    }
  }
  const hidden = new Set(hiddenHistoryKeys(status));
  return [...stored, ...extra].map((item) => ({
    ...item,
    hiddenFromClients: hidden.has(historyItemKey(item)),
  }));
}

function historyForCaller(status: Record<string, unknown>, admin: boolean): Array<Record<string, unknown>> {
  const history = assembledHistory(status);
  if (admin) return history;
  if (status.historyHidden) return [];
  return history
    .filter((item) => !item.hiddenFromClients)
    .map((item) => {
      const copy = { ...item };
      delete copy.hiddenFromClients;
      return copy;
    });
}

function clientMayOpenKey(status: Record<string, unknown>, key: string): boolean {
  if (currentReportKeys(status).has(key)) return true;
  const inHistory = assembledHistory(status).some((item) => historyItemKey(item) === key);
  if (!inHistory) return true;
  if (status.historyHidden) return false;
  return !hiddenHistoryKeys(status).includes(key);
}

function rememberReport(status: Record<string, unknown>, reportType: string, report: Record<string, unknown>, stale: boolean): void {
  const key = String(report.approvedKey || "");
  if (!key) return;
  const history = Array.isArray(status.history) ? status.history as Array<Record<string, unknown>> : [];
  history.push({
    reportType,
    key,
    label: stale ? "Stale" : "Approved",
    stale,
    at: new Date().toISOString(),
  });
  status.history = history;
}

function markEditedReportsStale(status: Record<string, unknown>, onlyType?: string): void {
  const reports = status.reports as Record<string, Record<string, unknown>> | undefined;
  if (!reports) return;
  const names = onlyType && reports[onlyType] ? [onlyType] : Object.keys(reports);
  for (const name of names) {
    const report = reports[name];
    if (!report) continue;
    if (!report.clientVisible) continue;
    rememberReport(status, name, report, true);
    report.clientVisible = false;
    report.stale = true;
    status.pendingRerun = { reportType: name, mode: "pdf-only", state: "queued" };
  }
  status.clientMessage = "Your edit marked the current file stale. It stays available until a new one is approved.";
}

let runtimeHandler: HttpHandler | undefined;

export const handler: HttpHandler = async (event) => {
  if (!runtimeHandler) {
    const config = clientRuntimeConfig();
    const artifactSignerFunctionName = process.env.ARTIFACT_SIGNER_FUNCTION_NAME;
    if (!artifactSignerFunctionName) throw new Error("Missing required environment variable ARTIFACT_SIGNER_FUNCTION_NAME");
    const store = new DynamoClientAuthStore(config);
    const cipher = new KmsTokenCipher(config.applicationKeyArn);
    const clientOauth = new CognitoClientOAuth(config);
    const adminIssuer = process.env.ADMIN_ISSUER;
    const adminClientId = process.env.ADMIN_APP_CLIENT_ID;
    const adminDomain = process.env.ADMIN_AUTH_DOMAIN;
    const adminOauth = adminIssuer && adminClientId && adminDomain
      ? new AdminPoolOAuth({
          issuer: adminIssuer,
          clientId: adminClientId,
          authDomain: adminDomain,
          callbackUrl: `${config.portalOrigin}/bff/auth/admin/callback`,
          logoutUrl: `${config.portalOrigin}/logged-out`,
        })
      : undefined;
    runtimeHandler = createClientBffHandler({
      portalOrigin: config.portalOrigin,
      service: new ClientAuthService(
        store,
        cipher,
        clientOauth,
        () => new Date(),
        adminOauth && adminIssuer ? { issuer: adminIssuer, oauth: adminOauth } : undefined,
      ),
      clientOauth,
      ...(adminOauth
        ? { adminService: new ClientAuthService(store, cipher, adminOauth), adminOauth }
        : {}),
      ...(adminIssuer ? { adminIssuer } : {}),
      ensureAdmin: (input) => store.ensurePortalAdmin(input),
      resources: new ClientResourceService({ ...config, artifactSignerFunctionName }),
    });
  }
  return runtimeHandler(event);
};
