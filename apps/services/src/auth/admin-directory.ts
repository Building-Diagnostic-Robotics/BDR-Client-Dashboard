import { randomUUID } from "node:crypto";

import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminGetUserCommand,
  AdminListGroupsForUserCommand, CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  adminIdentitySchema, adminProfileSchema, administratorEnrollmentSchema,
  type AdminIdentity, type AdminProfile, type AdministratorEnrollment, type AdministratorInviteResponse,
} from "@bdr/contracts";
import { assertActiveAdministratorGuard, auditExpiresAt, auditKeys, conflict, forbidden, identityKeys, sha256 } from "@bdr/domain";

import { cognitoUserExists, normalizeLoginEmail } from "./cognito-user-pools";

export type AdministratorActor = { adminId: string; sub: string; requestId: string };
type DirectoryConfig = { issuer: string; clientPoolId: string; identityTable: string; controlTable: string; auditTable: string };
type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;
export const ADMIN_DASHBOARD_ORGANIZATION = "bdr_portal_admins";
const enrollmentKey = (email: string) => ({ PK: `ADMIN_ENROLLMENT#${sha256(email)}`, SK: "PROFILE" });
const revision = () => `rev_${randomUUID()}`;

/** Canonical administrator records are shared by the browser and CLI. No login-time role grants. */
export class AdministratorDirectory {
  constructor(
    private readonly config: DirectoryConfig,
    private readonly document = DynamoDBDocumentClient.from(new DynamoDBClient({})),
    private readonly cognito = new CognitoIdentityProviderClient({}),
  ) {}
  private get poolId(): string { return new URL(this.config.issuer).pathname.slice(1); }
  private async get(table: string, key: { PK: string; SK: string }) {
    return (await this.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item;
  }
  private audit(action: string, actor: AdministratorActor, target: Record<string, string>): Actions[number] {
    const occurredAt = new Date().toISOString();
    const eventId = `event_${randomUUID()}`;
    return { Put: { TableName: this.config.auditTable, Item: {
      ...auditKeys.system(occurredAt, eventId), eventId, occurredAt, ttlExpiresAt: auditExpiresAt(occurredAt),
      action, actorId: actor.adminId, actorSub: actor.sub, requestId: actor.requestId, target,
    }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }
  writeChecks(actor: AdministratorActor, count: number): Actions {
    return [
      { ConditionCheck: { TableName: this.config.identityTable, Key: identityKeys.subject(this.config.issuer, actor.sub),
        ConditionExpression: "adminId = :admin AND issuer = :issuer AND #sub = :sub", ExpressionAttributeNames: { "#sub": "sub" }, ExpressionAttributeValues: { ":admin": actor.adminId, ":issuer": this.config.issuer, ":sub": actor.sub } } },
      { ConditionCheck: { TableName: this.config.identityTable, Key: identityKeys.adminProfile(actor.adminId),
        ConditionExpression: "#status = :active AND #role = :role AND totpEnrolled = :true", ExpressionAttributeNames: { "#status": "status", "#role": "role" }, ExpressionAttributeValues: { ":active": "ACTIVE", ":role": "BDR_ADMIN", ":true": true } } },
      { ConditionCheck: { TableName: this.config.identityTable, Key: identityKeys.adminGuard(), ConditionExpression: "activeAdminCount = :count", ExpressionAttributeValues: { ":count": count } } },
    ];
  }
  async eligible(sub: string): Promise<{ identity: AdminIdentity; profile: AdminProfile; count: number }> {
    const raw = await this.get(this.config.identityTable, identityKeys.subject(this.config.issuer, sub));
    const identity = adminIdentitySchema.safeParse(raw);
    if (!identity.success || identity.data.issuer !== this.config.issuer || identity.data.sub !== sub) forbidden();
    const [rawProfile, guard] = await Promise.all([
      this.get(this.config.identityTable, identityKeys.adminProfile(identity.data.adminId)),
      this.get(this.config.identityTable, identityKeys.adminGuard()),
    ]);
    const profile = adminProfileSchema.safeParse(rawProfile);
    if (!profile.success || profile.data.adminId !== identity.data.adminId || profile.data.status !== "ACTIVE" || !profile.data.totpEnrolled) forbidden();
    const count: unknown = guard?.activeAdminCount;
    assertActiveAdministratorGuard(count);
    return { identity: identity.data, profile: profile.data, count };
  }
  async currentUser(sub: string) {
    const user = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.poolId, Username: sub }));
    const actualSub = user.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
    if (actualSub !== sub || !user.Enabled || user.UserStatus !== "CONFIRMED" || !user.UserMFASettingList?.includes("SOFTWARE_TOKEN_MFA")) forbidden();
    let next: string | undefined;
    let member = false;
    do {
      const page = await this.cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: this.poolId, Username: sub, ...(next ? { NextToken: next } : {}) }));
      member ||= (page.Groups ?? []).some((group) => group.GroupName === "bdr-admins");
      next = page.NextToken;
    } while (next);
    if (!member) forbidden();
    return user;
  }
  async authorize(sub: string) {
    const active = await this.eligible(sub);
    await this.currentUser(sub);
    return active;
  }
  async invite(emailInput: string, actor: AdministratorActor, resend = false): Promise<AdministratorInviteResponse> {
    const email = normalizeLoginEmail(emailInput);
    // Recheck the actor at the mutation boundary, never trust a browser-supplied role.
    const active = await this.authorize(actor.sub);
    if (active.identity.adminId !== actor.adminId) forbidden();
    if (await cognitoUserExists(this.cognito, this.config.clientPoolId, email)) conflict("This email already belongs to a client account");
    const key = enrollmentKey(email);
    let raw = await this.get(this.config.controlTable, key);
    if (!raw) {
      if (await cognitoUserExists(this.cognito, this.poolId, email)) {
        const existing = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.poolId, Username: email }));
        const sub = existing.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
        if (!sub) forbidden();
        await this.authorize(sub); // Never adopt or re-enable an unmapped/disabled account.
        return { email, status: "ALREADY_ADMIN" };
      }
      const createdAt = new Date().toISOString();
      const pending: AdministratorEnrollment = {
        email, issuer: this.config.issuer, adminId: `admin_${randomUUID().replaceAll("-", "")}`,
        sub: null, username: null, status: "CREATING", actorId: actor.adminId, actorSub: actor.sub,
        createdAt, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), revision: revision(),
      };
      try {
        await this.document.send(new TransactWriteCommand({ TransactItems: [
          ...this.writeChecks(actor, active.count),
          { Put: { TableName: this.config.identityTable, Item: { ...identityKeys.emailReservation(email), normalizedEmail: email, ownerType: "ADMIN", adminId: pending.adminId, issuer: this.config.issuer }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
          { Put: { TableName: this.config.controlTable, Item: { ...key, ...pending }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
          this.audit("ADMIN_INVITATION_STARTED", actor, { email, adminId: pending.adminId }),
        ] }));
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") conflict("This email is already reserved or administrator access changed; reload and review before retrying");
        throw error;
      }
      // Suppress the first email until durable ownership is recorded. An uncertain create
      // outcome is deliberately not adopted automatically by a subsequent request.
      const result = await this.cognito.send(new AdminCreateUserCommand({ UserPoolId: this.poolId, Username: email,
        MessageAction: "SUPPRESS", UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
      }));
      const sub = result.User?.Attributes?.find((attribute) => attribute.Name === "sub")?.Value;
      const username = result.User?.Username;
      if (!sub || !username) throw new Error("Administrator creation requires reconciliation");
      raw = { ...pending, sub, username, status: "PREPARED", revision: revision() };
      await this.document.send(new PutCommand({ TableName: this.config.controlTable, Item: { ...key, ...raw },
        ConditionExpression: "revision = :expected AND #status = :creating", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":expected": pending.revision, ":creating": "CREATING" },
      }));
    }
    let pending = administratorEnrollmentSchema.parse(raw);
    if (pending.issuer !== this.config.issuer) forbidden();
    if (pending.status === "ACCEPTED") { await this.authorize(pending.sub ?? ""); return { email, status: "ALREADY_ADMIN" }; }
    if (!pending.sub || !pending.username) return { email, status: "PENDING" };
    if (pending.status !== "PREPARED" && !resend) return { email, status: "PENDING" };
    const user = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.poolId, Username: pending.username }));
    if (user.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value !== pending.sub || !user.Enabled || user.UserStatus !== "FORCE_CHANGE_PASSWORD") conflict("Administrator onboarding has changed; reconcile before resending");
    await this.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: this.poolId, Username: pending.username, GroupName: "bdr-admins" }));
    const next = { ...pending, status: "DELIVERY_UNCERTAIN" as const, revision: revision(), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() };
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      ...this.writeChecks(actor, active.count),
      { ConditionCheck: { TableName: this.config.identityTable, Key: identityKeys.emailReservation(email), ConditionExpression: "ownerType = :type AND adminId = :admin AND issuer = :issuer AND normalizedEmail = :email", ExpressionAttributeValues: { ":type": "ADMIN", ":admin": pending.adminId, ":issuer": this.config.issuer, ":email": email } } },
      { Put: { TableName: this.config.controlTable, Item: { ...key, ...next }, ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": pending.revision } } },
      this.audit(resend ? "ADMIN_INVITATION_RESEND_STARTED" : "ADMIN_INVITATION_DELIVERY_STARTED", actor, { email, adminId: pending.adminId }),
    ] }));
    pending = next;
    await this.cognito.send(new AdminCreateUserCommand({ UserPoolId: this.poolId, Username: pending.username!, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"] }));
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      ...this.writeChecks(actor, active.count),
      { Update: { TableName: this.config.controlTable, Key: key, UpdateExpression: "SET #status = :invited, revision = :next", ConditionExpression: "revision = :expected",
        ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":invited": "INVITED", ":next": revision(), ":expected": pending.revision } } },
      this.audit("ADMIN_INVITATION_SENT", actor, { email, adminId: pending.adminId }),
    ] }));
    return { email, status: "INVITED" };
  }
  async complete(sub: string, requestId: string): Promise<void> {
    const rawIdentity = await this.get(this.config.identityTable, identityKeys.subject(this.config.issuer, sub));
    if (adminIdentitySchema.safeParse(rawIdentity).success) { await this.authorize(sub); return; }
    // Legacy browser-only identities are not authority to create canonical administrators.
    if (rawIdentity) forbidden();
    const user = await this.currentUser(sub);
    const email = normalizeLoginEmail(user.UserAttributes?.find((attribute) => attribute.Name === "email")?.Value ?? "");
    const pending = administratorEnrollmentSchema.parse(await this.get(this.config.controlTable, enrollmentKey(email)));
    if (pending.sub !== sub || pending.username !== user.Username || pending.issuer !== this.config.issuer
      || !["INVITED", "DELIVERY_UNCERTAIN"].includes(pending.status) || Date.parse(pending.expiresAt) <= Date.now()) forbidden();
    for (let attempt = 0; attempt < 3; attempt++) {
      const guard = await this.get(this.config.identityTable, identityKeys.adminGuard());
      const count: unknown = guard?.activeAdminCount;
      assertActiveAdministratorGuard(count);
      try {
        await this.document.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: this.config.identityTable, Key: identityKeys.emailReservation(email), ConditionExpression: "ownerType = :type AND adminId = :admin AND issuer = :issuer AND normalizedEmail = :email", ExpressionAttributeValues: { ":type": "ADMIN", ":admin": pending.adminId, ":issuer": this.config.issuer, ":email": email } } },
          { Put: { TableName: this.config.identityTable, Item: { ...identityKeys.subject(this.config.issuer, sub), issuer: this.config.issuer, sub, adminId: pending.adminId }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
          { Put: { TableName: this.config.identityTable, Item: { ...identityKeys.adminProfile(pending.adminId), adminId: pending.adminId, status: "ACTIVE", role: "BDR_ADMIN", totpEnrolled: true }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
          { Update: { TableName: this.config.identityTable, Key: identityKeys.adminGuard(), UpdateExpression: "SET activeAdminCount = :next", ConditionExpression: "activeAdminCount = :expected", ExpressionAttributeValues: { ":next": count + 1, ":expected": count } } },
          { Update: { TableName: this.config.controlTable, Key: enrollmentKey(email), UpdateExpression: "SET #status = :accepted, revision = :next", ConditionExpression: "revision = :expected AND #sub = :sub AND expiresAt > :now", ExpressionAttributeNames: { "#status": "status", "#sub": "sub" }, ExpressionAttributeValues: { ":accepted": "ACCEPTED", ":next": revision(), ":expected": pending.revision, ":sub": sub, ":now": new Date().toISOString() } } },
          this.audit("ADMIN_ADDED", { adminId: pending.actorId, sub: pending.actorSub, requestId }, { email, adminId: pending.adminId, sub }),
        ] }));
        return;
      } catch (error) {
        // Only retry a conditional race, never an uncertain service/network failure.
        if (!(error instanceof Error) || error.name !== "TransactionCanceledException"
          || !("CancellationReasons" in error) || !Array.isArray(error.CancellationReasons)
          || !error.CancellationReasons.some((reason: unknown) => reason && typeof reason === "object" && "Code" in reason && reason.Code === "ConditionalCheckFailed")
          || error.CancellationReasons.some((reason: unknown) => reason && typeof reason === "object" && "Code" in reason && reason.Code !== "None" && reason.Code !== "ConditionalCheckFailed")) throw error;
        const existing = await this.get(this.config.identityTable, identityKeys.subject(this.config.issuer, sub));
        if (existing) {
          const active = await this.authorize(sub);
          if (active.identity.adminId !== pending.adminId) forbidden();
          return;
        }
        if (attempt === 2) throw error;
      }
    }
  }
}
