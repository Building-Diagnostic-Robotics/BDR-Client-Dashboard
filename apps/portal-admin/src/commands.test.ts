import { describe, expect, it } from "vitest";

import { buildRequest } from "./commands";
import { authorizationRequest } from "./auth";

describe("portal-admin CLI", () => {
  it("builds a PKCE authorization-code request", () => {
    const url = authorizationRequest({ authDomain: "https://login.example.com", clientId: "client", callbackUrl: "http://127.0.0.1:4873/callback" }, "state", "verifier");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state");
  });

  it("requires exact confirmation for project archive", () => {
    expect(() => buildRequest(["projects", "archive", "--organization", "org_1234567890123456", "--project", "project_1234567890123456", "--revision", "rev_1234567890123456", "--reason", "duplicate", "--confirm", "wrong"])).toThrow(/exactly match/);
  });

  it("uses organization-scoped user routes", () => {
    expect(buildRequest(["users", "revoke", "--organization", "org_1234567890123456", "--user", "user_1234567890123456", "--revision", "rev_1234567890123456", "--confirm", "user_1234567890123456"])).toMatchObject({
      path: "/admin/organizations/org_1234567890123456/users/user_1234567890123456/revoke",
    });
  });

  it("exposes browser logout through the authenticated API", () => {
    expect(buildRequest(["auth", "logout"])).toEqual({ method: "DELETE", path: "/admin/auth/session" });
  });
});
