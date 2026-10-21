import { AdminDeleteUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { identityKeys, tenantKeys } from "@bdr/domain";
import { afterEach, expect, it, vi } from "vitest";
import { AuthenticationReconciliation, type ReconciliationRequest } from "./authentication-reconciliation";
import type { SetupConfiguration } from "./sample-dashboard-aws";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/client-pool";
const adminIssuer = "https://cognito-idp.us-east-1.amazonaws.com/admin-pool";
const clientSub = "00000000-0000-4000-8000-000000000001";
const adminSub = "00000000-0000-4000-8000-000000000002";
const pendingSub = "00000000-0000-4000-8000-000000000003";
const adminId = "admin_0123456789abcdef";
const email = "client@example.com";
const org = "org_current_0123456789"; const userId = "usr_current_0123456789";
const oldOrg = "org_previous_0123456789"; const oldUser = "usr_previous_0123456789";
const config: SetupConfiguration = { issuer, adminPool: "admin-pool", identityTable: "identity", sessionTable: "sessions", adminControlTable: "control", auditTable: "audit",
  context: { environment: "production", accountId: "123456789012", region: "us-east-1", clientPool: "client-pool", tenantTable: "tenant", clientPrefix: "unused", organizationId: org, bucket: "reports", portalOrigin: "https://portal.example.com", operatorArn: "arn:aws:iam::123456789012:user/operator" } };
const request: ReconciliationRequest = { environment: "production", accountId: "123456789012", client: { email, sub: clientSub, keepOrganizationId: org, keepUserId: userId, retire: [{ organizationId: oldOrg, userId: oldUser }] },
  restoreAdministrator: { email: "admin@example.com", sub: adminSub, adminId }, deletePendingAdministrators: [{ email: "unfinished@example.com", sub: pendingSub }] };
type Row = Record<string, unknown>;
afterEach(() => vi.restoreAllMocks());
function harness() {
  const tables = new Map<string, Map<string, Row>>(); const id = (key: Row) => `${key.PK}:${key.SK}`;
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  const put = (name: string, item: Row) => table(name).set(id(item), structuredClone(item));
  const read = (name: string, key: Row) => table(name).get(id(key));
  put("identity", { ...identityKeys.adminGuard(), activeAdminCount: 1 });
  put("identity", { ...identityKeys.adminProfile(adminId), adminId, status: "ACTIVE", role: "BDR_ADMIN", totpEnrolled: true });
  put("identity", { ...identityKeys.subject(adminIssuer, adminSub), issuer: adminIssuer, sub: adminSub, organizationId: "bdr_portal_admins", userId: "adm_0123456789abcdef", status: "ACTIVE" });
  put("identity", { ...identityKeys.subject(issuer, clientSub), issuer, sub: clientSub, organizationId: org, userId, status: "ACTIVE", invitationId: null });
  put("identity", { ...identityKeys.emailReservation(email), normalizedEmail: email, organizationId: oldOrg, userId: oldUser, invitationId: "old-invitation" });
  for (const [organizationId, memberId] of [[org, userId], [oldOrg, oldUser]]) {
    put("tenant", { ...tenantKeys.organization(organizationId!), organizationId, status: "ACTIVE" });
    put("tenant", { ...tenantKeys.user(organizationId!, memberId!), organizationId, userId: memberId, normalizedEmail: email, currentIssuer: issuer, currentSub: clientSub, status: "ACTIVE", revision: "rev_original" });
  }
  const users = new Map<string, Row>([
    [clientSub, { email, status: "CONFIRMED", mfa: [] }], [adminSub, { email: "admin@example.com", status: "CONFIRMED", mfa: ["SOFTWARE_TOKEN_MFA"] }], [pendingSub, { email: "unfinished@example.com", status: "FORCE_CHANGE_PASSWORD", mfa: [] }],
  ]);
  const faults = { conditional: false, afterDelete: false };
  const document = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: read(command.input.TableName!, command.input.Key!) } as never;
    if (command instanceof ScanCommand) return { Items: [...table(command.input.TableName!).values()].map((item) => structuredClone(item)) } as never;
    if (command instanceof TransactWriteCommand) {
      if (faults.conditional) throw Object.assign(new Error("snapshot condition failed"), { name: "TransactionCanceledException" });
      if (faults.afterDelete && !users.has(pendingSub)) { faults.afterDelete = false; throw new Error("completion unavailable"); }
      for (const action of command.input.TransactItems ?? []) {
        if (action.Put) put(action.Put.TableName!, action.Put.Item!);
        if (action.Update) {
          const update = action.Update; const item = read(update.TableName!, update.Key!) ?? update.Key!; const values = update.ExpressionAttributeValues!;
          const next = { ...item };
          if (":revoked" in values) { next.status = values[":revoked"]; next.revision = values[":newRevision"]; }
          if (":org" in values) { next.organizationId = values[":org"]; next.userId = values[":user"]; next.normalizedEmail = values[":email"]; delete next.invitationId; }
          if (":restored" in values) next.adminId = values[":restored"];
          if (":done" in values) next.status = values[":done"];
          put(update.TableName!, next);
        }
      }
      return {} as never;
    }
    throw new Error("Unexpected database operation");
  });
  const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "bdr-admins" }] } as never;
    if (command instanceof AdminGetUserCommand) {
      const sub = command.input.Username!; const user = users.get(sub);
      if (!user) throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
      return { Username: sub, Enabled: true, UserStatus: user.status, UserMFASettingList: user.mfa,
        UserAttributes: [{ Name: "sub", Value: sub }, { Name: "email", Value: user.email }] } as never;
    }
    if (command instanceof AdminDeleteUserCommand) { users.delete(command.input.Username!); return {} as never; }
    throw new Error("Unexpected Cognito mutation");
  });
  return { tool: new AuthenticationReconciliation(config, Object.create(DynamoDBDocumentClient.prototype) as DynamoDBDocumentClient, new CognitoIdentityProviderClient({})), users, read, put, faults, document, cognito };
}
it("preview is read-only and apply preserves the current owner, sessions, administrator profile and guard count", async () => {
  const { tool, read, document, cognito } = harness();
  const snapshot = await tool.preview(request);
  expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminDeleteUserCommand)).toBe(false);
  const before = structuredClone(read("identity", identityKeys.subject(issuer, clientSub)));
  await tool.apply(snapshot); await tool.apply(snapshot);
  expect(read("identity", identityKeys.subject(issuer, clientSub))).toEqual(before);
  expect(read("tenant", tenantKeys.user(org, userId))?.status).toBe("ACTIVE");
  expect(read("tenant", tenantKeys.user(oldOrg, oldUser))?.status).toBe("REVOKED");
  expect(read("identity", identityKeys.emailReservation(email))).toMatchObject({ organizationId: org, userId });
  expect(read("identity", identityKeys.subject(adminIssuer, adminSub))?.adminId).toBe(adminId);
  expect(read("identity", identityKeys.adminGuard())?.activeAdminCount).toBe(1);
  expect(cognito.mock.calls.filter(([command]) => command instanceof AdminDeleteUserCommand)).toHaveLength(1);
  const writes = document.mock.calls.flatMap(([command]) => command instanceof TransactWriteCommand ? command.input.TransactItems ?? [] : []);
  expect(writes.some((item) => item.Update?.Key?.PK === "ADMIN_GUARD" || item.Update?.TableName === "sessions")).toBe(false);
  expect(writes.filter((item) => item.Update?.TableName === "tenant").every((item) => item.Update?.ConditionExpression?.includes(" = "))).toBe(true);
});
it("stops before mutations when reviewed state or the selected environment changes", async () => {
  const { tool, read, put, document, cognito } = harness(); const snapshot = await tool.preview(request);
  put("tenant", { ...read("tenant", tenantKeys.user(oldOrg, oldUser)), revision: "changed" });
  await expect(tool.apply(snapshot)).rejects.toThrow("changed since preview");
  await expect(tool.apply({ ...snapshot, request: { ...request, environment: "development" } })).rejects.toThrow("does not match");
  expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminDeleteUserCommand)).toBe(false);
});
it("never deletes an administrator who completed a password or MFA step after preview", async () => {
  const { tool, users, cognito, document } = harness(); const snapshot = await tool.preview(request);
  users.set(pendingSub, { email: "unfinished@example.com", status: "CONFIRMED", mfa: ["SOFTWARE_TOKEN_MFA"] });
  await expect(tool.apply(snapshot)).rejects.toThrow("progressed");
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminDeleteUserCommand)).toBe(false);
  expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
});
it("stops on a conditional repair failure without deleting Cognito users", async () => {
  const { tool, faults, cognito } = harness(); const snapshot = await tool.preview(request); faults.conditional = true;
  await expect(tool.apply(snapshot)).rejects.toThrow("snapshot condition failed");
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminDeleteUserCommand)).toBe(false);
});
it("resumes deletion after Cognito succeeded but completion recording failed, without deleting again", async () => {
  const { tool, faults, cognito } = harness(); const snapshot = await tool.preview(request); faults.afterDelete = true;
  await expect(tool.apply(snapshot)).rejects.toThrow("completion unavailable");
  await expect(tool.apply(snapshot)).resolves.toBeUndefined();
  expect(cognito.mock.calls.filter(([command]) => command instanceof AdminDeleteUserCommand)).toHaveLength(1);
});
it("does not accept a missing user without this operation's deletion intent", async () => {
  const { tool, users, document } = harness(); const snapshot = await tool.preview(request); users.delete(pendingSub);
  await expect(tool.apply(snapshot)).rejects.toThrow("disappeared");
  expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
});
