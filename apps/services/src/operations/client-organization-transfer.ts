import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AdminEnableUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { clientIdentitySchema, clientUserSchema, opaqueIdSchema, organizationSchema } from "@bdr/contracts";
import { auditExpiresAt, auditKeys, identityKeys, sha256, tenantKeys } from "@bdr/domain";
import { z } from "zod";
import { AdministratorDirectory, type AdministratorActor } from "../auth/admin-directory";
import { revokeClientAccess } from "../auth/client-revocation";
import type { SetupConfiguration } from "./sample-dashboard-aws";

type Row = Record<string, unknown>;
type Key = { PK: string; SK: string };
type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type ConditionalItem = NonNullable<Actions[number]["ConditionCheck"]> & { TableName: string; Key: Key };
const row = z.record(z.string(), z.unknown());
const account = z.object({ email: z.email(), sub: z.string().min(1).max(128) }).strict();
export const clientTransferRequestSchema = z.object({
  environment: z.enum(["development", "production"]), accountId: z.string().regex(/^\d{12}$/),
  administrator: account,
  client: account.extend({ sourceOrganizationId: opaqueIdSchema, sourceUserId: opaqueIdSchema, targetOrganizationId: opaqueIdSchema }).strict(),
}).strict();
export type ClientTransferRequest = z.infer<typeof clientTransferRequestSchema>;
const resourcesSchema = z.object({ environment: z.enum(["development", "production"]), accountId: z.string(), region: z.string(), operatorArn: z.string(),
  identityTable: z.string(), tenantTable: z.string(), sessionTable: z.string(), controlTable: z.string(), auditTable: z.string(), clientPool: z.string(), adminPool: z.string(), issuer: z.url(),
}).strict();
const userSchema = z.object({ username: z.string().min(1), sub: z.string().min(1), email: z.email(), enabled: z.boolean(), status: z.literal("CONFIRMED") }).strict();
const stateSchema = z.object({ user: userSchema, identity: row, reservation: row, memberships: z.array(row).min(1).max(21), organizations: z.array(row).length(2) }).strict();
export const clientTransferSnapshotSchema = z.object({
  version: z.literal(1), operationId: z.uuid(), createdAt: z.iso.datetime(), request: clientTransferRequestSchema,
  resources: resourcesSchema, adminId: opaqueIdSchema, data: stateSchema, sessions: z.array(row),
}).strict();
export type ClientTransferSnapshot = z.infer<typeof clientTransferSnapshotSchema>;
type State = z.infer<typeof stateSchema>;
// Explicit projections keep tokens/password material out of snapshots and scans.
const fields = ["PK", "SK", "issuer", "sub", "adminId", "ownerType", "organizationId", "userId", "status", "email", "normalizedEmail", "currentIssuer", "currentSub", "cognitoUsername", "revision", "invitationId", "phase", "expiresAt", "displayName"];
const sessionFields = ["PK", "SK", "issuer", "sub", "sessionIdHash", "revokedAt", "absoluteExpiresAt"];
const sort = (rows: Row[]) => rows.sort((a, b) => `${a.PK}:${a.SK}`.localeCompare(`${b.PK}:${b.SK}`));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (snapshot: ClientTransferSnapshot) => sha256(canonical(snapshot));
function requireState(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function projection(names: string[]) {
  const aliases = Object.fromEntries(names.map((name, index) => [`#p${index}`, name]));
  return { ProjectionExpression: Object.keys(aliases).join(", "), ExpressionAttributeNames: aliases };
}

/** Operator-only recovery exception. Ordinary invitations still cannot move ownership. */
export class ClientOrganizationTransfer {
  private readonly directory: AdministratorDirectory;
  constructor(private readonly config: SetupConfiguration, private readonly document: DynamoDBDocumentClient, private readonly cognito: CognitoIdentityProviderClient) {
    this.directory = new AdministratorDirectory({ issuer: `https://cognito-idp.${config.context.region}.amazonaws.com/${config.adminPool}`,
      clientPoolId: config.context.clientPool, identityTable: config.identityTable, controlTable: config.adminControlTable, auditTable: config.auditTable }, document, cognito);
  }
  private get resources() {
    const c = this.config; const x = c.context;
    return { environment: x.environment, accountId: x.accountId, region: x.region, operatorArn: x.operatorArn, identityTable: c.identityTable, tenantTable: x.tenantTable,
      sessionTable: c.sessionTable, controlTable: c.adminControlTable, auditTable: c.auditTable, clientPool: x.clientPool, adminPool: c.adminPool, issuer: c.issuer };
  }
  private assertRequest(request: ClientTransferRequest) {
    requireState(request.environment === this.config.context.environment && request.accountId === this.config.context.accountId, "Request AWS account/environment does not match discovery");
    requireState(request.client.sourceOrganizationId !== request.client.targetOrganizationId, "Source and destination must differ");
    requireState([request.client.email, request.administrator.email].every((email) => email === email.trim().toLowerCase()) && request.client.email !== request.administrator.email, "Use distinct normalized client/administrator emails");
  }
  private async authorize(request: ClientTransferRequest, adminId?: string) {
    const active = await this.directory.authorize(request.administrator.sub);
    const user = await this.directory.currentUser(request.administrator.sub);
    requireState(user.UserAttributes?.find((attribute) => attribute.Name === "email")?.Value?.toLowerCase() === request.administrator.email
      && (!adminId || active.identity.adminId === adminId), "Initiating administrator changed");
    return { actor: { adminId: active.identity.adminId, sub: request.administrator.sub, requestId: "" }, count: active.count };
  }
  private async get(table: string, key: Key, projected = true): Promise<Row | null> {
    return (await this.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true, ...(projected ? projection(fields) : {}) }))).Item ?? null;
  }
  private async scan(table: string, selectedFields = fields): Promise<Row[]> {
    const rows: Row[] = []; let next: Row | undefined;
    do {
      const page = await this.document.send(new ScanCommand({ TableName: table, ConsistentRead: true, ...projection(selectedFields), ...(next ? { ExclusiveStartKey: next } : {}) }));
      rows.push(...page.Items ?? []); next = page.LastEvaluatedKey;
    } while (next);
    return sort(rows);
  }
  private async user(request: ClientTransferRequest) {
    const result = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: this.config.context.clientPool, Username: request.client.sub }));
    const user = userSchema.parse({ username: result.Username, sub: result.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value,
      email: result.UserAttributes?.find((attribute) => attribute.Name === "email")?.Value?.toLowerCase(), enabled: result.Enabled, status: result.UserStatus });
    requireState(user.sub === request.client.sub && user.email === request.client.email, "Cognito account changed; stop");
    return user;
  }
  private targetUserId(request: ClientTransferRequest) { return `usr${sha256(`${request.client.targetOrganizationId}:${request.client.email}`).slice(0, 29)}`; }
  private subject(request: ClientTransferRequest) { return identityKeys.subject(this.config.issuer, request.client.sub); }
  private membership(request: ClientTransferRequest) { return tenantKeys.user(request.client.sourceOrganizationId, request.client.sourceUserId); }
  private targetKey(request: ClientTransferRequest) { return tenantKeys.user(request.client.targetOrganizationId, this.targetUserId(request)); }
  private async state(request: ClientTransferRequest): Promise<State> {
    const [identities, tenant, user] = await Promise.all([this.scan(this.config.identityTable), this.scan(this.config.context.tenantTable), this.user(request)]);
    const key = this.subject(request);
    const matches = identities.filter((item) => String(item.PK).startsWith("SUBJECT#") && item.sub === request.client.sub);
    requireState(matches.length === 1 && matches[0]?.PK === key.PK && matches[0]?.SK === key.SK && !matches[0]?.adminId, "Subject identity is missing, duplicated, or an administrator");
    const identity = matches[0]!; clientIdentitySchema.parse(identity);
    const reservation = identities.find((item) => item.PK === identityKeys.emailReservation(request.client.email).PK && item.SK === "RESERVATION");
    requireState(reservation && reservation.normalizedEmail === request.client.email && !reservation.adminId && (!reservation.ownerType || reservation.ownerType === "CLIENT"), "Email reservation is missing or conflicting");
    const memberships = tenant.filter((item) => String(item.SK).startsWith("USER#") && (item.currentSub === request.client.sub || item.normalizedEmail === request.client.email));
    requireState(memberships.length > 0 && memberships.length <= 21, "Unexpected membership count");
    for (const member of memberships) {
      const parsed = clientUserSchema.extend({ revision: z.string().min(1) }).parse(member);
      requireState(member.PK === tenantKeys.user(parsed.organizationId, parsed.userId).PK && member.SK === `USER#${parsed.userId}`
        && parsed.currentIssuer === this.config.issuer && parsed.currentSub === request.client.sub && parsed.normalizedEmail === request.client.email
        && parsed.email.toLowerCase() === request.client.email && parsed.cognitoUsername === user.username, "Membership has conflicting ownership");
    }
    const organizations = [request.client.sourceOrganizationId, request.client.targetOrganizationId].map((organizationId) => {
      const org = tenant.find((item) => item.PK === tenantKeys.organization(organizationId).PK && item.SK === "META");
      requireState(org && organizationSchema.parse(org).organizationId === organizationId && org.status === "ACTIVE", "Source/destination organization missing or inactive");
      return org;
    });
    return stateSchema.parse({ user, identity, reservation, memberships, organizations });
  }
  private async sessions(request: ClientTransferRequest) {
    const subject = this.subject(request);
    return (await this.scan(this.config.sessionTable, sessionFields)).filter((item) =>
      item.PK === subject.PK && String(item.SK).startsWith("SESSION#") || item.SK === "SESSION" && item.issuer === this.config.issuer && item.sub === request.client.sub);
  }
  private initial(request: ClientTransferRequest, state: State) {
    const c = request.client; const source = state.memberships.find((item) => item.organizationId === c.sourceOrganizationId && item.userId === c.sourceUserId);
    requireState(state.user.enabled && source?.status === "ACTIVE" && state.identity.status === "ACTIVE" && state.identity.issuer === this.config.issuer
      && state.identity.organizationId === c.sourceOrganizationId && state.identity.userId === c.sourceUserId
      && state.reservation.organizationId === c.sourceOrganizationId && state.reservation.userId === c.sourceUserId, "Source identity/membership/email reservation are not one active owner");
    requireState(state.reservation.phase === undefined || ["INVITED", "ACCEPTED"].includes(String(state.reservation.phase)), "An email reservation workflow is still in progress; reconcile separately");
    requireState(state.memberships.length <= 20 && state.memberships.every((item) => item === source || item.status === "REVOKED")
      && !state.memberships.some((item) => item.organizationId === c.targetOrganizationId), "Conflicting active or destination membership; reconcile separately");
  }
  async preview(input: ClientTransferRequest): Promise<ClientTransferSnapshot> {
    const request = clientTransferRequestSchema.parse(input); this.assertRequest(request);
    const { actor } = await this.authorize(request);
    const data = await this.state(request); this.initial(request, data);
    requireState(!await this.get(this.config.context.tenantTable, this.targetKey(request)), "Destination user ID already exists");
    return { version: 1, operationId: randomUUID(), createdAt: new Date().toISOString(), request, resources: this.resources, adminId: actor.adminId, data, sessions: await this.sessions(request) };
  }
  private condition(table: string, key: Key, expected: Row | null, comparedFields = fields): ConditionalItem {
    if (!expected) return { TableName: table, Key: key, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" };
    const names: Record<string, string> = {}; const values: Row = {}; const clauses: string[] = [];
    for (const [index, field] of comparedFields.entries()) {
      names[`#c${index}`] = field;
      if (field in expected) { values[`:c${index}`] = expected[field]; clauses.push(`#c${index} = :c${index}`); }
      else clauses.push(`attribute_not_exists(#c${index})`);
    }
    return { TableName: table, Key: key, ConditionExpression: clauses.join(" AND "), ExpressionAttributeNames: names, ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) };
  }
  private markerKey(snapshot: ClientTransferSnapshot): Key { return { PK: `CLIENT_TRANSFER#${sha256(this.subject(snapshot.request).PK)}`, SK: `OP#${snapshot.operationId}` }; }
  private lockKey(snapshot: ClientTransferSnapshot): Key { return { ...this.markerKey(snapshot), SK: "LOCK" }; }
  private lockCheck(snapshot: ClientTransferSnapshot, runId: string): Actions[number] {
    return { ConditionCheck: this.condition(this.config.adminControlTable, this.lockKey(snapshot), { runId, digest: digest(snapshot), operationId: snapshot.operationId }, ["runId", "digest", "operationId"]) };
  }
  private marker(snapshot: ClientTransferSnapshot, phase: string): Row { return { ...this.markerKey(snapshot), operationId: snapshot.operationId, digest: digest(snapshot), phase }; }
  private audit(snapshot: ClientTransferSnapshot, actor: AdministratorActor, action: string): Actions[number] {
    const occurredAt = new Date().toISOString(); const eventId = `event_${randomUUID()}`;
    return { Put: { TableName: this.config.auditTable, Item: { ...auditKeys.system(occurredAt, eventId), eventId, occurredAt, ttlExpiresAt: auditExpiresAt(occurredAt),
      action, actorId: actor.adminId, actorSub: actor.sub, requestId: snapshot.operationId,
      target: { sub: snapshot.request.client.sub, email: snapshot.request.client.email, sourceOrganizationId: snapshot.request.client.sourceOrganizationId,
        sourceUserId: snapshot.request.client.sourceUserId, targetOrganizationId: snapshot.request.client.targetOrganizationId, targetUserId: this.targetUserId(snapshot.request) },
      details: { operatorArn: this.config.context.operatorArn, environment: snapshot.request.environment, snapshotDigest: digest(snapshot) } }, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } };
  }
  private afterDenial(snapshot: ClientTransferSnapshot): State {
    const data = structuredClone(snapshot.data);
    data.identity.status = "REVOKED";
    const source = data.memberships.find((item) => item.organizationId === snapshot.request.client.sourceOrganizationId && item.userId === snapshot.request.client.sourceUserId)!;
    source.status = "REVOKED"; source.revision = `rev_transfer_${snapshot.operationId}`;
    return data;
  }
  private targetMember(snapshot: ClientTransferSnapshot): Row {
    const c = snapshot.request.client;
    return { ...this.targetKey(snapshot.request), organizationId: c.targetOrganizationId, userId: this.targetUserId(snapshot.request), email: c.email, normalizedEmail: c.email,
      currentIssuer: this.config.issuer, currentSub: c.sub, cognitoUsername: snapshot.data.user.username, status: "ACTIVE", revision: `rev_transfer_${snapshot.operationId}` };
  }
  private afterMove(snapshot: ClientTransferSnapshot): State {
    const data = this.afterDenial(snapshot); const c = snapshot.request.client;
    Object.assign(data.identity, { organizationId: c.targetOrganizationId, userId: this.targetUserId(snapshot.request), status: "ACTIVE", invitationId: null });
    data.reservation = { ...identityKeys.emailReservation(c.email), normalizedEmail: c.email, organizationId: c.targetOrganizationId, userId: this.targetUserId(snapshot.request), revision: `rev_transfer_${snapshot.operationId}` };
    data.memberships = sort([...data.memberships, this.targetMember(snapshot)]);
    return data;
  }
  private sameState(actual: State, expected: State, ignoreEnabled = false) {
    const comparable = structuredClone(actual);
    if (ignoreEnabled) comparable.user.enabled = expected.user.enabled;
    requireState(isDeepStrictEqual(comparable, expected), "Account state changed since preview/checkpoint; stop and inspect");
  }
  private stateChecks(state: State, omitSource?: Key): Actions {
    return [
      ...state.organizations.map((item) => ({ ConditionCheck: this.condition(this.config.context.tenantTable, { PK: String(item.PK), SK: String(item.SK) }, item) })),
      ...state.memberships.filter((item) => !omitSource || item.PK !== omitSource.PK || item.SK !== omitSource.SK)
        .map((item) => ({ ConditionCheck: this.condition(this.config.context.tenantTable, { PK: String(item.PK), SK: String(item.SK) }, item) })),
    ];
  }
  private async cleanSessions(snapshot: ClientTransferSnapshot, actor: AdministratorActor) {
    const c = snapshot.request.client;
    await revokeClientAccess({ identityTable: this.config.identityTable, tenantTable: this.config.context.tenantTable, sessionTable: this.config.sessionTable, auditTable: this.config.auditTable,
      clientPoolId: this.config.context.clientPool, clientIssuer: this.config.issuer }, c.sourceOrganizationId, c.sourceUserId, `rev_transfer_${snapshot.operationId}`, actor, this.document, this.cognito);
    // Also revoke orphan canonical sessions not reachable through subject pointers.
    for (const session of await this.sessions(snapshot.request)) {
      if (session.revokedAt !== undefined && session.revokedAt !== null) {
        requireState(z.iso.datetime().safeParse(session.revokedAt).success, "Malformed session revocation; access remains denied");
        continue;
      }
      requireState(session.SK === "SESSION" && typeof session.sessionIdHash === "string" && /^[a-f0-9]{64}$/.test(session.sessionIdHash)
        && session.PK === `SESSION#${session.sessionIdHash}`, "Unrevoked or malformed session pointer; stop");
      try {
        await this.document.send(new UpdateCommand({ TableName: this.config.sessionTable, Key: { PK: String(session.PK), SK: "SESSION" }, UpdateExpression: "SET revokedAt = :at",
          ConditionExpression: "issuer = :issuer AND #sub = :sub AND (attribute_not_exists(revokedAt) OR revokedAt = :null)", ExpressionAttributeNames: { "#sub": "sub" },
          ExpressionAttributeValues: { ":issuer": this.config.issuer, ":sub": c.sub, ":null": null, ":at": new Date().toISOString() } }));
      } catch (error) { if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error; }
    }
    requireState((await this.sessions(snapshot.request)).every((item) => z.iso.datetime().safeParse(item.revokedAt).success), "Session cleanup incomplete; access remains denied");
    requireState(!(await this.user(snapshot.request)).enabled, "Cognito cleanup incomplete; account must be disabled before transfer");
  }
  async apply(input: ClientTransferSnapshot, recoverLock?: string): Promise<void> {
    const snapshot = clientTransferSnapshotSchema.parse(input); this.assertRequest(snapshot.request);
    requireState(isDeepStrictEqual(snapshot.resources, this.resources), "Snapshot resources/operator do not match discovery");
    this.initial(snapshot.request, snapshot.data);
    const authorization = await this.authorize(snapshot.request, snapshot.adminId);
    const actor = { ...authorization.actor, requestId: snapshot.operationId }; const runId = randomUUID(); const lockKey = this.lockKey(snapshot);
    const previousLock = await this.get(this.config.adminControlTable, lockKey, false);
    if (recoverLock) requireState(previousLock?.runId === recoverLock && previousLock.operationId === snapshot.operationId && previousLock.digest === digest(snapshot), "Recovery lock does not match this operation");
    else requireState(!previousLock, `Transfer is locked by run ${String(previousLock?.runId)}. Stop the old process before explicit --recover-lock RUN_ID`);
    const { Key: _lockKey, ...lockCondition } = recoverLock ? this.condition(this.config.adminControlTable, lockKey, previousLock, ["runId", "operationId", "digest"])
      : this.condition(this.config.adminControlTable, lockKey, null);
    await this.document.send(new PutCommand({ ...lockCondition, Item: { ...lockKey, runId, operationId: snapshot.operationId, digest: digest(snapshot), startedAt: new Date().toISOString() } }));
    try {
      let checkpoint = await this.get(this.config.adminControlTable, this.markerKey(snapshot), false);
      if (checkpoint) requireState(checkpoint.digest === digest(snapshot) && checkpoint.operationId === snapshot.operationId && ["DENIED", "MOVED", "DONE"].includes(String(checkpoint.phase)), "Transfer checkpoint conflicts with snapshot");
      if (!checkpoint) {
        const current = await this.state(snapshot.request); this.sameState(current, snapshot.data);
        requireState(!await this.get(this.config.context.tenantTable, this.targetKey(snapshot.request)), "Destination user ID already exists");
        const source = this.membership(snapshot.request); const member = current.memberships.find((item) => item.PK === source.PK && item.SK === source.SK)!;
        await this.document.send(new TransactWriteCommand({ TransactItems: [
          this.lockCheck(snapshot, runId), ...this.directory.writeChecks(actor, authorization.count), ...this.stateChecks(current, source),
          { ConditionCheck: this.condition(this.config.context.tenantTable, this.targetKey(snapshot.request), null) },
          { ConditionCheck: this.condition(this.config.identityTable, identityKeys.emailReservation(snapshot.request.client.email), current.reservation) },
          { Update: { ...this.condition(this.config.context.tenantTable, source, member), UpdateExpression: "SET #s = :s, #r = :r",
            ExpressionAttributeNames: { ...this.condition(this.config.context.tenantTable, source, member).ExpressionAttributeNames, "#s": "status", "#r": "revision" },
            ExpressionAttributeValues: { ...this.condition(this.config.context.tenantTable, source, member).ExpressionAttributeValues, ":s": "REVOKED", ":r": `rev_transfer_${snapshot.operationId}` } } },
          { Update: { ...this.condition(this.config.identityTable, this.subject(snapshot.request), current.identity), UpdateExpression: "SET #s = :s",
            ExpressionAttributeNames: { ...this.condition(this.config.identityTable, this.subject(snapshot.request), current.identity).ExpressionAttributeNames, "#s": "status" },
            ExpressionAttributeValues: { ...this.condition(this.config.identityTable, this.subject(snapshot.request), current.identity).ExpressionAttributeValues, ":s": "REVOKED" } } },
          { Put: { TableName: this.config.adminControlTable, Item: this.marker(snapshot, "DENIED"), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
          this.audit(snapshot, actor, "CLIENT_TRANSFER_ACCESS_DENIED"),
        ] }));
        checkpoint = this.marker(snapshot, "DENIED");
      }
      if (checkpoint.phase === "DENIED") {
        this.sameState(await this.state(snapshot.request), this.afterDenial(snapshot), true);
        await this.cleanSessions(snapshot, actor);
        const current = await this.state(snapshot.request); this.sameState(current, this.afterDenial(snapshot), true);
        const active = await this.authorize(snapshot.request, snapshot.adminId); const after = this.afterMove(snapshot);
        const identityCondition = this.condition(this.config.identityTable, this.subject(snapshot.request), current.identity);
        const reservationCondition = this.condition(this.config.identityTable, identityKeys.emailReservation(snapshot.request.client.email), current.reservation);
        const { Key: _reservationKey, ...reservationPut } = reservationCondition;
        await this.document.send(new TransactWriteCommand({ TransactItems: [
          this.lockCheck(snapshot, runId), ...this.directory.writeChecks(actor, active.count), ...this.stateChecks(current),
          { Put: { TableName: this.config.context.tenantTable, Item: this.targetMember(snapshot), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
          { Update: { ...identityCondition, UpdateExpression: "SET organizationId = :org, userId = :user, #s = :s, invitationId = :null",
            ExpressionAttributeNames: { ...identityCondition.ExpressionAttributeNames, "#s": "status" },
            ExpressionAttributeValues: { ...identityCondition.ExpressionAttributeValues, ":org": snapshot.request.client.targetOrganizationId, ":user": this.targetUserId(snapshot.request), ":s": "ACTIVE", ":null": null } } },
          { Put: { ...reservationPut, Item: after.reservation } },
          { Put: { ...this.markerCondition(snapshot, "DENIED"), Item: this.marker(snapshot, "MOVED") } },
          this.audit(snapshot, actor, "CLIENT_ORGANIZATION_TRANSFERRED"),
        ] }));
        checkpoint = this.marker(snapshot, "MOVED");
      }
      this.sameState(await this.state(snapshot.request), this.afterMove(snapshot), true);
      if (checkpoint.phase === "DONE") {
        requireState((await this.user(snapshot.request)).enabled, "Completed transfer account was subsequently disabled; inspect separately");
        return;
      }
      // No old-session cleanup after MOVED: a retry must preserve legitimate new logins.
      const active = await this.authorize(snapshot.request, snapshot.adminId);
      if (!(await this.user(snapshot.request)).enabled) await this.cognito.send(new AdminEnableUserCommand({ UserPoolId: this.config.context.clientPool, Username: snapshot.data.user.username }));
      requireState((await this.user(snapshot.request)).enabled, "Transfer is recorded but Cognito enablement requires retry");
      this.sameState(await this.state(snapshot.request), this.afterMove(snapshot), true);
      await this.document.send(new TransactWriteCommand({ TransactItems: [
        this.lockCheck(snapshot, runId), ...this.directory.writeChecks(actor, active.count), ...this.stateChecks(this.afterMove(snapshot)),
        { ConditionCheck: this.condition(this.config.identityTable, this.subject(snapshot.request), this.afterMove(snapshot).identity) },
        { ConditionCheck: this.condition(this.config.identityTable, identityKeys.emailReservation(snapshot.request.client.email), this.afterMove(snapshot).reservation) },
        { Put: { ...this.markerCondition(snapshot, "MOVED"), Item: this.marker(snapshot, "DONE") } }, this.audit(snapshot, actor, "CLIENT_TRANSFER_COMPLETED"),
      ] }));
    } finally {
      // No expiry: a crashed process cannot overlap a replacement's Cognito calls.
      await this.document.send(new DeleteCommand({ TableName: this.config.adminControlTable, Key: lockKey, ConditionExpression: "runId = :run", ExpressionAttributeValues: { ":run": runId } }));
    }
  }
  private markerCondition(snapshot: ClientTransferSnapshot, phase: string) {
    const { Key: _key, ...condition } = this.condition(this.config.adminControlTable, this.markerKey(snapshot), this.marker(snapshot, phase), ["PK", "SK", "operationId", "digest", "phase"]);
    return condition;
  }
}
