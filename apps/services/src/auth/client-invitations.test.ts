import { AdminCreateUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { identityKeys, tenantKeys } from "@bdr/domain";
import { afterEach, expect, it, vi } from "vitest";
import { ClientInvitations } from "./client-invitations";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/client-pool";
const adminIssuer = "https://cognito-idp.us-east-1.amazonaws.com/admin-pool";
const config = { issuer, poolId: "client-pool", adminIssuer, identityTable: "identity", tenantTable: "tenant", controlTable: "control", auditTable: "audit" };
const actor = { adminId: "admin_0123456789abcdef", sub: "actor", requestId: "request" };
const email = "client@example.com";
const org = "org_0123456789abcdef";
const existingUserId = "usr_0123456789abcdef";
afterEach(() => vi.restoreAllMocks());
function harness(existing = false) {
  const records = new Map<string, Record<string, unknown>>([
    [identityKeys.subject(adminIssuer, actor.sub).PK, { issuer: adminIssuer, sub: actor.sub, adminId: actor.adminId }],
    [identityKeys.adminProfile(actor.adminId).PK, { adminId: actor.adminId, status: "ACTIVE", role: "BDR_ADMIN", totpEnrolled: true }],
    ["ADMIN_GUARD", { activeAdminCount: 2 }],
    [tenantKeys.organization(org).PK + ":META", { organizationId: org, status: "ACTIVE" }],
  ]);
  if (existing) {
    records.set(identityKeys.subject(issuer, "client-subject").PK, { issuer, sub: "client-subject", organizationId: org, userId: existingUserId, status: "ACTIVE", invitationId: null });
    records.set(`${tenantKeys.user(org, existingUserId).PK}:USER#${existingUserId}`, { organizationId: org, userId: existingUserId, currentIssuer: issuer, currentSub: "client-subject", normalizedEmail: email, status: "ACTIVE" });
    records.set(identityKeys.emailReservation(email).PK, { normalizedEmail: email, organizationId: org, userId: existingUserId });
  }
  const order: string[] = [];
  const faults: { transaction?: number; disabled?: boolean; status?: string } = {}; let writes = 0;
  const document = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key!;
      return { Item: records.get(String(key.PK).startsWith("ORG#") ? `${key.PK}:${key.SK}` : String(key.PK)) } as never;
    }
    if (command instanceof TransactWriteCommand) { if (++writes === faults.transaction) throw new Error("conditional write or database failure"); order.push("transaction"); return {} as never; }
    throw new Error("Unexpected database operation");
  });
  const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "bdr-admins" }] } as never;
    if (command instanceof AdminGetUserCommand) {
      if (command.input.Username === actor.sub) return { Enabled: true, UserStatus: "CONFIRMED", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"], UserAttributes: [{ Name: "sub", Value: actor.sub }] } as never;
      if (existing && command.input.UserPoolId === "client-pool") return { Username: "client-subject", Enabled: !faults.disabled, UserStatus: faults.status ?? "CONFIRMED", UserAttributes: [{ Name: "sub", Value: "client-subject" }, { Name: "email", Value: email }] } as never;
      throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
    }
    if (command instanceof AdminCreateUserCommand) { order.push(command.input.MessageAction!); return { User: { Username: "new-subject", Attributes: [{ Name: "sub", Value: "new-subject" }] } } as never; }
    throw new Error("Unexpected Cognito operation");
  });
  const invitations = new ClientInvitations(config, Object.create(DynamoDBDocumentClient.prototype) as DynamoDBDocumentClient, new CognitoIdentityProviderClient({}));
  return { records, order, document, cognito, faults, run: () => invitations.invite(email, org, actor) };
}
it("records the global email claim before account creation and durable membership before email delivery", async () => {
  const { run, document, order } = harness();
  await expect(run()).resolves.toEqual({ email, organizationId: org, status: "INVITED" });
  expect(order).toEqual(["transaction", "SUPPRESS", "transaction", "RESEND", "transaction"]);
  const transactions = document.mock.calls.flatMap(([command]) => command instanceof TransactWriteCommand ? command.input.TransactItems ?? [] : []);
  expect(transactions).toContainEqual(expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ PK: identityKeys.emailReservation(email).PK }), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" }) }));
  expect(transactions.filter((item) => item.Put?.Item?.currentSub === "new-subject")).toHaveLength(1);
  expect(transactions.some((item) => item.Update?.Key?.PK === "ADMIN_GUARD")).toBe(false);
});
it("returns an accurate same-organization result without creating, enabling, rebinding or emailing", async () => {
  const { run, document, cognito } = harness(true);
  await expect(run()).resolves.toEqual({ email, organizationId: org, status: "ALREADY_MEMBER" });
  expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  expect(cognito.mock.calls.every(([command]) => command instanceof AdminGetUserCommand || command instanceof AdminListGroupsForUserCommand)).toBe(true);
});
it("rejects another organization, revoked ownership and stale reservations", async () => {
  for (const changed of [{ organizationId: "org_other_0123456789" }, { status: "REVOKED" }, { userId: "usr_other_0123456789" }]) {
    vi.restoreAllMocks(); const { run, records, document, cognito } = harness(true);
    const key = identityKeys.subject(issuer, "client-subject").PK;
    records.set(key, { ...records.get(key), ...changed });
    await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
    expect(cognito.mock.calls.some(([command]) => command instanceof AdminCreateUserCommand)).toBe(false);
  }
});
it("does not create a user when the global email claim loses a concurrent ownership race", async () => {
  const { run, cognito, faults } = harness();
  faults.transaction = 1;
  await expect(run()).rejects.toThrow();
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminCreateUserCommand)).toBe(false);
});
it("does not deliver credentials when durable identity binding fails", async () => {
  const { run, order, faults } = harness(); faults.transaction = 2;
  await expect(run()).rejects.toThrow("database failure");
  expect(order).not.toContain("RESEND");
});

it("does not re-enable disabled accounts or resend pending invitations on an ordinary retry", async () => {
  const { run, faults, cognito, document } = harness(true);
  faults.status = "FORCE_CHANGE_PASSWORD";
  await expect(run()).resolves.toMatchObject({ status: "PENDING" });
  faults.disabled = true;
  await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminCreateUserCommand)).toBe(false);
  expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
});
