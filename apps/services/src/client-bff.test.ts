import { describe, expect, it, vi } from "vitest";

import type { ClientIdentity, ClientSession } from "@bdr/contracts";
import { sha256 } from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import { createClientBffHandler } from "./client-bff";

const csrf = "csrf-token";
const identity: ClientIdentity = {
  issuer: "https://issuer.example.com/pool",
  sub: "subject",
  userId: "user_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  status: "ACTIVE",
};
const session: ClientSession = {
  sessionIdHash: sha256("session-id"),
  issuer: identity.issuer,
  sub: identity.sub,
  accessTokenCiphertext: "encrypted-access",
  refreshTokenCiphertext: "encrypted-refresh",
  accessTokenExpiresAt: "2026-09-13T14:15:00.000Z",
  csrfTokenHash: sha256(csrf),
  absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
  ttlExpiresAt: 1,
  revokedAt: null,
};

function event(method: string, rawPath: string, input: Partial<APIGatewayProxyEventV2> = {}) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers: {},
    requestContext: { requestId: "request", http: { method } },
    isBase64Encoded: false,
    ...input,
  } as unknown as APIGatewayProxyEventV2;
}

function service() {
  return {
    startLogin: vi.fn(async () => ({
      authorizationUrl: "https://auth.example.com/oauth2/authorize",
      state: "login-state",
    })),
    finishLogin: vi.fn(async () => ({
      rawSessionId: "session-id",
      csrfToken: csrf,
      session,
      identity,
      returnTo: "/projects",
    })),
    authenticate: vi.fn(async () => ({
      rawSessionId: "session-id",
      csrfToken: "",
      session,
      identity,
      returnTo: "/",
    })),
    logout: vi.fn(async () => "https://auth.example.com/logout"),
  };
}

describe("client BFF routes", () => {
  it("starts login with an HttpOnly host-only state cookie", async () => {
    const handler = createClientBffHandler({
      portalOrigin: "https://portal.example.com",
      service: service(),
    });
    const response = await handler(event("GET", "/bff/auth/login"));
    expect(response.statusCode).toBe(302);
    expect(response.cookies?.[0]).toContain("__Host-bdr_login=login-state");
    expect(response.cookies?.[0]).toContain("HttpOnly");
    expect(response.cookies?.[0]).toContain("Secure");
    expect(response.cookies?.[0]).not.toContain("Domain=");
  });

  it("sets opaque session and readable CSRF cookies after callback", async () => {
    const handler = createClientBffHandler({
      portalOrigin: "https://portal.example.com",
      service: service(),
    });
    const response = await handler(
      event("GET", "/bff/auth/callback", {
        cookies: ["__Host-bdr_login=login-state"],
        queryStringParameters: { code: "code", state: "login-state" },
      }),
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers?.location).toBe("/projects");
    expect(response.cookies?.join("\n")).toContain("__Host-bdr_client_session=session-id");
    expect(response.cookies?.join("\n")).toContain("__Host-bdr_csrf=csrf-token");
  });

  it("rejects logout from the wrong origin before local revocation", async () => {
    const operations = service();
    const handler = createClientBffHandler({
      portalOrigin: "https://portal.example.com",
      service: operations,
    });
    const response = await handler(
      event("POST", "/bff/logout", {
        headers: { origin: "https://evil.example.com", "x-bdr-csrf": csrf },
        cookies: [`__Host-bdr_client_session=session-id`, `__Host-bdr_csrf=${csrf}`],
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(operations.logout).not.toHaveBeenCalled();
  });

  it("requires same-origin CSRF before issuing a report access URL", async () => {
    const reportAccess = vi.fn(async () => ({ url: "https://reports.example.com/signed", expiresInSeconds: 300 }));
    const resources = {
      policy: { loadActiveClientContext: vi.fn(async () => ({ organization: { organizationId: identity.organizationId } })) },
      reportAccess,
    } as never;
    const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: service(), resources });
    const path = "/bff/projects/project_0123456789abcdef/inspections/inspection_0123456789abcdef/reports/ASSESSMENT/access";

    const denied = await handler(event("POST", path, {
      body: JSON.stringify({ disposition: "DOWNLOAD" }),
      headers: { origin: "https://evil.example.com", "x-bdr-csrf": csrf },
      cookies: [`__Host-bdr_client_session=session-id`, `__Host-bdr_csrf=${csrf}`],
    }));
    expect(denied.statusCode).toBe(403);
    expect(reportAccess).not.toHaveBeenCalled();

    const allowed = await handler(event("POST", path, {
      body: JSON.stringify({ disposition: "DOWNLOAD" }),
      headers: { origin: "https://portal.example.com", "x-bdr-csrf": csrf },
      cookies: [`__Host-bdr_client_session=session-id`, `__Host-bdr_csrf=${csrf}`],
    }));
    expect(allowed.statusCode).toBe(200);
    expect(reportAccess).toHaveBeenCalledWith(
      expect.anything(),
      "project_0123456789abcdef",
      "inspection_0123456789abcdef",
      "ASSESSMENT",
      "DOWNLOAD",
      "request",
    );
  });
});
