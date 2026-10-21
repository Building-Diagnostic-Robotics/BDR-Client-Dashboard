import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  adminInvitationSchema,
  clientIdentitySchema,
  clientUserSchema,
  clientSessionSchema,
  oauthLoginTransactionSchema,
  organizationSchema,
  type ClientIdentity,
  type AdminInvitation,
  type ClientSession,
  type Organization,
  type OAuthLoginTransaction,
} from "@bdr/contracts";
import { CLIENT_INACTIVITY_TIMEOUT_MS, adminControlKeys, auditExpiresAt, auditKeys, identityKeys, sessionKeys, sha256, tenantKeys, type ConsistentRead, type DynamoKey } from "@bdr/domain";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { AdministratorDirectory, ADMIN_DASHBOARD_ORGANIZATION } from "./admin-directory";

import type {
  ClientAuthStore,
  ClientOAuth,
  ClientTokenSet,
  TokenCipher,
  VerifiedClientTokens,
} from "./client";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const kms = new KMSClient({});
const secrets = new SecretsManagerClient({});

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export type ClientRuntimeConfig = Readonly<{
  portalOrigin: string;
  issuer: string;
  clientId: string;
  clientSecretArn: string;
  authDomain: string;
  callbackUrl: string;
  logoutUrl: string;
  sessionTableName: string;
  identityTableName: string;
  tenantDataTableName: string;
  auditTableName: string;
  adminControlTableName: string;
  applicationKeyArn: string;
}>;

export function clientRuntimeConfig(environment = process.env): ClientRuntimeConfig {
  return {
    portalOrigin: required(environment.PORTAL_ORIGIN, "PORTAL_ORIGIN"),
    issuer: required(environment.CLIENT_ISSUER, "CLIENT_ISSUER"),
    clientId: required(environment.CLIENT_APP_CLIENT_ID, "CLIENT_APP_CLIENT_ID"),
    clientSecretArn: required(environment.CLIENT_APP_SECRET_ARN, "CLIENT_APP_SECRET_ARN"),
    authDomain: required(environment.CLIENT_AUTH_DOMAIN, "CLIENT_AUTH_DOMAIN"),
    callbackUrl: required(environment.CLIENT_CALLBACK_URL, "CLIENT_CALLBACK_URL"),
    logoutUrl: required(environment.CLIENT_LOGOUT_URL, "CLIENT_LOGOUT_URL"),
    sessionTableName: required(environment.SESSION_TABLE_NAME, "SESSION_TABLE_NAME"),
    identityTableName: required(environment.IDENTITY_TABLE_NAME, "IDENTITY_TABLE_NAME"),
    tenantDataTableName: required(environment.TENANT_DATA_TABLE_NAME, "TENANT_DATA_TABLE_NAME"),
    auditTableName: required(environment.AUDIT_TABLE_NAME, "AUDIT_TABLE_NAME"),
    adminControlTableName: required(environment.ADMIN_CONTROL_TABLE_NAME, "ADMIN_CONTROL_TABLE_NAME"),
    applicationKeyArn: required(environment.APPLICATION_KEY_ARN, "APPLICATION_KEY_ARN"),
  };
}

export class KmsTokenCipher implements TokenCipher {
  constructor(private readonly keyId: string) {}

  async encrypt(value: string): Promise<string> {
    const result = await kms.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(value, "utf8"),
        EncryptionContext: { purpose: "bdr-client-bff-session" },
      }),
    );
    if (!result.CiphertextBlob) throw new Error("KMS returned no ciphertext");
    return Buffer.from(result.CiphertextBlob).toString("base64");
  }

  async decrypt(value: string): Promise<string> {
    const result = await kms.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: Buffer.from(value, "base64"),
        EncryptionContext: { purpose: "bdr-client-bff-session" },
      }),
    );
    if (!result.Plaintext) throw new Error("KMS returned no plaintext");
    return Buffer.from(result.Plaintext).toString("utf8");
  }
}

export class CognitoClientOAuth implements ClientOAuth {
  private readonly jwks;
  private secret?: string;

  constructor(private readonly config: ClientRuntimeConfig) {
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
      // Require fresh credentials every time the dashboard redirects to Cognito.
      // This prevents Cognito's own SSO session from silently re-authenticating
      // a user whose BDR dashboard session has expired.
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
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${await this.clientSecret()}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
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
    return access;
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
    return access;
  }

  async verifyRefresh(
    tokens: ClientTokenSet,
    expectedIssuer: string,
    expectedSub: string,
  ): Promise<VerifiedClientTokens> {
    const verified = await this.verifyAccessToken(tokens.accessToken);
    if (verified.issuer !== expectedIssuer || verified.sub !== expectedSub) {
      throw new Error("Refreshed token changed the authenticated subject");
    }
    return verified;
  }

  private async verifyAccessToken(token: string): Promise<VerifiedClientTokens> {
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.config.issuer });
    this.assertAccessClaims(payload);
    return {
      issuer: payload.iss,
      sub: payload.sub,
      accessTokenExpiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  private assertAccessClaims(payload: JWTPayload): asserts payload is JWTPayload & {
    iss: string;
    sub: string;
    exp: number;
  } {
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    const passwordLoginScope = scopes.includes("openid") || scopes.includes("aws.cognito.signin.user.admin");
    if (
      payload.token_use !== "access" ||
      payload.client_id !== this.config.clientId ||
      typeof payload.iss !== "string" ||
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      !passwordLoginScope
    ) {
      throw new Error("Cognito access token claims are invalid");
    }
  }

  private async tokenRequest(parameters: Readonly<Record<string, string>>): Promise<ClientTokenSet> {
    const response = await fetch(new URL("/oauth2/token", this.config.authDomain), {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${await this.clientSecret()}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
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

  private async clientSecret(): Promise<string> {
    if (this.secret) return this.secret;
    const result = await secrets.send(
      new GetSecretValueCommand({ SecretId: this.config.clientSecretArn }),
    );
    if (!result.SecretString) throw new Error("Client secret is unavailable");
    this.secret = result.SecretString;
    return this.secret;
  }
}

export class DynamoClientAuthStore implements ClientAuthStore {
  constructor(protected readonly config: ClientRuntimeConfig) {}

  async createLogin(state: string, transaction: OAuthLoginTransaction): Promise<void> {
    await dynamo.send(
      new PutCommand({
        TableName: this.config.sessionTableName,
        Item: { ...sessionKeys.clientLogin(state), ...transaction },
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      }),
    );
  }

  async getLogin(state: string): Promise<OAuthLoginTransaction | null> {
    const result = await dynamo.send(
      new GetCommand({
        TableName: this.config.sessionTableName,
        Key: sessionKeys.clientLogin(state),
        ConsistentRead: true,
      }),
    );
    return result.Item ? oauthLoginTransactionSchema.parse(result.Item) : null;
  }

  async getInvitation(organizationId: string, invitationId: string): Promise<AdminInvitation | null> {
    const result = await dynamo.send(new GetCommand({
      TableName: this.config.adminControlTableName,
      Key: adminControlKeys.invitation(organizationId, invitationId),
      ConsistentRead: true,
    }));
    return result.Item ? adminInvitationSchema.parse(result.Item) : null;
  }

  async acceptInvitation(input: {
    identity: ClientIdentity;
    invitation: AdminInvitation;
    acceptedAt: string;
    requestId: string;
  }): Promise<void> {
    const eventId = `event_${randomUUID()}`;
    await dynamo.send(new TransactWriteCommand({ TransactItems: [
      {
        Update: {
          TableName: this.config.adminControlTableName,
          Key: adminControlKeys.invitation(input.invitation.organizationId, input.invitation.invitationId),
          UpdateExpression: "SET #status = :accepted, acceptedAt = :at, revision = :next",
          ConditionExpression: "#status = :pending AND revision = :expected AND absoluteExpiresAt > :at AND #sub = :sub",
          ExpressionAttributeNames: { "#status": "status", "#sub": "sub" },
          ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":pending": "PENDING", ":at": input.acceptedAt, ":expected": input.invitation.revision, ":next": `rev_${randomUUID()}`, ":sub": input.identity.sub },
        },
      },
      {
        Update: {
          TableName: this.config.identityTableName,
          Key: identityKeys.subject(input.identity.issuer, input.identity.sub),
          UpdateExpression: "SET #status = :active, invitationId = :none",
          ConditionExpression: "#status = :invited AND organizationId = :organizationId AND userId = :userId AND invitationId = :invitationId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":active": "ACTIVE", ":invited": "INVITED", ":none": null, ":organizationId": input.identity.organizationId, ":userId": input.identity.userId, ":invitationId": input.invitation.invitationId },
        },
      },
      {
        Update: {
          TableName: this.config.tenantDataTableName,
          Key: tenantKeys.user(input.identity.organizationId, input.identity.userId),
          UpdateExpression: "SET #status = :active, revision = :next",
          ConditionExpression: "#status = :invited AND currentIssuer = :issuer AND currentSub = :sub",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":active": "ACTIVE", ":invited": "INVITED", ":issuer": input.identity.issuer, ":sub": input.identity.sub, ":next": `rev_${randomUUID()}` },
        },
      },
      {
        Put: {
          TableName: this.config.auditTableName,
          Item: { ...auditKeys.organization(input.identity.organizationId, input.acceptedAt, eventId), eventId, organizationId: input.identity.organizationId, occurredAt: input.acceptedAt, ttlExpiresAt: auditExpiresAt(input.acceptedAt), action: "INVITATION_ACCEPTED", actorId: input.identity.userId, actorSub: input.identity.sub, requestId: input.requestId, target: { userId: input.identity.userId, invitationId: input.invitation.invitationId } },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
    ] }));
  }

  async getClientIdentity(key: DynamoKey, _options: ConsistentRead): Promise<ClientIdentity | null> {
    const result = await dynamo.send(
      new GetCommand({
        TableName: this.config.identityTableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const adminIssuer = process.env.ADMIN_ISSUER;
    if (adminIssuer && result.Item.issuer === adminIssuer) {
      const active = await this.adminDirectory().authorize(String(result.Item.sub));
      return { issuer: active.identity.issuer, sub: active.identity.sub, userId: active.identity.adminId,
        organizationId: ADMIN_DASHBOARD_ORGANIZATION, status: "ACTIVE", invitationId: null };
    }
    const identity = clientIdentitySchema.parse(result.Item);
    if (identity.issuer !== this.config.issuer) return null;
    const membership = await dynamo.send(new GetCommand({ TableName: this.config.tenantDataTableName,
      Key: tenantKeys.user(identity.organizationId, identity.userId), ConsistentRead: true }));
    const user = clientUserSchema.safeParse(membership.Item);
    if (!user.success || user.data.organizationId !== identity.organizationId || user.data.userId !== identity.userId
      || user.data.currentIssuer !== identity.issuer || user.data.currentSub !== identity.sub
      || user.data.status !== identity.status || user.data.status === "REVOKED") return null;
    return identity;
  }

  async getOrganization(key: DynamoKey, _options: ConsistentRead): Promise<Organization | null> {
    if (key.PK === `ORG#${ADMIN_DASHBOARD_ORGANIZATION}` && key.SK === "META") {
      return { organizationId: ADMIN_DASHBOARD_ORGANIZATION, displayName: "BDR admins", status: "ACTIVE" };
    }
    const result = await dynamo.send(
      new GetCommand({
        TableName: this.config.tenantDataTableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    return result.Item ? organizationSchema.parse(result.Item) : null;
  }

  private adminDirectory(): AdministratorDirectory {
    return new AdministratorDirectory({ issuer: required(process.env.ADMIN_ISSUER, "ADMIN_ISSUER"),
      clientPoolId: required(process.env.CLIENT_USER_POOL_ID, "CLIENT_USER_POOL_ID"),
      identityTable: this.config.identityTableName, controlTable: this.config.adminControlTableName, auditTable: this.config.auditTableName }, dynamo);
  }

  async completeAdministratorEnrollment(input: { issuer: string; sub: string; requestId: string }): Promise<void> {
    if (input.issuer !== process.env.ADMIN_ISSUER) throw new Error("Unexpected administrator issuer");
    await this.adminDirectory().complete(input.sub, input.requestId);
  }

  private async authorizationChecks(identity: ClientIdentity): Promise<NonNullable<TransactWriteCommandInput["TransactItems"]>> {
    if (identity.issuer === process.env.ADMIN_ISSUER) {
      const active = await this.adminDirectory().authorize(identity.sub);
      if (active.identity.adminId !== identity.userId) throw new Error("Administrator identity changed");
      return [
        { ConditionCheck: { TableName: this.config.identityTableName, Key: identityKeys.subject(identity.issuer, identity.sub),
          ConditionExpression: "adminId = :admin AND issuer = :issuer AND #sub = :sub", ExpressionAttributeNames: { "#sub": "sub" }, ExpressionAttributeValues: { ":admin": identity.userId, ":issuer": identity.issuer, ":sub": identity.sub } } },
        { ConditionCheck: { TableName: this.config.identityTableName, Key: identityKeys.adminProfile(identity.userId),
          ConditionExpression: "#status = :active AND #role = :role AND totpEnrolled = :true", ExpressionAttributeNames: { "#status": "status", "#role": "role" }, ExpressionAttributeValues: { ":active": "ACTIVE", ":role": "BDR_ADMIN", ":true": true } } },
        { ConditionCheck: { TableName: this.config.identityTableName, Key: identityKeys.adminGuard(), ConditionExpression: "activeAdminCount = :count", ExpressionAttributeValues: { ":count": active.count } } },
      ];
    }
    return [
      { ConditionCheck: { TableName: this.config.identityTableName, Key: identityKeys.subject(identity.issuer, identity.sub),
        ConditionExpression: "#status = :active AND issuer = :issuer AND #sub = :sub AND organizationId = :org AND userId = :user", ExpressionAttributeNames: { "#status": "status", "#sub": "sub" }, ExpressionAttributeValues: { ":active": "ACTIVE", ":issuer": identity.issuer, ":sub": identity.sub, ":org": identity.organizationId, ":user": identity.userId } } },
      { ConditionCheck: { TableName: this.config.tenantDataTableName, Key: tenantKeys.user(identity.organizationId, identity.userId),
        ConditionExpression: "#status = :active AND currentIssuer = :issuer AND currentSub = :sub", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "ACTIVE", ":issuer": identity.issuer, ":sub": identity.sub } } },
      { ConditionCheck: { TableName: this.config.tenantDataTableName, Key: tenantKeys.organization(identity.organizationId), ConditionExpression: "#status = :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "ACTIVE" } } },
    ];
  }

  async consumeLoginAndCreateSession(input: {
    state: string;
    now: string;
    rawSessionId: string;
    session: ClientSession;
    identity: ClientIdentity;
    requestId: string;
  }): Promise<void> {
    const eventId = `event_${randomUUID()}`;
    const auditKey = auditKeys.organization(input.identity.organizationId, input.now, eventId);
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.config.sessionTableName,
              Key: sessionKeys.clientLogin(input.state),
              UpdateExpression: "SET consumedAt = :now",
              ConditionExpression:
                "stateHash = :stateHash AND consumedAt = :null AND absoluteExpiresAt > :now",
              ExpressionAttributeValues: {
                ":stateHash": sha256(input.state),
                ":null": null,
                ":now": input.now,
              },
            },
          },
          ...await this.authorizationChecks(input.identity),
          {
            Put: {
              TableName: this.config.sessionTableName,
              Item: { ...sessionKeys.clientSession(input.rawSessionId), ...input.session },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          {
            Put: {
              TableName: this.config.sessionTableName,
              Item: {
                ...sessionKeys.clientSubjectPointer(
                  input.session.issuer,
                  input.session.sub,
                  input.rawSessionId,
                ),
                sessionIdHash: input.session.sessionIdHash,
                absoluteExpiresAt: input.session.absoluteExpiresAt,
                ttlExpiresAt: input.session.ttlExpiresAt,
                revokedAt: null,
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          {
            Put: {
              TableName: this.config.auditTableName,
              Item: {
                ...auditKey,
                eventId,
                organizationId: input.identity.organizationId,
                occurredAt: input.now,
                ttlExpiresAt: auditExpiresAt(input.now),
                action: "CLIENT_LOGIN",
                actorId: input.identity.userId,
                actorSub: input.identity.sub,
                requestId: input.requestId,
                target: { userId: input.identity.userId },
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
        ],
      }),
    );
  }

  async getClientSession(key: DynamoKey, _options: ConsistentRead): Promise<ClientSession | null> {
    const result = await dynamo.send(
      new GetCommand({
        TableName: this.config.sessionTableName,
        Key: key,
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const parsed = clientSessionSchema.safeParse(result.Item);
    if (!parsed.success) {
      // A pre-idle-timeout session has no lastActivityAt. Treat any malformed
      // stored session as unauthenticated rather than returning HTTP 400.
      console.warn(JSON.stringify({ event: "invalid_client_session_record" }));
      return null;
    }
    return parsed.data;
  }

  async rotateSession(input: {
    oldRawSessionId: string;
    oldSession: ClientSession;
    newRawSessionId: string;
    newSession: ClientSession;
    revokedAt: string;
  }): Promise<void> {
    const identity = await this.getClientIdentity(identityKeys.subject(input.oldSession.issuer, input.oldSession.sub), { consistentRead: true });
    if (!identity) throw new Error("Session identity is no longer active");
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          ...await this.authorizationChecks(identity),
          this.revokeSessionUpdate(sessionKeys.clientSession(input.oldRawSessionId), input.revokedAt),
          this.revokeSessionUpdate(
            sessionKeys.clientSubjectPointer(
              input.oldSession.issuer,
              input.oldSession.sub,
              input.oldRawSessionId,
            ),
            input.revokedAt,
          ),
          {
            Put: {
              TableName: this.config.sessionTableName,
              Item: { ...sessionKeys.clientSession(input.newRawSessionId), ...input.newSession },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          {
            Put: {
              TableName: this.config.sessionTableName,
              Item: {
                ...sessionKeys.clientSubjectPointer(
                  input.newSession.issuer,
                  input.newSession.sub,
                  input.newRawSessionId,
                ),
                sessionIdHash: input.newSession.sessionIdHash,
                absoluteExpiresAt: input.newSession.absoluteExpiresAt,
                ttlExpiresAt: input.newSession.ttlExpiresAt,
                revokedAt: null,
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
        ],
      }),
    );
  }

  async touchSessionActivity(input: {
    rawSessionId: string;
    session: ClientSession;
    newLastActivityAt: string;
  }): Promise<boolean> {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: this.config.sessionTableName,
        Key: sessionKeys.clientSession(input.rawSessionId),
        UpdateExpression: "SET lastActivityAt = :newActivity",
        // Reject revocation, expiry, idle sessions, and out-of-order writes.
        ConditionExpression:
          "sessionIdHash = :hash AND revokedAt = :null AND absoluteExpiresAt > :activity AND lastActivityAt >= :idleCutoff AND lastActivityAt <= :activity",
        ExpressionAttributeValues: {
          ":newActivity": input.newLastActivityAt,
          ":hash": input.session.sessionIdHash,
          ":null": null,
          ":activity": input.newLastActivityAt,
          ":idleCutoff": new Date(Date.parse(input.newLastActivityAt) - CLIENT_INACTIVITY_TIMEOUT_MS).toISOString(),
        },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async revokeSession(input: {
    rawSessionId: string;
    session: ClientSession;
    revokedAt: string;
    requestId: string;
  }): Promise<void> {
    const eventId = `event_${randomUUID()}`;
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          this.revokeSessionUpdate(sessionKeys.clientSession(input.rawSessionId), input.revokedAt),
          this.revokeSessionUpdate(
            sessionKeys.clientSubjectPointer(
              input.session.issuer,
              input.session.sub,
              input.rawSessionId,
            ),
            input.revokedAt,
          ),
          {
            Put: {
              TableName: this.config.auditTableName,
              Item: {
                ...auditKeys.system(input.revokedAt, eventId),
                eventId,
                occurredAt: input.revokedAt,
                ttlExpiresAt: auditExpiresAt(input.revokedAt),
                action: "CLIENT_LOGOUT",
                actorId: input.session.sub,
                actorSub: input.session.sub,
                requestId: input.requestId,
                target: { sessionIdHash: input.session.sessionIdHash },
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
        ],
      }),
    );
  }

  private revokeSessionUpdate(key: Readonly<{ PK: string; SK: string }>, revokedAt: string) {
    return {
      Update: {
        TableName: this.config.sessionTableName,
        Key: key,
        UpdateExpression: "SET revokedAt = :revokedAt",
        ConditionExpression: "attribute_exists(PK) AND revokedAt = :null",
        ExpressionAttributeValues: { ":revokedAt": revokedAt, ":null": null },
      },
    };
  }
}
