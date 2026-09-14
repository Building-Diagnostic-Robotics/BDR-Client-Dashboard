import type {
  AdminIdentity,
  AdminProfile,
  AdminSession,
  VerifiedAdminToken,
} from "@bdr/contracts";
import {
  assertActiveAdminAuthorization,
  authenticationRequired,
  forbidden,
  sessionExpiresAt,
  sha256,
} from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import { bearerToken } from "./primitives";

const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

type JwtClaims = Readonly<Record<string, unknown>>;

export type AdminAuthConfig = Readonly<{
  issuer: string;
  clientId: string;
  authDomain: string;
  logoutUrl: string;
}>;

export interface AdminAuthStore {
  getIdentity(issuer: string, sub: string): Promise<AdminIdentity | null>;
  getProfile(adminId: string): Promise<AdminProfile | null>;
  getSession(originJti: string): Promise<AdminSession | null>;
  createSession(input: {
    originJti: string;
    identity: AdminIdentity;
    profile: AdminProfile;
    session: AdminSession;
    requestId: string;
  }): Promise<void>;
  revokeSession(input: {
    originJti: string;
    adminId: string;
    revokedAt: string;
    requestId: string;
  }): Promise<void>;
}

export interface AdminCognitoVerifier {
  assertCurrentUser(input: { accessToken: string; expectedSub: string }): Promise<void>;
}

function claimString(claims: JwtClaims, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || !value) authenticationRequired();
  return value;
}

function groups(claims: JwtClaims): string[] {
  const value = claims["cognito:groups"];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      // API Gateway can serialize array claims as an unquoted bracketed list.
    }
    const serialized = trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
    return serialized
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return [];
}

function scopes(claims: JwtClaims): string[] {
  return claimString(claims, "scope").split(" ").filter(Boolean);
}

export function verifiedAdminTokenFromEvent(
  event: APIGatewayProxyEventV2,
  config: AdminAuthConfig,
  now: Date,
): VerifiedAdminToken {
  const context = event.requestContext as typeof event.requestContext & {
    authorizer?: { jwt?: { claims?: JwtClaims } };
  };
  const claims = context.authorizer?.jwt?.claims;
  if (!claims) authenticationRequired();
  const issuer = claimString(claims, "iss");
  const clientId = claimString(claims, "client_id");
  const tokenUse = claimString(claims, "token_use");
  const expValue = claims.exp;
  const exp = typeof expValue === "number" ? expValue : Number(expValue);
  const tokenScopes = scopes(claims);
  if (
    issuer !== config.issuer ||
    clientId !== config.clientId ||
    tokenUse !== "access" ||
    !Number.isSafeInteger(exp) ||
    exp * 1000 <= now.getTime() ||
    !tokenScopes.includes("openid") ||
    !tokenScopes.includes("aws.cognito.signin.user.admin")
  ) {
    authenticationRequired();
  }
  return {
    issuer,
    sub: claimString(claims, "sub"),
    clientId,
    originJti: claimString(claims, "origin_jti"),
    tokenUse: "access",
    groups: groups(claims),
    scopes: tokenScopes,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export type ActiveAdmin = Readonly<{
  token: VerifiedAdminToken;
  session: AdminSession;
  identity: AdminIdentity;
  profile: AdminProfile;
}>;

export class AdminAuthService {
  constructor(
    private readonly config: AdminAuthConfig,
    private readonly store: AdminAuthStore,
    private readonly cognito: AdminCognitoVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async establish(event: APIGatewayProxyEventV2, requestId: string): Promise<ActiveAdmin> {
    const now = this.now();
    const token = verifiedAdminTokenFromEvent(event, this.config, now);
    if (!token.groups.includes("bdr-admins")) forbidden();
    await this.assertCurrentCognitoUser(event, token.sub);
    const identity = await this.store.getIdentity(token.issuer, token.sub);
    if (!identity || identity.issuer !== token.issuer || identity.sub !== token.sub) forbidden();
    const profile = await this.store.getProfile(identity.adminId);
    if (!profile || profile.status !== "ACTIVE" || profile.role !== "BDR_ADMIN" || !profile.totpEnrolled) {
      forbidden();
    }
    const existing = await this.store.getSession(token.originJti);
    if (existing) {
      assertActiveAdminAuthorization({ token, session: existing, identity, profile, now });
      return { token, session: existing, identity, profile };
    }
    const absoluteExpiresAt = sessionExpiresAt(now, ADMIN_SESSION_MS);
    const session: AdminSession = {
      originJtiHash: sha256(token.originJti),
      adminId: profile.adminId,
      absoluteExpiresAt,
      ttlExpiresAt: Math.ceil(Date.parse(absoluteExpiresAt) / 1000),
      revokedAt: null,
    };
    try {
      await this.store.createSession({
        originJti: token.originJti,
        identity,
        profile,
        session,
        requestId,
      });
      return { token, session, identity, profile };
    } catch (error) {
      const racedSession = await this.store.getSession(token.originJti);
      if (!racedSession) throw error;
      assertActiveAdminAuthorization({ token, session: racedSession, identity, profile, now });
      return { token, session: racedSession, identity, profile };
    }
  }

  async authenticate(event: APIGatewayProxyEventV2): Promise<ActiveAdmin> {
    const now = this.now();
    const token = verifiedAdminTokenFromEvent(event, this.config, now);
    await this.assertCurrentCognitoUser(event, token.sub);
    const session = await this.store.getSession(token.originJti);
    const identity = await this.store.getIdentity(token.issuer, token.sub);
    const profile = identity ? await this.store.getProfile(identity.adminId) : null;
    const input = { token, session, identity, profile, now };
    assertActiveAdminAuthorization(input);
    return input;
  }

  async logout(event: APIGatewayProxyEventV2, requestId: string): Promise<string> {
    const active = await this.authenticate(event);
    await this.store.revokeSession({
      originJti: active.token.originJti,
      adminId: active.profile.adminId,
      revokedAt: this.now().toISOString(),
      requestId,
    });
    const url = new URL("/logout", this.config.authDomain);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      logout_uri: this.config.logoutUrl,
    }).toString();
    return url.toString();
  }

  private async assertCurrentCognitoUser(
    event: APIGatewayProxyEventV2,
    expectedSub: string,
  ): Promise<void> {
    try {
      await this.cognito.assertCurrentUser({
        accessToken: bearerToken(event),
        expectedSub,
      });
    } catch {
      authenticationRequired();
    }
  }
}
