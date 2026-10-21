import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AdminDeleteUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { adminProfileSchema, clientIdentitySchema, opaqueIdSchema } from "@bdr/contracts";
import { auditExpiresAt, auditKeys, identityKeys, sha256, tenantKeys } from "@bdr/domain";
import { z } from "zod";
import type { SetupConfiguration } from "./sample-dashboard-aws";

type Row = Record<string, unknown>;
type Key = { PK: string; SK: string };
type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;
// Cognito subjects use UUID-shaped identifiers but need not have RFC UUID variant bits.
const account = z.object({ email: z.email(), sub: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) }).strict();
export const reconciliationRequestSchema = z.object({
  environment: z.enum(["development", "production"]), accountId: z.string().regex(/^\d{12}$/),
  client: account.extend({ keepOrganizationId: opaqueIdSchema, keepUserId: opaqueIdSchema, retire: z.array(z.object({ organizationId: opaqueIdSchema, userId: opaqueIdSchema }).strict()).min(1).max(10) }).strict(),
  restoreAdministrator: account.extend({ adminId: opaqueIdSchema }).strict().optional(),
  deletePendingAdministrators: z.array(account).max(10).default([]),
}).strict();
export type ReconciliationRequest = z.infer<typeof reconciliationRequestSchema>;
const row = z.record(z.string(), z.unknown());
const userSchema = z.object({ username: z.string(), sub: z.string(), email: z.string(), enabled: z.boolean(), status: z.string(), mfa: z.array(z.string()), preferredMfa: z.string().nullable(), legacyMfa: z.array(z.string()), groups: z.array(z.string()) }).strict();
type User = z.infer<typeof userSchema>;
const dataSchema = z.object({
  guard: row, profiles: z.array(row), clientUser: userSchema, identity: row, memberships: z.array(row), reservation: row.nullable(), organizations: z.array(row),
  administrator: z.object({ user: userSchema, identity: row, profile: row }).strict().nullable(),
}).strict();
export const reconciliationSnapshotSchema = z.object({
  version: z.literal(1), operationId: z.string().uuid(), createdAt: z.iso.datetime(), request: reconciliationRequestSchema,
  resources: z.object({ region: z.string(), identityTable: z.string(), tenantTable: z.string(), controlTable: z.string(), auditTable: z.string(), clientPool: z.string(), adminPool: z.string() }).strict(),
  data: dataSchema, pendingAdministrators: z.array(userSchema),
}).strict();
export type ReconciliationSnapshot = z.infer<typeof reconciliationSnapshotSchema>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const snapshotDigest = (snapshot: ReconciliationSnapshot) => sha256(canonical(snapshot));
const order = (items: Row[]) => items.sort((a, b) => `${a.PK}:${a.SK}`.localeCompare(`${b.PK}:${b.SK}`));
function requireState(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const fields = ["PK", "SK", "issuer", "sub", "adminId", "organizationId", "userId", "status", "role", "totpEnrolled", "activeAdminCount", "email", "normalizedEmail", "currentIssuer", "currentSub", "cognitoUsername", "revision", "invitationId", "phase", "ownerType", "expiresAt", "displayName", "setupSeedId"];

/** Only named records are repaired. Scans are read-only safeguards, never bulk repair inputs. */
export class AuthenticationReconciliation {
  constructor(private readonly config: SetupConfiguration, private readonly document: DynamoDBDocumentClient, private readonly cognito: CognitoIdentityProviderClient) {}
  private get resources() { return { region: this.config.context.region, identityTable: this.config.identityTable, tenantTable: this.config.context.tenantTable, controlTable: this.config.adminControlTable, auditTable: this.config.auditTable, clientPool: this.config.context.clientPool, adminPool: this.config.adminPool }; }
  private adminIssuer() { return `https://cognito-idp.${this.config.context.region}.amazonaws.com/${this.config.adminPool}`; }
  private assertRequest(request: ReconciliationRequest) {
    requireState(request.accountId === this.config.context.accountId && request.environment === this.config.context.environment, "Request AWS account/environment does not match discovery");
    requireState(request.client.email === request.client.email.trim().toLowerCase(), "Normalize the client email");
    const keys = request.client.retire.map((item) => `${item.organizationId}:${item.userId}`);
    requireState(new Set(keys).size === keys.length && !request.client.retire.some((item) => item.organizationId === request.client.keepOrganizationId), "Retired memberships must be unique and outside the retained organization");
    const admins = [...request.deletePendingAdministrators, ...(request.restoreAdministrator ? [request.restoreAdministrator] : [])];
    requireState(new Set(admins.map((item) => item.sub)).size === admins.length && new Set(admins.map((item) => item.email)).size === admins.length, "Administrator targets overlap");
    requireState(admins.every((item) => item.email === item.email.trim().toLowerCase() && item.email !== request.client.email), "Invalid administrator target email");
  }
  private async get(table: string, key: Key): Promise<Row | null> {
    const names = Object.fromEntries(fields.map((field, index) => [`#f${index}`, field]));
    return (await this.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true, ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names }))).Item ?? null;
  }
  private async scan(table: string): Promise<Row[]> {
    const result: Row[] = []; let next: Row | undefined;
    const names = Object.fromEntries(fields.map((field, index) => [`#f${index}`, field]));
    do {
      const page = await this.document.send(new ScanCommand({ TableName: table, ConsistentRead: true, ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names, ...(next ? { ExclusiveStartKey: next } : {}) }));
      result.push(...page.Items ?? []); next = page.LastEvaluatedKey;
    } while (next);
    return order(result);
  }
  private async user(pool: string, sub: string, admin: boolean): Promise<User | null> {
    let user;
    try { user = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: pool, Username: sub })); }
    catch (error) { if (error instanceof Error && error.name === "UserNotFoundException") return null; throw error; }
    const groups: string[] = []; let next: string | undefined;
    if (admin) do {
      const page = await this.cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: pool, Username: sub, ...(next ? { NextToken: next } : {}) }));
      groups.push(...(page.Groups ?? []).flatMap((group) => group.GroupName ? [group.GroupName] : [])); next = page.NextToken;
    } while (next);
    return userSchema.parse({ username: user.Username ?? "", sub: user.UserAttributes?.find((item) => item.Name === "sub")?.Value ?? "",
      email: user.UserAttributes?.find((item) => item.Name === "email")?.Value?.trim().toLowerCase() ?? "", enabled: user.Enabled === true, status: user.UserStatus ?? "",
      mfa: [...user.UserMFASettingList ?? []].sort(), preferredMfa: user.PreferredMfaSetting ?? null, legacyMfa: (user.MFAOptions ?? []).map((item) => `${item.DeliveryMedium}:${item.AttributeName}`).sort(), groups: groups.sort() });
  }
  private async data(request: ReconciliationRequest) {
    const [identities, memberships, clientUser] = await Promise.all([this.scan(this.config.identityTable), this.scan(this.config.context.tenantTable), this.user(this.config.context.clientPool, request.client.sub, false)]);
    requireState(clientUser && clientUser.sub === request.client.sub && clientUser.email === request.client.email && clientUser.enabled && clientUser.status === "CONFIRMED", "Retained client Cognito account changed or is not eligible");
    const guard = identities.find((item) => item.PK === "ADMIN_GUARD" && item.SK === "ACTIVE_COUNT");
    const profiles = identities.filter((item) => String(item.PK).startsWith("ADMIN#") && item.SK === "PROFILE");
    requireState(guard && typeof guard.activeAdminCount === "number" && Number.isSafeInteger(guard.activeAdminCount) && Number(guard.activeAdminCount) > 0
      && guard.activeAdminCount === profiles.filter((item) => item.status === "ACTIVE" && item.role === "BDR_ADMIN" && item.totpEnrolled === true).length, "Administrator guard requires separate reconciliation");
    const key = identityKeys.subject(this.config.issuer, request.client.sub);
    const identity = identities.find((item) => item.PK === key.PK && item.SK === key.SK);
    requireState(identity, "Current client identity is missing");
    const parsed = clientIdentitySchema.parse(identity);
    requireState(parsed.issuer === this.config.issuer && parsed.sub === request.client.sub && parsed.organizationId === request.client.keepOrganizationId && parsed.userId === request.client.keepUserId && parsed.status === "ACTIVE", "Retained client identity does not match the reviewed owner");
    requireState(identities.filter((item) => String(item.PK).startsWith("SUBJECT#") && item.sub === request.client.sub).length === 1, "Client subject has additional identity records");
    const owned = memberships.filter((item) => String(item.SK).startsWith("USER#") && (item.currentSub === request.client.sub || item.normalizedEmail === request.client.email));
    const expected = [{ organizationId: request.client.keepOrganizationId, userId: request.client.keepUserId }, ...request.client.retire];
    requireState(owned.length === expected.length, "Unexpected client membership count; review a fresh report");
    for (const target of expected) {
      const member = owned.find((item) => item.organizationId === target.organizationId && item.userId === target.userId);
      const memberKey = tenantKeys.user(target.organizationId, target.userId);
      requireState(member && member.PK === memberKey.PK && member.SK === memberKey.SK && member.currentIssuer === this.config.issuer && member.currentSub === request.client.sub && member.normalizedEmail === request.client.email && typeof member.revision === "string", "Client membership changed or is malformed");
      requireState(target.organizationId === request.client.keepOrganizationId ? member.status === "ACTIVE" : ["ACTIVE", "REVOKED"].includes(String(member.status)), "Unexpected client membership status");
    }
    const organizations = memberships.filter((item) => item.SK === "META" && expected.some((target) => target.organizationId === item.organizationId));
    requireState(organizations.length === expected.length && organizations.every((item) => item.PK === tenantKeys.organization(String(item.organizationId)).PK && item.status === "ACTIVE"), "Organization metadata is missing or has changed");
    const reservationKey = identityKeys.emailReservation(request.client.email);
    const reservation = identities.find((item) => item.PK === reservationKey.PK && item.SK === reservationKey.SK) ?? null;
    requireState(!reservation || reservation.normalizedEmail === request.client.email && !reservation.adminId && !reservation.setupSeedId
      && (reservation.ownerType === undefined || reservation.ownerType === "CLIENT")
      && expected.some((target) => target.organizationId === reservation.organizationId && target.userId === reservation.userId), "Email reservation belongs to an unexpected owner");
    let administrator = null;
    if (request.restoreAdministrator) {
      const target = request.restoreAdministrator; const issuer = this.adminIssuer();
      const user = await this.user(this.config.adminPool, target.sub, true);
      requireState(user && user.username === target.sub && user.sub === target.sub && user.email === target.email && user.enabled && user.status === "CONFIRMED" && user.mfa.includes("SOFTWARE_TOKEN_MFA") && user.groups.includes("bdr-admins"), "Administrator is not fully enrolled");
      const subjectKey = identityKeys.subject(issuer, target.sub);
      const mapping = identities.find((item) => item.PK === subjectKey.PK && item.SK === subjectKey.SK);
      const profile = profiles.find((item) => item.adminId === target.adminId);
      requireState(mapping && mapping.issuer === issuer && mapping.sub === target.sub && (mapping.adminId === undefined || mapping.adminId === target.adminId), "Administrator subject is missing or already bound differently");
      requireState(identities.filter((item) => String(item.PK).startsWith("SUBJECT#") && (item.adminId === target.adminId || item.sub === target.sub)).every((item) => item.PK === subjectKey.PK && item.SK === subjectKey.SK), "Administrator has conflicting subject mappings");
      const parsedProfile = adminProfileSchema.parse(profile);
      requireState(profile && parsedProfile.adminId === target.adminId && parsedProfile.status === "ACTIVE" && parsedProfile.totpEnrolled, "Existing canonical administrator profile is ineligible");
      administrator = { user, identity: mapping, profile };
    }
    return dataSchema.parse({ guard, profiles, clientUser, identity, memberships: owned, reservation, organizations, administrator });
  }
  private async pending(target: { email: string; sub: string }): Promise<User | null> {
    const user = await this.user(this.config.adminPool, target.sub, true);
    const [identities, enrollments, memberships] = await Promise.all([this.scan(this.config.identityTable), this.scan(this.config.adminControlTable), this.scan(this.config.context.tenantTable)]);
    requireState(!identities.some((item) => item.sub === target.sub || item.PK === identityKeys.emailReservation(target.email).PK), "Pending administrator now has identity/email ownership; stop");
    requireState(!enrollments.some((item) => String(item.PK).startsWith("ADMIN_ENROLLMENT#") && (item.sub === target.sub || item.email === target.email)), "Pending administrator has an enrollment workflow; stop");
    requireState(!memberships.some((item) => item.currentSub === target.sub || item.normalizedEmail === target.email), "Pending administrator has a membership; stop");
    if (user) requireState(user.username === target.sub && user.sub === target.sub && user.email === target.email && user.enabled && user.status === "FORCE_CHANGE_PASSWORD" && !user.mfa.length && !user.preferredMfa && !user.legacyMfa.length, "Administrator has progressed beyond the reviewed unfinished invitation; stop");
    return user;
  }
  async preview(input: ReconciliationRequest): Promise<ReconciliationSnapshot> {
    const request = reconciliationRequestSchema.parse(input); this.assertRequest(request);
    const data = await this.data(request);
    const pendingAdministrators: User[] = [];
    for (const target of request.deletePendingAdministrators) {
      const user = await this.pending(target); requireState(user, "Pending administrator is already absent; do not create a deletion snapshot"); pendingAdministrators.push(user);
    }
    return { version: 1, operationId: randomUUID(), createdAt: new Date().toISOString(), request, resources: this.resources, data, pendingAdministrators };
  }
  private condition(table: string, key: Key, expected: Row | null, absent: string[] = []): NonNullable<Actions[number]["ConditionCheck"]> {
    if (!expected) return { TableName: table, Key: key, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" };
    const names: Record<string, string> = {}; const values: Row = {}; const conditions: string[] = [];
    Object.entries(expected).forEach(([name, value], index) => { names[`#c${index}`] = name; values[`:c${index}`] = value; conditions.push(`#c${index} = :c${index}`); });
    absent.forEach((name, index) => { names[`#a${index}`] = name; conditions.push(`attribute_not_exists(#a${index})`); });
    return { TableName: table, Key: key, ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
  }
  private audit(snapshot: ReconciliationSnapshot, action: string, target: Row): Actions[number] {
    const occurredAt = new Date().toISOString(); const eventId = `event_${randomUUID()}`;
    return { Put: { TableName: this.config.auditTable, Item: { ...auditKeys.system(occurredAt, eventId), eventId, occurredAt,
      ttlExpiresAt: auditExpiresAt(occurredAt), action, actorId: this.config.context.operatorArn, actorSub: this.config.context.operatorArn,
      requestId: snapshot.operationId, target, details: { environment: snapshot.request.environment, snapshotDigest: snapshotDigest(snapshot) } }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }
  private marker(snapshot: ReconciliationSnapshot, suffix: string): Key { return { PK: `AUTH_RECONCILIATION#${snapshot.operationId}`, SK: suffix }; }
  private after(snapshot: ReconciliationSnapshot) {
    const data = structuredClone(snapshot.data); const request = snapshot.request;
    data.memberships = data.memberships.map((member) => request.client.retire.some((target) => target.organizationId === member.organizationId && target.userId === member.userId) && member.status !== "REVOKED" ? { ...member, status: "REVOKED", revision: `rev_${snapshot.operationId}` } : member);
    data.reservation = { ...data.reservation, ...identityKeys.emailReservation(request.client.email), normalizedEmail: request.client.email, organizationId: request.client.keepOrganizationId, userId: request.client.keepUserId };
    delete data.reservation.invitationId;
    if (data.administrator && request.restoreAdministrator) data.administrator.identity.adminId = request.restoreAdministrator.adminId;
    return data;
  }
  private async repairData(snapshot: ReconciliationSnapshot) {
    const digest = snapshotDigest(snapshot); const key = this.marker(snapshot, "DATA");
    const checkpoint = await this.get(this.config.adminControlTable, key);
    const current = await this.data(snapshot.request); const after = this.after(snapshot);
    if (checkpoint) { requireState(checkpoint.revision === digest && isDeepStrictEqual(current, after), "Repair checkpoint/state changed; stop and review"); return; }
    requireState(isDeepStrictEqual(current, snapshot.data), "Authentication state changed since preview; stop and review a new snapshot");
    const writes: Actions = [
      { ConditionCheck: this.condition(this.config.identityTable, identityKeys.adminGuard(), snapshot.data.guard) },
      { ConditionCheck: this.condition(this.config.identityTable, identityKeys.subject(this.config.issuer, snapshot.request.client.sub), snapshot.data.identity) },
    ];
    for (const member of snapshot.data.memberships) {
      const memberKey = { PK: String(member.PK), SK: String(member.SK) };
      const replacement = after.memberships.find((item) => item.PK === member.PK && item.SK === member.SK)!;
      if (isDeepStrictEqual(member, replacement)) writes.push({ ConditionCheck: this.condition(this.config.context.tenantTable, memberKey, member) });
      else writes.push({ Update: { ...this.condition(this.config.context.tenantTable, memberKey, member), UpdateExpression: "SET #newStatus = :revoked, revision = :newRevision",
        ExpressionAttributeNames: { ...this.condition(this.config.context.tenantTable, memberKey, member).ExpressionAttributeNames, "#newStatus": "status" },
        ExpressionAttributeValues: { ...this.condition(this.config.context.tenantTable, memberKey, member).ExpressionAttributeValues, ":revoked": "REVOKED", ":newRevision": replacement.revision } } });
    }
    for (const org of snapshot.data.organizations) writes.push({ ConditionCheck: this.condition(this.config.context.tenantTable, { PK: String(org.PK), SK: String(org.SK) }, org) });
    const reservationKey = identityKeys.emailReservation(snapshot.request.client.email);
    const condition = this.condition(this.config.identityTable, reservationKey, snapshot.data.reservation);
    writes.push({ Update: { ...condition, UpdateExpression: "SET normalizedEmail = :email, organizationId = :org, userId = :user REMOVE invitationId",
      ExpressionAttributeValues: { ...condition.ExpressionAttributeValues, ":email": snapshot.request.client.email, ":org": snapshot.request.client.keepOrganizationId, ":user": snapshot.request.client.keepUserId } } });
    if (snapshot.data.administrator && snapshot.request.restoreAdministrator) {
      const admin = snapshot.data.administrator; const adminId = snapshot.request.restoreAdministrator.adminId;
      writes.push({ ConditionCheck: this.condition(this.config.identityTable, identityKeys.adminProfile(adminId), admin.profile) });
      const condition = this.condition(this.config.identityTable, identityKeys.subject(this.adminIssuer(), snapshot.request.restoreAdministrator.sub), admin.identity, admin.identity.adminId === undefined ? ["adminId"] : []);
      writes.push({ Update: { ...condition, UpdateExpression: "SET adminId = :restored", ExpressionAttributeValues: { ...condition.ExpressionAttributeValues, ":restored": adminId } } });
    }
    writes.push({ Put: { TableName: this.config.adminControlTable, Item: { ...key, revision: digest, status: "DATA_REPAIRED" }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } }, this.audit(snapshot, "AUTHENTICATION_RECORDS_RECONCILED", { client: snapshot.request.client, administrator: snapshot.request.restoreAdministrator ?? null }));
    await this.document.send(new TransactWriteCommand({ TransactItems: writes }));
  }
  async apply(input: ReconciliationSnapshot): Promise<void> {
    const snapshot = reconciliationSnapshotSchema.parse(input); this.assertRequest(snapshot.request);
    requireState(isDeepStrictEqual(snapshot.resources, this.resources), "Snapshot resources do not match the selected stack");
    requireState(snapshot.pendingAdministrators.length === snapshot.request.deletePendingAdministrators.length, "Invalid deletion snapshot");
    // Preflight every requested deletion before the first mutation.
    for (const target of snapshot.request.deletePendingAdministrators) {
      const user = await this.pending(target); const checkpoint = await this.get(this.config.adminControlTable, this.marker(snapshot, target.sub));
      const expected = snapshot.pendingAdministrators.find((item) => item.sub === target.sub && item.email === target.email);
      requireState(expected && (user ? isDeepStrictEqual(user, expected) : checkpoint?.revision === snapshotDigest(snapshot)), "Pending administrator changed or disappeared without this operation's checkpoint");
    }
    await this.repairData(snapshot);
    for (const target of snapshot.request.deletePendingAdministrators) await this.deletePending(snapshot, target);
  }
  private async deletePending(snapshot: ReconciliationSnapshot, target: { email: string; sub: string }) {
    const key = this.marker(snapshot, target.sub); const digest = snapshotDigest(snapshot);
    let checkpoint = await this.get(this.config.adminControlTable, key);
    requireState(!checkpoint || checkpoint.revision === digest, "Deletion checkpoint does not match the reviewed snapshot");
    const expected = snapshot.pendingAdministrators.find((item) => item.sub === target.sub && item.email === target.email);
    let current = await this.pending(target);
    if (!checkpoint) {
      requireState(current && isDeepStrictEqual(current, expected), "Pending administrator changed; stop");
      await this.document.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: this.condition(this.config.identityTable, identityKeys.adminGuard(), snapshot.data.guard) },
        { ConditionCheck: this.condition(this.config.identityTable, identityKeys.subject(this.adminIssuer(), target.sub), null) },
        { ConditionCheck: this.condition(this.config.identityTable, identityKeys.emailReservation(target.email), null) },
        { ConditionCheck: this.condition(this.config.adminControlTable, { PK: `ADMIN_ENROLLMENT#${sha256(target.email)}`, SK: "PROFILE" }, null) },
        { Put: { TableName: this.config.adminControlTable, Item: { ...key, revision: digest, status: "DELETE_INTENT" }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
        this.audit(snapshot, "UNFINISHED_ADMIN_DELETION_STARTED", target),
      ] }));
      checkpoint = { revision: digest, status: "DELETE_INTENT" };
    }
    if (checkpoint.status === "DELETED") { requireState(!current, "A completed deletion now has a Cognito account; stop"); return; }
    requireState(checkpoint.status === "DELETE_INTENT", "Unknown deletion checkpoint");
    // Cognito has no conditional delete. Recheck immediately and address only the immutable UUID username.
    current = await this.pending(target);
    if (current) {
      requireState(isDeepStrictEqual(current, expected), "Administrator onboarding progressed; deletion stopped");
      const guard = await this.get(this.config.identityTable, identityKeys.adminGuard());
      requireState(isDeepStrictEqual(guard, snapshot.data.guard), "Administrator guard changed; deletion stopped");
      await this.cognito.send(new AdminDeleteUserCommand({ UserPoolId: this.config.adminPool, Username: target.sub }));
    }
    requireState(await this.user(this.config.adminPool, target.sub, true) === null, "Cognito deletion could not be verified");
    await this.document.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.config.adminControlTable, Key: key, UpdateExpression: "SET #status = :done", ConditionExpression: "revision = :digest AND #status = :intent", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":done": "DELETED", ":intent": "DELETE_INTENT", ":digest": digest } } },
      this.audit(snapshot, "UNFINISHED_ADMIN_DELETED", target),
    ] }));
  }
}
