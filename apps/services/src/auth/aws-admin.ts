import { randomUUID } from "node:crypto";

import { CognitoIdentityProviderClient, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  adminIdentitySchema,
  adminProfileSchema,
  adminSessionSchema,
  type AdminIdentity,
  type AdminProfile,
  type AdminSession,
} from "@bdr/contracts";
import { auditExpiresAt, auditKeys, identityKeys, sessionKeys } from "@bdr/domain";

import type { AdminAuthConfig, AdminAuthStore, AdminCognitoVerifier } from "./admin";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const cognito = new CognitoIdentityProviderClient({});

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export type AdminRuntimeConfig = AdminAuthConfig &
  Readonly<{
    identityTableName: string;
    sessionTableName: string;
    auditTableName: string;
    tenantDataTableName: string;
    adminControlTableName: string;
    clientUserPoolId: string;
    clientIssuer: string;
    uploadPresignerFunctionName: string;
    publisherFunctionName: string;
    maxUploadBytes: number;
  }>;

export function adminRuntimeConfig(environment = process.env): AdminRuntimeConfig {
  return {
    issuer: required(environment.ADMIN_ISSUER, "ADMIN_ISSUER"),
    clientId: required(environment.ADMIN_APP_CLIENT_ID, "ADMIN_APP_CLIENT_ID"),
    authDomain: required(environment.ADMIN_AUTH_DOMAIN, "ADMIN_AUTH_DOMAIN"),
    logoutUrl: required(environment.ADMIN_CLI_LOGOUT_URL, "ADMIN_CLI_LOGOUT_URL"),
    identityTableName: required(environment.IDENTITY_TABLE_NAME, "IDENTITY_TABLE_NAME"),
    sessionTableName: required(environment.SESSION_TABLE_NAME, "SESSION_TABLE_NAME"),
    auditTableName: required(environment.AUDIT_TABLE_NAME, "AUDIT_TABLE_NAME"),
    tenantDataTableName: required(environment.TENANT_DATA_TABLE_NAME, "TENANT_DATA_TABLE_NAME"),
    adminControlTableName: required(environment.ADMIN_CONTROL_TABLE_NAME, "ADMIN_CONTROL_TABLE_NAME"),
    clientUserPoolId: required(environment.CLIENT_USER_POOL_ID, "CLIENT_USER_POOL_ID"),
    clientIssuer: required(environment.CLIENT_ISSUER, "CLIENT_ISSUER"),
    uploadPresignerFunctionName: required(environment.UPLOAD_PRESIGNER_FUNCTION_NAME, "UPLOAD_PRESIGNER_FUNCTION_NAME"),
    publisherFunctionName: required(environment.PUBLISHER_FUNCTION_NAME, "PUBLISHER_FUNCTION_NAME"),
    maxUploadBytes: Number(environment.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024),
  };
}

export class CognitoAdminVerifier implements AdminCognitoVerifier {
  async assertCurrentUser(input: { accessToken: string; expectedSub: string }): Promise<void> {
    const user = await cognito.send(new GetUserCommand({ AccessToken: input.accessToken }));
    const sub = user.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
    if (sub !== input.expectedSub || !user.UserMFASettingList?.includes("SOFTWARE_TOKEN_MFA")) {
      throw new Error("Cognito administrator identity or TOTP enrollment is invalid");
    }
  }
}

export class DynamoAdminAuthStore implements AdminAuthStore {
  constructor(private readonly config: AdminRuntimeConfig) {}

  async getIdentity(issuer: string, sub: string): Promise<AdminIdentity | null> {
    const result = await dynamo.send(
      new GetCommand({
        TableName: this.config.identityTableName,
        Key: identityKeys.subject(issuer, sub),
        ConsistentRead: true,
      }),
    );
    return result.Item ? adminIdentitySchema.parse(result.Item) : null;
  }

  async getProfile(adminId: string): Promise<AdminProfile | null> {
    const result = await dynamo.send(
      new GetCommand({
        TableName: this.config.identityTableName,
        Key: identityKeys.adminProfile(adminId),
        ConsistentRead: true,
      }),
    );
    return result.Item ? adminProfileSchema.parse(result.Item) : null;
  }

  async getSession(originJti: string): Promise<AdminSession | null> {
    const result = await dynamo.send(
      new GetCommand({
        TableName: this.config.sessionTableName,
        Key: sessionKeys.adminSession(originJti),
        ConsistentRead: true,
      }),
    );
    return result.Item ? adminSessionSchema.parse(result.Item) : null;
  }

  async createSession(input: {
    originJti: string;
    identity: AdminIdentity;
    profile: AdminProfile;
    session: AdminSession;
    requestId: string;
  }): Promise<void> {
    const occurredAt = new Date().toISOString();
    const eventId = `event_${randomUUID()}`;
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.config.identityTableName,
              Key: identityKeys.subject(input.identity.issuer, input.identity.sub),
              ConditionExpression: "adminId = :adminId AND issuer = :issuer AND #sub = :sub",
              ExpressionAttributeNames: { "#sub": "sub" },
              ExpressionAttributeValues: {
                ":adminId": input.identity.adminId,
                ":issuer": input.identity.issuer,
                ":sub": input.identity.sub,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: this.config.identityTableName,
              Key: identityKeys.adminProfile(input.profile.adminId),
              ConditionExpression: "#status = :active AND #role = :role AND totpEnrolled = :totp",
              ExpressionAttributeNames: { "#status": "status", "#role": "role" },
              ExpressionAttributeValues: {
                ":active": "ACTIVE",
                ":role": "BDR_ADMIN",
                ":totp": true,
              },
            },
          },
          {
            Put: {
              TableName: this.config.sessionTableName,
              Item: { ...sessionKeys.adminSession(input.originJti), ...input.session },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          {
            Put: {
              TableName: this.config.sessionTableName,
              Item: {
                ...sessionKeys.adminPointer(input.profile.adminId, input.originJti),
                ...input.session,
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          {
            Put: {
              TableName: this.config.auditTableName,
              Item: {
                ...auditKeys.system(occurredAt, eventId),
                eventId,
                occurredAt,
                ttlExpiresAt: auditExpiresAt(occurredAt),
                action: "ADMIN_LOGIN",
                actorId: input.profile.adminId,
                actorSub: input.identity.sub,
                requestId: input.requestId,
                target: { adminId: input.profile.adminId },
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
        ],
      }),
    );
  }

  async revokeSession(input: {
    originJti: string;
    adminId: string;
    revokedAt: string;
    requestId: string;
  }): Promise<void> {
    const eventId = `event_${randomUUID()}`;
    await dynamo.send(
      new TransactWriteCommand({
        TransactItems: [
          this.revokeUpdate(sessionKeys.adminSession(input.originJti), input.revokedAt),
          this.revokeUpdate(sessionKeys.adminPointer(input.adminId, input.originJti), input.revokedAt),
          {
            Put: {
              TableName: this.config.auditTableName,
              Item: {
                ...auditKeys.system(input.revokedAt, eventId),
                eventId,
                occurredAt: input.revokedAt,
                ttlExpiresAt: auditExpiresAt(input.revokedAt),
                action: "ADMIN_SESSION_REVOKED",
                actorId: input.adminId,
                requestId: input.requestId,
                target: { adminId: input.adminId },
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
        ],
      }),
    );
  }

  private revokeUpdate(key: Readonly<{ PK: string; SK: string }>, revokedAt: string) {
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
