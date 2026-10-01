import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { ClientOAuth, ClientTokenSet, VerifiedClientTokens } from "./client";

export type AdminOAuthConfig = Readonly<{
  issuer: string;
  clientId: string;
  authDomain: string;
  callbackUrl: string;
  logoutUrl: string;
}>;

/** Public admin-pool app client. TOTP is required by the pool. */
export class AdminPoolOAuth implements ClientOAuth {
  private readonly jwks;

  constructor(private readonly config: AdminOAuthConfig) {
    this.jwks = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`));
  }

  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; loginHint?: string }): string {
    const url = new URL("/oauth2/authorize", this.config.authDomain);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      scope: "openid email",
      redirect_uri: this.config.callbackUrl,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      ...(input.loginHint ? { login_hint: input.loginHint } : {}),
      prompt: "login",
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<ClientTokenSet> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      code,
      code_verifier: codeVerifier,
    });
  }

  async refresh(refreshToken: string): Promise<ClientTokenSet> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      refresh_token: refreshToken,
    });
  }

  async revoke(refreshToken: string): Promise<void> {
    const response = await fetch(new URL("/oauth2/revoke", this.config.authDomain), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken, client_id: this.config.clientId }),
    });
    if (!response.ok) throw new Error(`Cognito token revocation failed with ${response.status}`);
  }

  logoutUrl(): string {
    const url = new URL("/logout", this.config.authDomain);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      logout_uri: this.config.logoutUrl,
    }).toString();
    return url.toString();
  }

  async verifyIssued(tokens: ClientTokenSet): Promise<VerifiedClientTokens> {
    if (!tokens.idToken) throw new Error("Cognito did not return an ID token");
    const access = await this.verifyAccessToken(tokens.accessToken);
    const { payload: id } = await jwtVerify(tokens.idToken, this.jwks, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
    });
    if (id.token_use !== "id" || id.sub !== access.sub) throw new Error("Cognito ID token claims are invalid");
    return { issuer: access.issuer, sub: access.sub, accessTokenExpiresAt: access.accessTokenExpiresAt };
  }

  async verifyInitial(tokens: ClientTokenSet, nonce: string): Promise<VerifiedClientTokens> {
    if (!tokens.idToken) throw new Error("Cognito did not return an ID token");
    const access = await this.verifyAccessToken(tokens.accessToken);
    const { payload: id } = await jwtVerify(tokens.idToken, this.jwks, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
    });
    if (id.token_use !== "id" || id.nonce !== nonce || id.sub !== access.sub) {
      throw new Error("Cognito ID token claims are invalid");
    }
    const memberOf = new Set([...groups(access.payload), ...groups(id)]);
    if (!memberOf.has("bdr-admins")) {
      console.warn(JSON.stringify({ error: "admin_group_claim_missing", claims: [...memberOf] }));
    }
    return { issuer: access.issuer, sub: access.sub, accessTokenExpiresAt: access.accessTokenExpiresAt };
  }

  async verifyRefresh(tokens: ClientTokenSet, expectedIssuer: string, expectedSub: string): Promise<VerifiedClientTokens> {
    const verified = await this.verifyAccessToken(tokens.accessToken);
    if (verified.issuer !== expectedIssuer || verified.sub !== expectedSub) {
      throw new Error("Refreshed token changed the authenticated subject");
    }
    if (!groups(verified.payload).includes("bdr-admins")) {
      throw new Error("Admin group required");
    }
    return { issuer: verified.issuer, sub: verified.sub, accessTokenExpiresAt: verified.accessTokenExpiresAt };
  }

  private async verifyAccessToken(token: string): Promise<VerifiedClientTokens & { payload: JWTPayload }> {
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.config.issuer });
    if (
      payload.token_use !== "access" ||
      payload.client_id !== this.config.clientId ||
      typeof payload.iss !== "string" ||
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number"
    ) {
      throw new Error("Cognito access token claims are invalid");
    }
    return {
      issuer: payload.iss,
      sub: payload.sub,
      accessTokenExpiresAt: new Date(payload.exp * 1000).toISOString(),
      payload,
    };
  }

  private async tokenRequest(parameters: Readonly<Record<string, string>>): Promise<ClientTokenSet> {
    const response = await fetch(new URL("/oauth2/token", this.config.authDomain), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });
    if (!response.ok) throw new Error(`Cognito token exchange failed with ${response.status}`);
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("access_token" in payload) ||
      typeof payload.access_token !== "string"
    ) {
      throw new Error("Cognito returned an invalid token response");
    }
    return {
      accessToken: payload.access_token,
      ...("refresh_token" in payload && typeof payload.refresh_token === "string"
        ? { refreshToken: payload.refresh_token }
        : {}),
      ...("id_token" in payload && typeof payload.id_token === "string"
        ? { idToken: payload.id_token }
        : {}),
    };
  }
}

function groups(payload: JWTPayload): string[] {
  const value = payload["cognito:groups"];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(" ");
  return [];
}
