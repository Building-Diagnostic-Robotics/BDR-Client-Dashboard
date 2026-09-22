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
    if (this.login) {
      this.login = { ...this.login, transaction: { ...this.login.transaction, consumedAt: now.toISOString() } };
    }
  }
  async getClientSession() {
    return this.session;
  }
  async rotateSession(input: { newSession: ClientSession }) {
    this.rotated += 1;
    this.session = input.newSession;
  }
  touched = 0;
  touchOverride: ((input: { rawSessionId: string; session: ClientSession; newLastActivityAt: string }) => Promise<boolean>) | null = null;
  async touchSessionActivity(input: { rawSessionId: string; session: ClientSession; newLastActivityAt: string }) {
    this.touched += 1;
    if (this.touchOverride) return this.touchOverride(input);
    if (!this.session || this.session.revokedAt !== null ||
      Date.parse(this.session.lastActivityAt) > Date.parse(input.newLastActivityAt)) return false;
    this.session = { ...this.session, lastActivityAt: input.newLastActivityAt };
    return true;
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

function service(store = new FakeStore(), oauth = new FakeOAuth(), currentTime = now) {
  return {
    store,
    oauth,
    auth: new ClientAuthService(store, cipher, oauth, () => currentTime),
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
      absoluteExpiresAt: "2026-09-13T22:00:00.000Z",
      revokedAt: null,
      lastActivityAt: "2026-09-13T14:00:00.000Z",
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

  it.each(["missing_cookie", "mismatched_cookie", "missing_transaction", "expired_transaction", "consumed_transaction"])(
    "rejects %s before exchanging a code or creating a session",
    async (failure) => {
      const { auth, store, oauth } = service();
      const started = await auth.startLogin("/projects");
      const exchange = vi.spyOn(oauth, "exchangeCode");
      if (failure === "missing_transaction") store.login = null;
      if (failure === "expired_transaction" && store.login) {
        store.login.transaction = { ...store.login.transaction, absoluteExpiresAt: now.toISOString() };
      }
      if (failure === "consumed_transaction" && store.login) {
        store.login.transaction = { ...store.login.transaction, consumedAt: now.toISOString() };
      }
      await expect(auth.finishLogin({
        code: "code", state: started.state,
        loginCookie: failure === "missing_cookie" ? undefined : failure === "mismatched_cookie" ? "wrong" : started.state,
        requestId: "request",
      })).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
      expect(exchange).not.toHaveBeenCalled();
      expect(store.consumed).toBe(0);
      expect(store.session).toBeNull();
    },
  );

  it("rejects a replayed successful login even if its original cookie is supplied", async () => {
    const { auth, store, oauth } = service();
    const started = await auth.startLogin("/projects");
    const exchange = vi.spyOn(oauth, "exchangeCode");
    const callback = { code: "code", state: started.state, loginCookie: started.state, requestId: "request" };
    const established = await auth.finishLogin(callback);
    await expect(auth.finishLogin(callback)).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(exchange).toHaveBeenCalledOnce();
    expect(store.consumed).toBe(1);
    expect(store.session).toEqual(established.session);
  });

  it.each(["expired", "revoked"])("denies an %s dashboard session despite its browser cookie", async (failure) => {
    const { auth, store, oauth } = service();
    const started = await auth.startLogin("/projects");
    const established = await auth.finishLogin({ code: "code", state: started.state, loginCookie: started.state, requestId: "request" });
    store.session = {
      ...established.session,
      ...(failure === "expired" ? { absoluteExpiresAt: now.toISOString() } : { revokedAt: now.toISOString() }),
    };
    await expect(auth.authenticate(event(established.rawSessionId))).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(oauth.refreshes).toBe(0);
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
    await expect(auth.authenticate(event(established.rawSessionId))).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("cognito_refresh_token_revocation_failed"));
    warning.mockRestore();
  });

  it("denies authentication when the session has been idle for more than 30 minutes", async () => {
    const { auth, store } = service();
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code",
      state: started.state,
      loginCookie: started.state,
      requestId: "request",
    });
    // Set lastActivityAt to 31 minutes before `now`
    store.session = {
      ...established.session,
      lastActivityAt: new Date(now.getTime() - 31 * 60 * 1000).toISOString(),
    };
    await expect(auth.authenticate(event(established.rawSessionId))).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("records activity before every successful non-refresh request", async () => {
    const { auth, store } = service();
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code",
      state: started.state,
      loginCookie: started.state,
      requestId: "request",
    });
    // Even a request two minutes after the last activity must extend the idle window.
    store.session = {
      ...established.session,
      lastActivityAt: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
    };
    await auth.authenticate(event(established.rawSessionId));
    expect(store.touched).toBe(1);
    expect(store.session?.lastActivityAt).toBe(now.toISOString());
  });

  it("does not report success when the activity write fails", async () => {
    const { auth, store } = service();
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code",
      state: started.state,
      loginCookie: started.state,
      requestId: "request",
    });
    store.touchOverride = async () => { throw new Error("DynamoDB unavailable"); };
    await expect(auth.authenticate(event(established.rawSessionId))).rejects.toThrow("DynamoDB unavailable");
    expect(store.touched).toBe(1);
  });

  it("allows a concurrent newer touch but denies a revoked session", async () => {
    const { auth, store } = service();
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code", state: started.state, loginCookie: started.state, requestId: "request",
    });
    store.touchOverride = async () => {
      store.session = { ...established.session, lastActivityAt: new Date(now.getTime() + 1_000).toISOString() };
      return false;
    };
    await expect(auth.authenticate(event(established.rawSessionId))).resolves.toMatchObject({
      rawSessionId: established.rawSessionId,
    });

    store.session = established.session;
    store.touchOverride = async () => {
      store.session = { ...established.session, revokedAt: now.toISOString() };
      return false;
    };
    await expect(auth.authenticate(event(established.rawSessionId))).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("extends idle access on activity while preserving the eight-hour limit", async () => {
    const store = new FakeStore();
    const { auth } = service(store);
    const started = await auth.startLogin();
    const established = await auth.finishLogin({
      code: "code", state: started.state, loginCookie: started.state, requestId: "request",
    });
    store.session = { ...established.session, accessTokenExpiresAt: "2026-09-13T23:00:00.000Z" };
    await service(store, new FakeOAuth(), new Date("2026-09-13T14:29:00.000Z")).auth.authenticate(event(established.rawSessionId));
    expect(store.session?.lastActivityAt).toBe("2026-09-13T14:29:00.000Z");
    await service(store, new FakeOAuth(), new Date("2026-09-13T14:58:00.000Z")).auth.authenticate(event(established.rawSessionId));
    expect(store.session?.lastActivityAt).toBe("2026-09-13T14:58:00.000Z");
    await expect(service(store, new FakeOAuth(), new Date("2026-09-13T22:00:00.000Z")).auth.authenticate(event(established.rawSessionId)))
      .rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
});
