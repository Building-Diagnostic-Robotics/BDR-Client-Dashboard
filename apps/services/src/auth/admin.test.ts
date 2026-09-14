import { describe, expect, it } from "vitest";

import type { AdminIdentity, AdminProfile, AdminSession } from "@bdr/contracts";
import { DomainError } from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import {
  AdminAuthService,
  type AdminAuthConfig,
  type AdminAuthStore,
  type AdminCognitoVerifier,
  verifiedAdminTokenFromEvent,
} from "./admin";

const now = new Date("2026-09-13T14:00:00.000Z");
const config: AdminAuthConfig = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/admin-pool",
  clientId: "admin-client",
  authDomain: "https://admin-login.example.com",
  logoutUrl: "http://127.0.0.1:8765/logout",
};
const identity: AdminIdentity = {
  issuer: config.issuer,
  sub: "admin-subject",
  adminId: "admin_0123456789abcdef",
};
const profile: AdminProfile = {
  adminId: identity.adminId,
  status: "ACTIVE",
  role: "BDR_ADMIN",
  totpEnrolled: true,
};

function event(overrides: Record<string, unknown> = {}): APIGatewayProxyEventV2 {
  return {
    headers: { authorization: "Bearer access-token" },
    requestContext: {
      http: { method: "POST" },
      authorizer: {
        jwt: {
          claims: {
            iss: config.issuer,
            sub: identity.sub,
            client_id: config.clientId,
            token_use: "access",
            origin_jti: "origin-jti",
            scope: "openid email aws.cognito.signin.user.admin",
            "cognito:groups": "[\"bdr-admins\"]",
            exp: Math.floor(new Date("2026-09-13T14:15:00.000Z").getTime() / 1000),
            ...overrides,
          },
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2;
}

class FakeStore implements AdminAuthStore {
  identity: AdminIdentity | null = identity;
  profile: AdminProfile | null = profile;
  session: AdminSession | null = null;
  created = 0;
  revoked = 0;
  async getIdentity() { return this.identity; }
  async getProfile() { return this.profile; }
  async getSession() { return this.session; }
  async createSession(input: { session: AdminSession }) {
    this.created += 1;
    this.session = input.session;
  }
  async revokeSession() { this.revoked += 1; }
}

class FakeCognito implements AdminCognitoVerifier {
  calls = 0;
  rejects = false;
  async assertCurrentUser() {
    this.calls += 1;
    if (this.rejects) throw new Error("revoked");
  }
}

describe("administrator authorization", () => {
  it("validates issuer, app client, token type, scope, group, and expiration claims", () => {
    expect(verifiedAdminTokenFromEvent(event(), config, now)).toMatchObject({
      clientId: config.clientId,
      tokenUse: "access",
      groups: ["bdr-admins"],
    });
    expect(() => verifiedAdminTokenFromEvent(event({ client_id: "wrong" }), config, now)).toThrow(DomainError);
    expect(() => verifiedAdminTokenFromEvent(event({ exp: 1 }), config, now)).toThrow(DomainError);
  });

  it("accepts API Gateway bracketed and comma-separated Cognito group claims", () => {
    expect(
      verifiedAdminTokenFromEvent(event({ "cognito:groups": "[bdr-admins]" }), config, now)
        .groups,
    ).toEqual(["bdr-admins"]);
    expect(
      verifiedAdminTokenFromEvent(
        event({ "cognito:groups": "auditors,bdr-admins" }),
        config,
        now,
      ).groups,
    ).toEqual(["auditors", "bdr-admins"]);
  });

  it("denies session establishment outside the administrator group", async () => {
    const auth = new AdminAuthService(config, new FakeStore(), new FakeCognito(), () => now);
    await expect(
      auth.establish(event({ "cognito:groups": "[]" }), "request"),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("creates one eight-hour session only after Cognito and database checks", async () => {
    const store = new FakeStore();
    const cognito = new FakeCognito();
    const auth = new AdminAuthService(config, store, cognito, () => now);
    const active = await auth.establish(event(), "request");
    expect(active.session.absoluteExpiresAt).toBe("2026-09-13T22:00:00.000Z");
    expect(store.created).toBe(1);
    expect(cognito.calls).toBe(1);
    await auth.establish(event(), "request");
    expect(store.created).toBe(1);
  });

  it("rejects a Cognito-revoked token and stale database MFA state", async () => {
    const store = new FakeStore();
    const cognito = new FakeCognito();
    const auth = new AdminAuthService(config, store, cognito, () => now);
    cognito.rejects = true;
    await expect(auth.establish(event(), "request")).rejects.toBeInstanceOf(DomainError);

    cognito.rejects = false;
    store.profile = { ...profile, totpEnrolled: false };
    await expect(auth.establish(event(), "request")).rejects.toBeInstanceOf(DomainError);
  });

  it("revokes the local admin session before returning the Cognito logout URL", async () => {
    const store = new FakeStore();
    const auth = new AdminAuthService(config, store, new FakeCognito(), () => now);
    await auth.establish(event(), "request");
    await expect(auth.logout(event(), "request")).resolves.toContain("/logout?");
    expect(store.revoked).toBe(1);
  });
});
