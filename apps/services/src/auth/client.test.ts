import { describe, expect, it, vi } from "vitest";

import type {
  AdminInvitation,
  ClientIdentity,
  ClientSession,
  OAuthLoginTransaction,
  Organization,
} from "@bdr/contracts";
import { DomainError, sha256 } from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import {
  ClientAuthService,
  type ClientAuthStore,
  type ClientOAuth,
  type ClientTokenSet,
  type TokenCipher,
} from "./client";

const now = new Date("2026-09-13T14:00:00.000Z");
const identity: ClientIdentity = {
  issuer: "https://issuer.example.com/pool",
  sub: "client-subject",
  userId: "user_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  status: "ACTIVE",
};

class FakeStore implements ClientAuthStore {
  login: { state: string; transaction: OAuthLoginTransaction } | null = null;
  identity: ClientIdentity | null = identity;
  organizationActive = true;
  session: ClientSession | null = null;
  invitation: AdminInvitation | null = null;
  accepted = 0;
  consumed = 0;
  rotated = 0;
  revoked = 0;

  async createLogin(state: string, transaction: OAuthLoginTransaction) {
    this.login = { state, transaction };
  }
  async getLogin(state: string) {
    return this.login?.state === state ? this.login.transaction : null;
  }
  async getInvitation() {
    return this.invitation;
  }
  async acceptInvitation() {
    this.accepted += 1;
    if (this.identity) this.identity = { ...this.identity, status: "ACTIVE", invitationId: null };
  }
  async getClientIdentity() {
    return this.identity;
  }
  async getOrganization(): Promise<Organization | null> {
    return {
      organizationId: identity.organizationId,
      displayName: "Client Organization",
      status: this.organizationActive ? "ACTIVE" : "SUSPENDED",
    };
  }
  async consumeLoginAndCreateSession(input: { session: ClientSession }) {
    this.consumed += 1;
    this.session = input.session;
  }
  async getClientSession() {
    return this.session;
  }
  async rotateSession(input: { newSession: ClientSession }) {
    this.rotated += 1;
    this.session = input.newSession;
  }
  async revokeSession() {
    this.revoked += 1;
    if (this.session) this.session = { ...this.session, revokedAt: now.toISOString() };
  }
}

class FakeOAuth implements ClientOAuth {
  revoked = 0;
  refreshes = 0;
  failRevocation = false;
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }) {
    return `https://auth.example.com/oauth2/authorize?state=${input.state}&nonce=${input.nonce}&code_challenge=${input.codeChallenge}`;
  }
  async exchangeCode(): Promise<ClientTokenSet> {
    return { accessToken: "access", refreshToken: "refresh", idToken: "id" };
  }
  async refresh(): Promise<ClientTokenSet> {
    this.refreshes += 1;
    return { accessToken: "refreshed-access" };
  }
  async revoke() {
    this.revoked += 1;
    if (this.failRevocation) throw new Error("provider unavailable");
  }
  logoutUrl() {
    return "https://auth.example.com/logout";
  }
  async verifyInitial() {
    return { issuer: identity.issuer, sub: identity.sub, accessTokenExpiresAt: "2026-09-13T14:15:00.000Z" };
  }
  async verifyRefresh() {
    return { issuer: identity.issuer, sub: identity.sub, accessTokenExpiresAt: "2026-09-13T14:30:00.000Z" };
  }
}

const cipher: TokenCipher = {
  async encrypt(value) {
    return `encrypted:${value}`;
  },
  async decrypt(value) {
    return value.replace(/^encrypted:/, "");
  },
};

function event(sessionId: string): APIGatewayProxyEventV2 {
  return {
    cookies: [`__Host-bdr_client_session=${sessionId}`],
    headers: {},
    requestContext: { http: { method: "GET" } },
  } as APIGatewayProxyEventV2;
}

function service(store = new FakeStore(), oauth = new FakeOAuth()) {
  return {
    store,
    oauth,
    auth: new ClientAuthService(store, cipher, oauth, () => now),
  };
}

describe("client BFF authentication", () => {
  it("stores a one-use PKCE transaction and rejects unsafe return paths", async () => {
    const { auth, store } = service();
    const started = await auth.startLogin("//attacker.example.com");
    expect(started.authorizationUrl).toContain("code_challenge=");
    expect(store.login?.transaction).toMatchObject({
      stateHash: sha256(started.state),
      returnTo: "/",
      consumedAt: null,
    });
    expect(store.login?.transaction.pkceVerifierCiphertext).toMatch(/^encrypted:/);
  });

  it("binds the callback state to the browser and creates only an encrypted session", async () => {
    const { auth, store } = service();
    const started = await auth.startLogin("/projects");
    await expect(
      auth.finishLogin({ code: "code", state: started.state, loginCookie: "wrong", requestId: "request" }),
    ).rejects.toBeInstanceOf(DomainError);

    const established = await auth.finishLogin({
      code: "code",
      state: started.state,
      loginCookie: started.state,
      requestId: "request",
    });
    expect(established.returnTo).toBe("/projects");
    expect(established.session).toMatchObject({
      accessTokenCiphertext: "encrypted:access",
      refreshTokenCiphertext: "encrypted:refresh",
      absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
      revokedAt: null,
    });
    expect(store.consumed).toBe(1);
  });

  it("activates a matching unexpired invitation before issuing the first session", async () => {
    const { auth, store } = service();
    const invitationId = "invite_0123456789abcdef";
    store.identity = { ...identity, status: "INVITED", invitationId };
    store.invitation = {
      invitationId,
      organizationId: identity.organizationId,
      userId: identity.userId,
      email: "client@example.com",
      normalizedEmail: "client@example.com",
      status: "PENDING",
      absoluteExpiresAt: "2026-09-14T14:00:00.000Z",
      ttlExpiresAt: null,
      acceptedAt: null,
      cognitoUsername: "client_invite_0123456789abcdef",
      issuer: identity.issuer,
      sub: identity.sub,
      revision: "rev_0123456789abcdef",
    };
    const started = await auth.startLogin();
    await auth.finishLogin({ code: "code", state: started.state, loginCookie: started.state, requestId: "request" });
    expect(store.accepted).toBe(1);
    expect(store.consumed).toBe(1);
  });

  it("rechecks identity and organization before accepting or refreshing a session", async () => {
    const { auth, store, oauth } = service();
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code",
      state: started.state,
      loginCookie: started.state,
      requestId: "request",
    });
    store.session = {
      ...established.session,
      accessTokenExpiresAt: "2026-09-13T14:00:30.000Z",
    };
    await auth.authenticate(event(established.rawSessionId));
    expect(oauth.refreshes).toBe(1);
    expect(store.rotated).toBe(1);

    store.identity = { ...identity, status: "REVOKED" };
    await expect(auth.authenticate(event(established.rawSessionId))).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects a session immediately when its organization is suspended", async () => {
    const { auth, store } = service();
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code",
      state: started.state,
      loginCookie: started.state,
      requestId: "request",
    });
    store.organizationActive = false;
    await expect(auth.authenticate(event(established.rawSessionId))).rejects.toBeInstanceOf(DomainError);
  });

  it("keeps local logout authoritative when Cognito revocation fails", async () => {
    const { auth, store, oauth } = service();
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code",
      state: started.state,
      loginCookie: started.state,
      requestId: "request",
    });
    oauth.failRevocation = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(auth.logout(event(established.rawSessionId), "request")).resolves.toContain("/logout");
    expect(store.revoked).toBe(1);
    expect(oauth.revoked).toBe(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("cognito_refresh_token_revocation_failed"));
    warning.mockRestore();
  });
});
