import { createHash } from "node:crypto";

import type {
  AdminInvitation,
  ClientIdentity,
  ClientSession,
  OAuthLoginTransaction,
} from "@bdr/contracts";
import {
  authenticationRequired,
  forbidden,
  identityKeys,
  loadActiveClientAuthentication,
  sha256,
  assertInvitationCanBeAccepted,
  tenantKeys,
  type ClientContextRepository,
} from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import { cookies } from "../shared/http";
import {
  CLIENT_LOGIN_COOKIE,
  CLIENT_SESSION_COOKIE,
  equalSecrets,
  randomToken,
  safeReturnTo,
  sha256Base64Url,
} from "./primitives";

const LOGIN_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 60 * 1000;

export type ClientTokenSet = Readonly<{
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}>;

export type VerifiedClientTokens = Readonly<{
  issuer: string;
  sub: string;
  accessTokenExpiresAt: string;
}>;

export interface ClientAuthStore extends ClientContextRepository {
  createLogin(state: string, transaction: OAuthLoginTransaction): Promise<void>;
  getLogin(state: string): Promise<OAuthLoginTransaction | null>;
  getInvitation(organizationId: string, invitationId: string): Promise<AdminInvitation | null>;
  acceptInvitation(input: {
    identity: ClientIdentity;
    invitation: AdminInvitation;
    acceptedAt: string;
    requestId: string;
  }): Promise<void>;
  consumeLoginAndCreateSession(input: {
    state: string;
    now: string;
    rawSessionId: string;
    session: ClientSession;
    identity: ClientIdentity;
    requestId: string;
  }): Promise<void>;
  rotateSession(input: {
    oldRawSessionId: string;
    oldSession: ClientSession;
    newRawSessionId: string;
    newSession: ClientSession;
    revokedAt: string;
  }): Promise<void>;
  revokeSession(input: {
    rawSessionId: string;
    session: ClientSession;
    revokedAt: string;
    requestId: string;
  }): Promise<void>;
}

export interface TokenCipher {
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}

export interface ClientOAuth {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<ClientTokenSet>;
  refresh(refreshToken: string): Promise<ClientTokenSet>;
  revoke(refreshToken: string): Promise<void>;
  logoutUrl(): string;
  verifyInitial(tokens: ClientTokenSet, nonce: string): Promise<VerifiedClientTokens>;
  verifyRefresh(tokens: ClientTokenSet, expectedIssuer: string, expectedSub: string): Promise<VerifiedClientTokens>;
}

export type StartedLogin = Readonly<{ authorizationUrl: string; state: string }>;
export type EstablishedClientSession = Readonly<{
  rawSessionId: string;
  csrfToken: string;
  session: ClientSession;
  identity: ClientIdentity;
  returnTo: string;
}>;

function expiresAt(now: Date, duration: number): string {
  return new Date(now.getTime() + duration).toISOString();
}

function ttl(absoluteExpiresAt: string): number {
  return Math.ceil(Date.parse(absoluteExpiresAt) / 1000);
}

function rejectLogin(requestId: string, reason: string): never {
  console.warn(JSON.stringify({
    requestId,
    error: "client_login_rejected",
    reason,
  }));
  authenticationRequired();
}

export class ClientAuthService {
  constructor(
    private readonly store: ClientAuthStore,
    private readonly cipher: TokenCipher,
    private readonly oauth: ClientOAuth,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startLogin(returnToInput?: string): Promise<StartedLogin> {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const absoluteExpiresAt = expiresAt(this.now(), LOGIN_LIFETIME_MS);
    await this.store.createLogin(state, {
      stateHash: sha256(state),
      pkceVerifierCiphertext: await this.cipher.encrypt(verifier),
      nonce,
      returnTo: safeReturnTo(returnToInput),
      absoluteExpiresAt,
      ttlExpiresAt: ttl(absoluteExpiresAt),
      consumedAt: null,
    });
    return {
      state,
      authorizationUrl: this.oauth.authorizationUrl({
        state,
        nonce,
        codeChallenge: sha256Base64Url(verifier),
      }),
    };
  }

  async finishLogin(input: {
    code: string | undefined;
    state: string | undefined;
    loginCookie: string | undefined;
    requestId: string;
  }): Promise<EstablishedClientSession> {
    if (!input.code) rejectLogin(input.requestId, "authorization_code_missing");
    if (!input.state) rejectLogin(input.requestId, "oauth_state_missing");
    if (!input.loginCookie) rejectLogin(input.requestId, "login_cookie_missing");
    if (!equalSecrets(input.state, input.loginCookie)) rejectLogin(input.requestId, "login_cookie_mismatch");
    const login = await this.store.getLogin(input.state);
    const now = this.now();
    if (!login) rejectLogin(input.requestId, "login_transaction_missing");
    if (login.stateHash !== sha256(input.state)) rejectLogin(input.requestId, "login_transaction_state_mismatch");
    if (login.consumedAt !== null) rejectLogin(input.requestId, "login_transaction_consumed");
    if (Date.parse(login.absoluteExpiresAt) <= now.getTime()) rejectLogin(input.requestId, "login_transaction_expired");
    let tokens: ClientTokenSet;
    let verified: VerifiedClientTokens;
    let tokenStage = "pkce_decryption";
    try {
      const verifier = await this.cipher.decrypt(login.pkceVerifierCiphertext);
      tokenStage = "code_exchange";
      tokens = await this.oauth.exchangeCode(input.code, verifier);
      tokenStage = "token_response_incomplete";
      if (!tokens.refreshToken || !tokens.idToken) authenticationRequired();
      tokenStage = "token_verification";
      verified = await this.oauth.verifyInitial(tokens, login.nonce);
    } catch {
      rejectLogin(input.requestId, tokenStage);
    }
    let identity = await this.store.getClientIdentity(
      identityKeys.subject(verified.issuer, verified.sub),
      { consistentRead: true },
    );
    if (!identity || identity.issuer !== verified.issuer || identity.sub !== verified.sub) {
      forbidden();
    }
    if (identity.status === "INVITED" && identity.invitationId) {
      const invitation = await this.store.getInvitation(identity.organizationId, identity.invitationId);
      if (!invitation || invitation.sub !== identity.sub || invitation.userId !== identity.userId) forbidden();
      assertInvitationCanBeAccepted(invitation, now);
      await this.store.acceptInvitation({
        identity,
        invitation,
        acceptedAt: now.toISOString(),
        requestId: input.requestId,
      });
      identity = { ...identity, status: "ACTIVE", invitationId: null };
    }
    if (identity.status !== "ACTIVE") forbidden();
    const organization = await this.store.getOrganization(
      tenantKeys.organization(identity.organizationId),
      { consistentRead: true },
    );
    if (!organization || organization.organizationId !== identity.organizationId || organization.status !== "ACTIVE") {
      forbidden();
    }

    const rawSessionId = randomToken(48);
    const csrfToken = randomToken();
    const absoluteExpiresAt = expiresAt(now, SESSION_LIFETIME_MS);
    const session: ClientSession = {
      sessionIdHash: sha256(rawSessionId),
      issuer: verified.issuer,
      sub: verified.sub,
      accessTokenCiphertext: await this.cipher.encrypt(tokens.accessToken),
      refreshTokenCiphertext: await this.cipher.encrypt(tokens.refreshToken),
      accessTokenExpiresAt: verified.accessTokenExpiresAt,
      csrfTokenHash: createHash("sha256").update(csrfToken).digest("hex"),
      absoluteExpiresAt,
      ttlExpiresAt: ttl(absoluteExpiresAt),
      revokedAt: null,
    };
    await this.store.consumeLoginAndCreateSession({
      state: input.state,
      now: now.toISOString(),
      rawSessionId,
      session,
      identity,
      requestId: input.requestId,
    });
    return { rawSessionId, csrfToken, session, identity, returnTo: login.returnTo };
  }

  async authenticate(
    event: APIGatewayProxyEventV2,
    allowRefresh = true,
  ): Promise<EstablishedClientSession> {
    const rawSessionId = cookies(event)[CLIENT_SESSION_COOKIE];
    if (!rawSessionId) authenticationRequired();
    const now = this.now();
    const { session, identity } = await loadActiveClientAuthentication(this.store, {
      rawSessionId,
      now,
    });

    if (!allowRefresh || Date.parse(session.accessTokenExpiresAt) > now.getTime() + REFRESH_WINDOW_MS) {
      return { rawSessionId, csrfToken: "", session, identity, returnTo: "/" };
    }

    let refreshed: ClientTokenSet;
    let verified: VerifiedClientTokens;
    try {
      const refreshToken = await this.cipher.decrypt(session.refreshTokenCiphertext);
      refreshed = await this.oauth.refresh(refreshToken);
      verified = await this.oauth.verifyRefresh(refreshed, session.issuer, session.sub);
    } catch {
      authenticationRequired();
    }
    const newRawSessionId = randomToken(48);
    const newCsrfToken = randomToken();
    const newSession: ClientSession = {
      ...session,
      sessionIdHash: sha256(newRawSessionId),
      accessTokenCiphertext: await this.cipher.encrypt(refreshed.accessToken),
      refreshTokenCiphertext: refreshed.refreshToken
        ? await this.cipher.encrypt(refreshed.refreshToken)
        : session.refreshTokenCiphertext,
      accessTokenExpiresAt: verified.accessTokenExpiresAt,
      csrfTokenHash: createHash("sha256").update(newCsrfToken).digest("hex"),
      revokedAt: null,
    };
    await this.store.rotateSession({
      oldRawSessionId: rawSessionId,
      oldSession: session,
      newRawSessionId,
      newSession,
      revokedAt: now.toISOString(),
    });
    return {
      rawSessionId: newRawSessionId,
      csrfToken: newCsrfToken,
      session: newSession,
      identity,
      returnTo: "/",
    };
  }

  async logout(event: APIGatewayProxyEventV2, requestId: string): Promise<string> {
    const rawSessionId = cookies(event)[CLIENT_SESSION_COOKIE];
    if (!rawSessionId) return this.oauth.logoutUrl();
    const { session } = await loadActiveClientAuthentication(this.store, {
      rawSessionId,
      now: this.now(),
    });
    await this.store.revokeSession({
      rawSessionId,
      session,
      revokedAt: this.now().toISOString(),
      requestId,
    });
    try {
      await this.oauth.revoke(await this.cipher.decrypt(session.refreshTokenCiphertext));
    } catch {
      console.warn(
        JSON.stringify({
          requestId,
          event: "cognito_refresh_token_revocation_failed",
        }),
      );
    }
    return this.oauth.logoutUrl();
  }
}

export function loginCookie(event: APIGatewayProxyEventV2): string | undefined {
  return cookies(event)[CLIENT_LOGIN_COOKIE];
}

export function query(event: APIGatewayProxyEventV2, name: string): string | undefined {
  return event.queryStringParameters?.[name];
}
