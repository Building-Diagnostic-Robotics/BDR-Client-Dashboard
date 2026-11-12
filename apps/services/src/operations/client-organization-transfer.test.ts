import { isDeepStrictEqual } from "node:util";
import { AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { identityKeys, tenantKeys } from "@bdr/domain";
import { afterEach, expect, it, vi } from "vitest";
import { ClientOrganizationTransfer, type ClientTransferRequest } from "./client-organization-transfer";
import type { SetupConfiguration } from "./sample-dashboard-aws";

type Row = Record<string, unknown>;
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/client-pool";
const adminIssuer = "https://cognito-idp.us-east-1.amazonaws.com/admin-pool";
const sub = "client-subject"; const adminSub = "admin-subject";
const email = "client@example.com"; const adminId = "admin_0123456789abcdef";
const sourceOrg = "org_source_0123456789"; const targetOrg = "org_target_0123456789"; const sourceUser = "usr_source_0123456789";
const historicalOrg = "org_history_0123456789"; const historicalUser = "usr_history_0123456789";
const config: SetupConfiguration = { issuer, adminPool: "admin-pool", identityTable: "identity", sessionTable: "sessions", adminControlTable: "control", auditTable: "audit",
  context: { environment: "production", accountId: "123456789012", region: "us-east-1", clientPool: "client-pool", tenantTable: "tenant", clientPrefix: "unused", organizationId: "unused", bucket: "unused", portalOrigin: "https://portal.example.com", operatorArn: "arn:aws:iam::123456789012:user/operator" } };
const request: ClientTransferRequest = { environment: "production", accountId: "123456789012", administrator: { email: "admin@example.com", sub: adminSub },
  client: { email, sub, sourceOrganizationId: sourceOrg, sourceUserId: sourceUser, targetOrganizationId: targetOrg } };
afterEach(() => vi.restoreAllMocks());

function harness() {
  const tables = new Map<string, Map<string, Row>>(); const id = (key: Row) => `${key.PK}:${key.SK}`;
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  const put = (name: string, item: Row) => table(name).set(id(item), structuredClone(item));
  const read = (name: string, key: Row) => table(name).get(id(key));
  const all = (name: string) => [...table(name).values()];
  put("identity", { ...identityKeys.adminGuard(), activeAdminCount: 1 });
  put("identity", { ...identityKeys.adminProfile(adminId), adminId, status: "ACTIVE", role: "BDR_ADMIN", totpEnrolled: true });
  put("identity", { ...identityKeys.subject(adminIssuer, adminSub), issuer: adminIssuer, sub: adminSub, adminId });
  put("identity", { ...identityKeys.subject(issuer, sub), issuer, sub, organizationId: sourceOrg, userId: sourceUser, status: "ACTIVE", invitationId: "inv_old_0123456789" });
  put("identity", { ...identityKeys.emailReservation(email), normalizedEmail: email, organizationId: sourceOrg, userId: sourceUser, invitationId: "inv_old_0123456789", phase: "INVITED" });
  for (const [organizationId, displayName] of [[sourceOrg, "Source Company"], [targetOrg, "Target Company"]]) put("tenant", { ...tenantKeys.organization(organizationId!), organizationId, displayName, status: "ACTIVE" });
  for (const [organizationId, userId, status] of [[sourceOrg, sourceUser, "ACTIVE"], [historicalOrg, historicalUser, "REVOKED"]]) {
    put("tenant", { ...tenantKeys.user(organizationId!, userId!), organizationId, userId, email, normalizedEmail: email, currentIssuer: issuer, currentSub: sub, cognitoUsername: sub, status, revision: "rev_original" });
  }
  for (const suffix of ["a", "b", "c", "f"]) {
    const hash = suffix.repeat(64);
    put("sessions", { PK: `SESSION#${hash}`, SK: "SESSION", issuer, sub, sessionIdHash: hash, revokedAt: null, absoluteExpiresAt: "2030-01-01T00:00:00.000Z", accessTokenCiphertext: "NEVER_SNAPSHOT_ACCESS", refreshTokenCiphertext: "NEVER_SNAPSHOT_REFRESH" });
    if (suffix !== "c") put("sessions", { PK: identityKeys.subject(issuer, sub).PK, SK: `SESSION#${hash}`, sessionIdHash: hash, revokedAt: null });
  }
  put("sessions", { PK: `SESSION#${"d".repeat(64)}`, SK: "SESSION", issuer, sub: "someone-else", sessionIdHash: "d".repeat(64), revokedAt: null });
  const faults = { cleanup: false, session: false, beforePhase: "", afterPhase: "", enableAfterCommit: false, releaseLock: false, noAdminGroup: false };
  let onMove: (() => void) | undefined;
  const user = { enabled: true, status: "CONFIRMED", email, sub, username: sub, password: "unchanged-sentinel" };
  const order: string[] = [];
  const failure = () => Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
  const field = (name: string, names: Record<string, string> = {}) => names[name] ?? name;
  // Minimal DynamoDB condition interpreter: conditions are evaluated before any transaction changes.
  function condition(expression: string, item: Row | undefined, names: Record<string, string> = {}, values: Row = {}): boolean {
    let text = expression.trim();
    if (text.startsWith("(")) {
      let depth = 0; let closesAtEnd = false;
      for (let i = 0; i < text.length; i++) { if (text[i] === "(") depth++; if (text[i] === ")") depth--; if (depth === 0) { closesAtEnd = i === text.length - 1; break; } }
      if (closesAtEnd) text = text.slice(1, -1);
    }
    for (const operator of [" OR ", " AND "]) {
      let depth = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "(") depth++; if (text[i] === ")") depth--;
        if (depth === 0 && text.slice(i, i + operator.length) === operator) {
          const left = condition(text.slice(0, i), item, names, values); const right = condition(text.slice(i + operator.length), item, names, values);
          return operator === " OR " ? left || right : left && right;
        }
      }
    }
    const exists = /^attribute_(not_)?exists\(([^)]+)\)$/.exec(text);
    if (exists) return exists[1] ? item?.[field(exists[2]!, names)] === undefined : item?.[field(exists[2]!, names)] !== undefined;
    const equal = /^(\S+) = (:\S+)$/.exec(text);
    if (equal) return isDeepStrictEqual(item?.[field(equal[1]!, names)], values[equal[2]!]);
    throw new Error(`Unsupported mock condition: ${text}`);
  }
  function update(item: Row, expression: string, names: Record<string, string> = {}, values: Row = {}) {
    const result = { ...item };
    for (const assignment of expression.replace(/^SET /, "").split(", ")) {
      const [name, value] = assignment.split(" = "); result[field(name!, names)] = values[value!];
    }
    return result;
  }
  function projected(item: Row, input: { ProjectionExpression?: string | undefined; ExpressionAttributeNames?: Record<string, string> | undefined }) {
    if (!input.ProjectionExpression) return structuredClone(item);
    return Object.fromEntries(input.ProjectionExpression.split(", ").map((name) => field(name, input.ExpressionAttributeNames)).filter((name) => name in item).map((name) => [name, structuredClone(item[name])]));
  }
  const document = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) { const item = read(command.input.TableName!, command.input.Key!); return { ...(item ? { Item: projected(item, command.input) } : {}) } as never; }
    if (command instanceof ScanCommand || command instanceof QueryCommand) {
      const input = command.input; let items = all(input.TableName!).sort((a, b) => id(a).localeCompare(id(b)));
      if (command instanceof QueryCommand) items = items.filter((item) => item.PK === input.ExpressionAttributeValues?.[":pk"] && String(item.SK).startsWith("SESSION#"));
      const start = input.ExclusiveStartKey ? items.findIndex((item) => id(item) === id(input.ExclusiveStartKey!)) + 1 : 0;
      const page = items.slice(start, start + 2);
      return { Items: page.map((item) => projected(item, input)), ...(start + 2 < items.length ? { LastEvaluatedKey: { PK: page[1]!.PK, SK: page[1]!.SK } } : {}) } as never;
    }
    if (command instanceof PutCommand || command instanceof DeleteCommand || command instanceof UpdateCommand) {
      const input = command.input; const key = command instanceof PutCommand ? command.input.Item! : command.input.Key!;
      if (command instanceof UpdateCommand && input.TableName === "sessions" && faults.session) { faults.session = false; throw new Error("session storage unavailable"); }
      if (command instanceof DeleteCommand && faults.releaseLock) { faults.releaseLock = false; throw new Error("lock release unavailable"); }
      if (input.ConditionExpression && !condition(input.ConditionExpression, read(input.TableName!, key), input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw failure();
      if (command instanceof PutCommand) put(input.TableName!, command.input.Item!);
      if (command instanceof DeleteCommand) table(input.TableName!).delete(id(key));
      if (command instanceof UpdateCommand) put(input.TableName!, update(read(input.TableName!, key)!, command.input.UpdateExpression!, input.ExpressionAttributeNames, input.ExpressionAttributeValues));
      return {} as never;
    }
    if (command instanceof TransactWriteCommand) {
      const actions = command.input.TransactItems ?? [];
      const phase = String(actions.find((item) => item.Put?.TableName === "control")?.Put?.Item?.phase ?? "");
      if (phase === "MOVED") onMove?.();
      if (faults.beforePhase === phase) { faults.beforePhase = ""; throw new Error("conditional transaction rejected"); }
      const seen = new Set<string>();
      for (const action of actions) {
        const input = action.Put ?? action.Update ?? action.ConditionCheck!;
        const key = action.Put ? action.Put.Item! : (action.Update ?? action.ConditionCheck!).Key!;
        const unique = `${input.TableName}:${id(key)}`;
        if (seen.has(unique)) throw new Error("Transaction touches an item twice"); seen.add(unique);
        if (input.ConditionExpression && !condition(input.ConditionExpression, read(input.TableName!, key), input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw failure();
      }
      for (const action of actions) {
        if (action.Put) put(action.Put.TableName!, action.Put.Item!);
        if (action.Update) { const input = action.Update; put(input.TableName!, update(read(input.TableName!, input.Key!)!, input.UpdateExpression!, input.ExpressionAttributeNames, input.ExpressionAttributeValues)); }
      }
      order.push(phase);
      if (faults.afterPhase === phase) { faults.afterPhase = ""; throw new Error("response lost after commit"); }
      return {} as never;
    }
    throw new Error("Unexpected document command");
  });
  const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof AdminGetUserCommand) {
      if (command.input.Username === adminSub) return { Username: adminSub, Enabled: true, UserStatus: "CONFIRMED", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"], UserAttributes: [{ Name: "sub", Value: adminSub }, { Name: "email", Value: "admin@example.com" }] } as never;
      return { Username: user.username, Enabled: user.enabled, UserStatus: user.status, UserAttributes: [{ Name: "sub", Value: user.sub }, { Name: "email", Value: user.email }] } as never;
    }
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: faults.noAdminGroup ? [] : [{ GroupName: "bdr-admins" }] } as never;
    if (command instanceof AdminUserGlobalSignOutCommand || command instanceof AdminDisableUserCommand) {
      if (faults.cleanup) { faults.cleanup = false; throw new Error("Cognito unavailable"); }
      if (command instanceof AdminDisableUserCommand) { user.enabled = false; order.push("disabled"); }
      else order.push("signout");
      return {} as never;
    }
    if (command instanceof AdminEnableUserCommand) {
      user.enabled = true; order.push("enabled");
      if (faults.enableAfterCommit) { faults.enableAfterCommit = false; throw new Error("enable response lost"); }
      return {} as never;
    }
    throw new Error("Unexpected Cognito mutation");
  });
  return { tool: new ClientOrganizationTransfer(config, Object.create(DynamoDBDocumentClient.prototype) as DynamoDBDocumentClient, new CognitoIdentityProviderClient({})),
    read, put, all, user, faults, order, document, cognito, onMove: (callback: () => void) => { onMove = callback; } };
}

it("previews read-only without tokens and transfers only the client after paginated/orphan session cleanup", async () => {
  const h = harness(); const snapshot = await h.tool.preview(request);
  expect(h.document.mock.calls.every(([command]) => command instanceof GetCommand || command instanceof ScanCommand)).toBe(true);
  expect(h.cognito.mock.calls.every(([command]) => command instanceof AdminGetUserCommand || command instanceof AdminListGroupsForUserCommand)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("NEVER_SNAPSHOT");
  const historical = structuredClone(h.read("tenant", tenantKeys.user(historicalOrg, historicalUser)));
  const admin = structuredClone(h.read("identity", identityKeys.adminProfile(adminId)));
  await h.tool.apply(snapshot);
  const identity = h.read("identity", identityKeys.subject(issuer, sub))!;
  expect(identity).toMatchObject({ issuer, sub, organizationId: targetOrg, status: "ACTIVE", invitationId: null });
  expect(identity.userId).not.toBe(sourceUser);
  expect(h.read("tenant", tenantKeys.user(sourceOrg, sourceUser))?.status).toBe("REVOKED");
  expect(h.read("tenant", tenantKeys.user(targetOrg, String(identity.userId)))).toMatchObject({ email, status: "ACTIVE", currentSub: sub });
  expect(h.read("identity", identityKeys.emailReservation(email))).toMatchObject({ organizationId: targetOrg, userId: identity.userId });
  expect(h.read("identity", identityKeys.emailReservation(email))).not.toHaveProperty("invitationId");
  expect(h.read("tenant", tenantKeys.user(historicalOrg, historicalUser))).toEqual(historical);
  expect(h.read("identity", identityKeys.adminProfile(adminId))).toEqual(admin);
  expect(h.read("identity", identityKeys.adminGuard())?.activeAdminCount).toBe(1);
  expect(h.all("sessions").filter((item) => item.sub === sub || item.PK === identityKeys.subject(issuer, sub).PK).every((item) => Boolean(item.revokedAt))).toBe(true);
  expect(h.read("sessions", { PK: `SESSION#${"d".repeat(64)}`, SK: "SESSION" })?.revokedAt).toBeNull();
  expect(h.user).toMatchObject({ enabled: true, password: "unchanged-sentinel", sub });
  expect(h.order).toEqual(["DENIED", "signout", "disabled", "MOVED", "enabled", "DONE"]);
  expect(h.all("audit").map((item) => item.action)).toEqual(["CLIENT_TRANSFER_ACCESS_DENIED", "CLIENT_ORGANIZATION_TRANSFERRED", "CLIENT_TRANSFER_COMPLETED"]);
});

it("rejects stale snapshots, wrong resources, destination memberships and unauthorized administrators", async () => {
  const h = harness(); const snapshot = await h.tool.preview(request);
  await expect(h.tool.apply({ ...snapshot, resources: { ...snapshot.resources, sessionTable: "wrong" } })).rejects.toThrow("do not match");
  const source = h.read("tenant", tenantKeys.user(sourceOrg, sourceUser))!;
  h.put("tenant", { ...source, revision: "concurrent_change" });
  await expect(h.tool.apply(snapshot)).rejects.toThrow("changed since");
  h.put("tenant", source);
  h.put("tenant", { ...source, ...tenantKeys.user(targetOrg, historicalUser), organizationId: targetOrg, userId: historicalUser, status: "REVOKED" });
  await expect(h.tool.preview(request)).rejects.toThrow("destination membership");
  h.faults.noAdminGroup = true;
  await expect(h.tool.apply(snapshot)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(h.cognito.mock.calls.some(([command]) => command instanceof AdminDisableUserCommand)).toBe(false);
  expect(h.all("audit")).toHaveLength(0);
});

it.each(["cleanup", "session"] as const)("leaves access denied on %s failure and resumes the same operation", async (fault) => {
  const h = harness(); const snapshot = await h.tool.preview(request); h.faults[fault] = true;
  await expect(h.tool.apply(snapshot)).rejects.toThrow("access is revoked");
  expect(h.read("identity", identityKeys.subject(issuer, sub))).toMatchObject({ status: "REVOKED", organizationId: sourceOrg });
  expect(h.all("tenant").some((item) => item.organizationId === targetOrg && String(item.SK).startsWith("USER#"))).toBe(false);
  await h.tool.apply(snapshot);
  expect(h.read("identity", identityKeys.subject(issuer, sub))).toMatchObject({ status: "ACTIVE", organizationId: targetOrg });
});

it.each(["DENIED", "MOVED", "DONE"])("resumes an uncertain committed %s transaction without duplicating ownership/audits", async (phase) => {
  const h = harness(); const snapshot = await h.tool.preview(request); h.faults.afterPhase = phase;
  await expect(h.tool.apply(snapshot)).rejects.toThrow("response lost");
  await h.tool.apply(snapshot);
  expect(h.all("audit")).toHaveLength(3);
  expect(h.all("tenant").filter((item) => item.organizationId === targetOrg && item.status === "ACTIVE" && String(item.SK).startsWith("USER#"))).toHaveLength(1);
  expect(h.user.enabled).toBe(true);
});

it("conditional ownership conflicts cannot grant access or re-enable the account", async () => {
  const h = harness(); const snapshot = await h.tool.preview(request);
  h.onMove(() => h.put("identity", { ...h.read("identity", identityKeys.emailReservation(email)), organizationId: "org_conflict_0123456789" }));
  await expect(h.tool.apply(snapshot)).rejects.toThrow("condition failed");
  expect(h.user.enabled).toBe(false);
  expect(h.read("identity", identityKeys.subject(issuer, sub))?.status).toBe("REVOKED");
  expect(h.cognito.mock.calls.some(([command]) => command instanceof AdminEnableUserCommand)).toBe(false);
});

it("a rejected denial transaction does not sign out or disable an unchanged source account", async () => {
  const h = harness(); const snapshot = await h.tool.preview(request); h.faults.beforePhase = "DENIED";
  await expect(h.tool.apply(snapshot)).rejects.toThrow("transaction rejected");
  expect(h.read("identity", identityKeys.subject(issuer, sub))).toMatchObject({ status: "ACTIVE", organizationId: sourceOrg });
  expect(h.user.enabled).toBe(true);
  expect(h.all("audit")).toHaveLength(0);
  expect(h.cognito.mock.calls.some(([command]) => command instanceof AdminUserGlobalSignOutCommand)).toBe(false);
});

it("does not grant destination access when a session has malformed revocation metadata", async () => {
  const h = harness(); const snapshot = await h.tool.preview(request);
  const orphanKey = { PK: `SESSION#${"c".repeat(64)}`, SK: "SESSION" };
  h.put("sessions", { ...h.read("sessions", orphanKey), revokedAt: "invalid" });
  await expect(h.tool.apply(snapshot)).rejects.toThrow("Malformed session revocation");
  expect(h.user.enabled).toBe(false);
  expect(h.read("identity", identityKeys.subject(issuer, sub))?.status).toBe("REVOKED");
});

it("does not rerun cleanup after an uncertain enable, preserving new destination sessions", async () => {
  const h = harness(); const snapshot = await h.tool.preview(request); h.faults.enableAfterCommit = true;
  await expect(h.tool.apply(snapshot)).rejects.toThrow("enable response lost");
  h.put("sessions", { PK: `SESSION#${"e".repeat(64)}`, SK: "SESSION", issuer, sub, sessionIdHash: "e".repeat(64), revokedAt: null });
  await h.tool.apply(snapshot); await h.tool.apply(snapshot);
  expect(h.read("sessions", { PK: `SESSION#${"e".repeat(64)}`, SK: "SESSION" })?.revokedAt).toBeNull();
  expect(h.cognito.mock.calls.filter(([command]) => command instanceof AdminUserGlobalSignOutCommand)).toHaveLength(1);
});

it("keeps a crashed run locked until explicit matching recovery and never silently steals a lock", async () => {
  const h = harness(); const snapshot = await h.tool.preview(request); h.faults.releaseLock = true;
  await expect(h.tool.apply(snapshot)).rejects.toThrow("lock release unavailable");
  const lock = h.all("control").find((item) => item.SK === "LOCK")!;
  await expect(h.tool.apply(snapshot)).rejects.toThrow("locked by run");
  await expect(h.tool.apply(snapshot, "wrong-run")).rejects.toThrow("Recovery lock");
  await expect(h.tool.apply(snapshot, String(lock.runId))).resolves.toBeUndefined();
  expect(h.all("control").some((item) => item.SK === "LOCK")).toBe(false);
});
