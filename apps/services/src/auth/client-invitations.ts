import { randomUUID } from "node:crypto";
import { AdminCreateUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { clientIdentitySchema, type ClientAccountInviteResponse } from "@bdr/contracts";
import { auditExpiresAt, auditKeys, conflict, identityKeys, sha256, tenantKeys } from "@bdr/domain";
import { AdministratorDirectory, type AdministratorActor } from "./admin-directory";
import { cognitoUserExists, normalizeLoginEmail } from "./cognito-user-pools";

type Config = { issuer: string; poolId: string; adminIssuer: string; identityTable: string; tenantTable: string; controlTable: string; auditTable: string };
type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;

/** Invitations never serve as an account-transfer or reactivation operation. */
export class ClientInvitations {
  constructor(private readonly config: Config, private readonly document: DynamoDBDocumentClient, private readonly cognito: CognitoIdentityProviderClient) {}
  private async get(table: string, key: { PK: string; SK: string }) {
    return (await this.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item;
  }
  private audit(action: string, actor: AdministratorActor, organizationId: string, email: string): Actions[number] {
    const occurredAt = new Date().toISOString(); const eventId = `event_${randomUUID()}`;
    return { Put: { TableName: this.config.auditTable, Item: { ...auditKeys.organization(organizationId, occurredAt, eventId),
      eventId, occurredAt, ttlExpiresAt: auditExpiresAt(occurredAt), action, actorId: actor.adminId, actorSub: actor.sub,
      requestId: actor.requestId, target: { organizationId, email } }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }
  private organizationCheck(organizationId: string): Actions[number] {
    return { ConditionCheck: { TableName: this.config.tenantTable, Key: tenantKeys.organization(organizationId),
      ConditionExpression: "#status = :active AND organizationId = :org", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "ACTIVE", ":org": organizationId } } };
  }
  async existing(email: string, organizationId: string) {
    const user = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.config.poolId, Username: email }));
    const sub = user.UserAttributes?.find((item) => item.Name === "sub")?.Value;
    const actualEmail = user.UserAttributes?.find((item) => item.Name === "email")?.Value;
    if (!sub || !user.Username || !user.Enabled || normalizeLoginEmail(actualEmail ?? "") !== email) conflict("Existing account requires reconciliation");
    const identity = clientIdentitySchema.safeParse(await this.get(this.config.identityTable, identityKeys.subject(this.config.issuer, sub)));
    if (!identity.success || identity.data.issuer !== this.config.issuer || identity.data.sub !== sub
      || identity.data.organizationId !== organizationId || !["ACTIVE", "INVITED"].includes(identity.data.status)) conflict("This email already belongs to another account; reconcile ownership before inviting");
    const member = await this.get(this.config.tenantTable, tenantKeys.user(organizationId, identity.data.userId));
    const reservation = await this.get(this.config.identityTable, identityKeys.emailReservation(email));
    if (member?.organizationId !== organizationId || member.userId !== identity.data.userId || member.currentIssuer !== this.config.issuer
      || member.currentSub !== sub || member.normalizedEmail !== email || member.status !== identity.data.status
      || reservation?.organizationId !== organizationId || reservation.userId !== identity.data.userId || reservation.normalizedEmail !== email) conflict("Existing account ownership requires reconciliation");
    return { user, member, identity: identity.data };
  }
  async invite(emailInput: string, organizationId: string, actor: AdministratorActor): Promise<ClientAccountInviteResponse> {
    const email = normalizeLoginEmail(emailInput);
    const directory = new AdministratorDirectory({ issuer: this.config.adminIssuer, clientPoolId: this.config.poolId,
      identityTable: this.config.identityTable, controlTable: this.config.controlTable, auditTable: this.config.auditTable }, this.document, this.cognito);
    const active = await directory.authorize(actor.sub);
    if (active.identity.adminId !== actor.adminId) conflict("Administrator identity changed");
    const org = await this.get(this.config.tenantTable, tenantKeys.organization(organizationId));
    if (org?.status !== "ACTIVE" || org.organizationId !== organizationId) conflict("Organization is unavailable");
    if (await cognitoUserExists(this.cognito, new URL(this.config.adminIssuer).pathname.slice(1), email)) conflict("This email already belongs to an administrator account");
    if (await cognitoUserExists(this.cognito, this.config.poolId, email)) {
      const existing = await this.existing(email, organizationId);
      if (!["CONFIRMED", "FORCE_CHANGE_PASSWORD"].includes(existing.user.UserStatus ?? "")) conflict("Existing account requires reconciliation");
      return { email, organizationId, status: existing.user.UserStatus === "CONFIRMED" ? "ALREADY_MEMBER" : "PENDING" };
    }
    const reservationKey = identityKeys.emailReservation(email);
    // All application admin and client creation paths claim this same global key.
    // A failed/uncertain create keeps the claim and requires operator reconciliation.
    const userId = `usr${sha256(`${organizationId}:${email}`).slice(0, 29)}`;
    const reservationRevision = `rev_${randomUUID()}`;
    const checks = () => [...directory.writeChecks(actor, active.count), this.organizationCheck(organizationId)];
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      ...checks(),
      { Put: { TableName: this.config.identityTable, Item: { ...reservationKey, normalizedEmail: email, organizationId, userId, phase: "CREATING", revision: reservationRevision }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
      this.audit("USER_INVITATION_STARTED", actor, organizationId, email),
    ] }));
    const created = await this.cognito.send(new AdminCreateUserCommand({ UserPoolId: this.config.poolId, Username: email, MessageAction: "SUPPRESS",
      UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }] }));
    const sub = created.User?.Attributes?.find((item) => item.Name === "sub")?.Value; const username = created.User?.Username;
    if (!sub || !username) throw new Error("Client creation requires reconciliation");
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      ...checks(),
      { Put: { TableName: this.config.identityTable, Item: { ...identityKeys.subject(this.config.issuer, sub), issuer: this.config.issuer, sub, organizationId, userId, status: "ACTIVE", invitationId: null }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
      { Put: { TableName: this.config.tenantTable, Item: { ...tenantKeys.user(organizationId, userId), organizationId, userId, email, normalizedEmail: email,
        currentIssuer: this.config.issuer, currentSub: sub, cognitoUsername: username, status: "ACTIVE", revision: `rev_${randomUUID()}` }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
      { Update: { TableName: this.config.identityTable, Key: reservationKey, UpdateExpression: "SET #phase = :phase, #sub = :sub", ConditionExpression: "revision = :revision AND #phase = :creating",
        ExpressionAttributeNames: { "#sub": "sub", "#phase": "phase" }, ExpressionAttributeValues: { ":phase": "DELIVERY_UNCERTAIN", ":sub": sub, ":revision": reservationRevision, ":creating": "CREATING" } } },
      this.audit("USER_INVITATION_DELIVERY_STARTED", actor, organizationId, email),
    ] }));
    await this.cognito.send(new AdminCreateUserCommand({ UserPoolId: this.config.poolId, Username: username, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"] }));
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.config.identityTable, Key: reservationKey, UpdateExpression: "SET #phase = :sent", ConditionExpression: "revision = :revision AND #sub = :sub AND #phase = :previous",
        ExpressionAttributeNames: { "#sub": "sub", "#phase": "phase" }, ExpressionAttributeValues: { ":sent": "INVITED", ":revision": reservationRevision, ":sub": sub, ":previous": "DELIVERY_UNCERTAIN" } } },
      this.audit("USER_INVITED", actor, organizationId, email),
    ] }));
    return { email, organizationId, status: "INVITED" };
  }
}
