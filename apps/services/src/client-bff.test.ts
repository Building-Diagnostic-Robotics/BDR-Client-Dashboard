import { describe, expect, it, vi } from "vitest";

import type { ClientIdentity, ClientSession } from "@bdr/contracts";
import { DomainError, sha256 } from "@bdr/domain";
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

  it("recovers a stale callback only through an independently verified existing session", async () => {
    const operations = service();
    operations.finishLogin.mockRejectedValue(new DomainError("AUTHENTICATION_REQUIRED", "stale callback"));
    const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: operations });
    const input = event("GET", "/bff/auth/callback", {
      cookies: ["__Host-bdr_client_session=session-id", "__Host-bdr_login=newer-login"],
      queryStringParameters: { code: "old-code", state: "old-state" },
    });
    const response = await handler(input);
    expect(operations.authenticate).toHaveBeenCalledWith(input);
    expect(response.statusCode).toBe(302);
    expect(response.headers?.location).toBe("/projects");
    expect(response.cookies).toBeUndefined();
    expect(operations.startLogin).not.toHaveBeenCalled();
  });

  it("returns rotated session cookies when recovery refreshes a valid existing session", async () => {
    const operations = service();
    operations.finishLogin.mockRejectedValue(new DomainError("AUTHENTICATION_REQUIRED", "stale callback"));
    operations.authenticate.mockResolvedValue({
      rawSessionId: "rotated-session", csrfToken: "rotated-csrf", session, identity, returnTo: "/",
    });
    const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: operations });
    const response = await handler(event("GET", "/bff/auth/callback"));
    expect(response.statusCode).toBe(302);
    expect(response.cookies?.join("\n")).toContain("__Host-bdr_client_session=rotated-session");
    expect(response.cookies?.join("\n")).toContain("__Host-bdr_csrf=rotated-csrf");
    expect(response.cookies?.join("\n")).not.toContain("Max-Age=0");
    expect(response.cookies?.join("\n")).not.toContain("__Host-bdr_login");
  });

  it.each(["AUTHENTICATION_REQUIRED", "FORBIDDEN"] as const)(
    "offers manual retry without redirect loops or cookie deletion when recovery returns %s",
    async (code) => {
      const operations = service();
      operations.finishLogin.mockRejectedValue(new DomainError("AUTHENTICATION_REQUIRED", "stale callback"));
      operations.authenticate.mockRejectedValue(new DomainError(code, "invalid existing session"));
      const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: operations });
      const response = await handler(event("GET", "/bff/auth/callback", {
        queryStringParameters: { code: "private-code", state: "private-state", returnTo: "https://evil.example.com" },
      }));
      expect(response.statusCode).toBe(401);
      expect(response.headers?.["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(response.headers?.["x-request-id"]).toBe("request");
      expect(response.headers?.location).toBeUndefined();
      expect(response.cookies).toBeUndefined();
      expect(response.body).toContain("Please sign in again");
      expect(response.body).toContain("/bff/auth/login?returnTo=%2Fprojects");
      expect(response.body).not.toContain("private-code");
      expect(response.body).not.toContain("private-state");
      expect(response.body).not.toContain("evil.example.com");
      expect(operations.startLogin).not.toHaveBeenCalled();
    },
  );

  it("recovers a Cognito error callback without accepting its identity or exchanging its code", async () => {
    const operations = service();
    const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: operations });
    const response = await handler(event("GET", "/bff/auth/callback", {
      queryStringParameters: { error: "access_denied" },
    }));
    expect(response.statusCode).toBe(302);
    expect(response.headers?.location).toBe("/projects");
    expect(response.cookies).toBeUndefined();
    expect(operations.finishLogin).not.toHaveBeenCalled();
    expect(operations.authenticate).toHaveBeenCalledOnce();
  });

  it("does not recover an unauthorized new identity using the previous account", async () => {
    const operations = service();
    operations.finishLogin.mockRejectedValue(new DomainError("FORBIDDEN", "revoked user"));
    const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: operations });
    const response = await handler(event("GET", "/bff/auth/callback"));
    expect(response.statusCode).toBe(403);
    expect(response.cookies).toBeUndefined();
    expect(operations.authenticate).not.toHaveBeenCalled();
  });

  it("fails closed on infrastructure errors during recovery", async () => {
    const operations = service();
    operations.finishLogin.mockRejectedValue(new DomainError("AUTHENTICATION_REQUIRED", "stale callback"));
    operations.authenticate.mockRejectedValue(new Error("database unavailable"));
    const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: operations });
    const response = await handler(event("GET", "/bff/auth/callback"));
    expect(response.statusCode).toBe(500);
    expect(response.headers?.location).toBeUndefined();
    expect(response.cookies).toBeUndefined();
    expect(response.body).not.toContain("database unavailable");
  });

  it("clears session cookies after authorized logout and still rejects expired API sessions", async () => {
    const operations = service();
    const handler = createClientBffHandler({ portalOrigin: "https://portal.example.com", service: operations });
    const logout = await handler(event("POST", "/bff/logout", {
      headers: { origin: "https://portal.example.com", "x-bdr-csrf": csrf },
      cookies: ["__Host-bdr_client_session=session-id", `__Host-bdr_csrf=${csrf}`],
    }));
    expect(logout.statusCode).toBe(200);
    expect(operations.logout).toHaveBeenCalledOnce();
    expect(logout.cookies).toHaveLength(3);
    expect(logout.cookies?.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    operations.authenticate.mockRejectedValue(new DomainError("AUTHENTICATION_REQUIRED", "expired session"));
    const denied = await handler(event("GET", "/bff/auth/session"));
    expect(denied.statusCode).toBe(401);
    expect(denied.cookies?.join("\n")).toContain("Max-Age=0");
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

  it("serves client-safe identity metadata from the authenticated context", async () => {
    const me = vi.fn(() => ({ organization: { displayName: "Midland Holdings" } }));
    const resources = {
      policy: {
        loadActiveClientContext: vi.fn(async () => ({
          userId: identity.userId,
          organization: {
            organizationId: identity.organizationId,
            displayName: "Midland Holdings",
            status: "ACTIVE",
          },
        })),
      },
      me,
    } as never;
    const handler = createClientBffHandler({
      portalOrigin: "https://portal.example.com",
      service: service(),
      resources,
    });

    const response = await handler(event("GET", "/bff/me"));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "{}")).toEqual({
      organization: { displayName: "Midland Holdings" },
    });
    expect(response.body).not.toContain(identity.userId);
    expect(response.body).not.toContain(identity.organizationId);
  });
});
