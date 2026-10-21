import { randomUUID } from "node:crypto";
import { AdminDisableUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { clientIdentitySchema, clientUserSchema } from "@bdr/contracts";
import { auditExpiresAt, auditKeys, conflict, identityKeys, notFound, tenantKeys } from "@bdr/domain";
import { z } from "zod";
import type { AdministratorActor } from "./admin-directory";

export type ClientRevocationConfig = { identityTable: string; tenantTable: string; sessionTable: string; auditTable: string; clientPoolId: string; clientIssuer: string };
const userSchema = clientUserSchema.extend({ revision: z.string().min(1) });

/** Access denial is committed before best-effort external cleanup; retry completes cleanup. */
export async function revokeClientAccess(
  config: ClientRevocationConfig, organizationId: string, userId: string,
  expectedRevision: string, actor: AdministratorActor,
  document: DynamoDBDocumentClient, cognito: CognitoIdentityProviderClient,
) {
  const userKey = tenantKeys.user(organizationId, userId);
  const raw = (await document.send(new GetCommand({ TableName: config.tenantTable, Key: userKey, ConsistentRead: true }))).Item;
  if (!raw) notFound();
  const user = userSchema.parse(raw);
  if (user.organizationId !== organizationId || user.userId !== userId || user.currentIssuer !== config.clientIssuer) conflict("Client ownership changed");
  const subjectKey = identityKeys.subject(user.currentIssuer, user.currentSub);
  const identity = clientIdentitySchema.parse((await document.send(new GetCommand({ TableName: config.identityTable, Key: subjectKey, ConsistentRead: true }))).Item);
  if (identity.organizationId !== organizationId || identity.userId !== userId || identity.issuer !== user.currentIssuer || identity.sub !== user.currentSub) conflict("Client ownership changed");
  if (user.status !== "REVOKED" && user.revision !== expectedRevision) conflict();
  const revokedAt = new Date().toISOString();
  const next = { ...user, status: "REVOKED" as const, revision: `rev_${randomUUID()}` };
  if (user.status !== "REVOKED" || identity.status !== "REVOKED") {
    const eventId = `event_${randomUUID()}`;
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: config.tenantTable, Key: userKey, UpdateExpression: "SET #status = :revoked, revision = :next", ConditionExpression: "revision = :expected AND currentIssuer = :issuer AND currentSub = :sub", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":revoked": "REVOKED", ":next": next.revision, ":expected": user.revision, ":issuer": user.currentIssuer, ":sub": user.currentSub } } },
      { Update: { TableName: config.identityTable, Key: subjectKey, UpdateExpression: "SET #status = :revoked", ConditionExpression: "issuer = :issuer AND #sub = :sub AND organizationId = :org AND userId = :user", ExpressionAttributeNames: { "#status": "status", "#sub": "sub" }, ExpressionAttributeValues: { ":revoked": "REVOKED", ":issuer": user.currentIssuer, ":sub": user.currentSub, ":org": organizationId, ":user": userId } } },
      { Put: { TableName: config.auditTable, Item: { ...auditKeys.organization(organizationId, revokedAt, eventId), eventId, occurredAt: revokedAt, ttlExpiresAt: auditExpiresAt(revokedAt), organizationId, action: "USER_REVOKED", actorId: actor.adminId, actorSub: actor.sub, requestId: actor.requestId, target: { userId, sub: user.currentSub } }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
    ] }));
  }
  try {
    let key: Record<string, unknown> | undefined;
    do {
      const page = await document.send(new QueryCommand({ TableName: config.sessionTable, ConsistentRead: true,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :session)", ExpressionAttributeValues: { ":pk": subjectKey.PK, ":session": "SESSION#" }, ...(key ? { ExclusiveStartKey: key } : {}),
      }));
      for (const pointer of page.Items ?? []) {
        if (typeof pointer.sessionIdHash !== "string" || !/^[a-f0-9]{64}$/.test(pointer.sessionIdHash) || pointer.SK !== `SESSION#${pointer.sessionIdHash}`) throw new Error("Invalid subject session pointer");
        // Conditional individual updates tolerate concurrent logout and partial retry.
        for (const target of [{ PK: `SESSION#${pointer.sessionIdHash}`, SK: "SESSION" }, { PK: subjectKey.PK, SK: String(pointer.SK) }]) {
          const canonical = target.PK.startsWith("SESSION#");
          try {
            await document.send(new UpdateCommand({ TableName: config.sessionTable, Key: target, UpdateExpression: "SET revokedAt = :at",
              ConditionExpression: `attribute_exists(PK) AND (attribute_not_exists(revokedAt) OR revokedAt = :null)${canonical ? " AND issuer = :issuer AND #sub = :sub" : ""}`,
              ExpressionAttributeValues: { ":at": revokedAt, ":null": null, ...(canonical ? { ":issuer": user.currentIssuer, ":sub": user.currentSub } : {}) },
              ...(canonical ? { ExpressionAttributeNames: { "#sub": "sub" } } : {}),
            }));
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
            const existing = (await document.send(new GetCommand({ TableName: config.sessionTable, Key: target, ConsistentRead: true }))).Item;
            if (existing && (canonical && (existing.issuer !== user.currentIssuer || existing.sub !== user.currentSub) || !existing.revokedAt)) throw error;
          }
        }
      }
      key = page.LastEvaluatedKey;
    } while (key);
    for (const command of [
      new AdminUserGlobalSignOutCommand({ UserPoolId: config.clientPoolId, Username: user.cognitoUsername }),
      new AdminDisableUserCommand({ UserPoolId: config.clientPoolId, Username: user.cognitoUsername }),
    ]) {
      try { await cognito.send(command); }
      catch (error) { if (!(error instanceof Error) || error.name !== "UserNotFoundException") throw error; }
    }
  } catch {
    conflict("Client access is revoked, but cleanup is incomplete. Retry revocation to finish session and Cognito cleanup.");
  }
  return user.status === "REVOKED" && identity.status === "REVOKED" ? user : next;
}
