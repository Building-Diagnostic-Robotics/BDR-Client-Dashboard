import { AdminCreateUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { identityKeys } from "@bdr/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdministratorDirectory } from "./admin-directory";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/admin-pool";
const config = { issuer, clientPoolId: "client-pool", identityTable: "identity", controlTable: "control", auditTable: "audit" };
const actor = { adminId: "admin_0123456789abcdef", sub: "actor-subject", requestId: "request" };
const profile = { adminId: actor.adminId, status: "ACTIVE", role: "BDR_ADMIN", totpEnrolled: true };
const pendingId = "admin_abcdef0123456789";
const email = "new@example.com";
const enrollment = { email, issuer, adminId: pendingId, sub: "new-subject", username: "new-subject", status: "INVITED", actorId: actor.adminId, actorSub: actor.sub,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), revision: "rev_0123456789abcdef" };
const missing = () => Object.assign(new Error("missing"), { name: "UserNotFoundException" });
afterEach(() => vi.restoreAllMocks());

function harness() {
  let accepted = false;
  const document = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key;
      if (command.input.TableName === "control") return { Item: enrollment } as never;
      if (key?.PK === "ADMIN_GUARD") return { Item: { activeAdminCount: accepted ? 2 : 1 } } as never;
      if (key?.PK === identityKeys.adminProfile(actor.adminId).PK) return { Item: profile } as never;
      if (key?.PK === identityKeys.subject(issuer, actor.sub).PK) return { Item: { issuer, sub: actor.sub, adminId: actor.adminId } } as never;
      if (accepted && key?.PK === identityKeys.subject(issuer, "new-subject").PK) return { Item: { issuer, sub: "new-subject", adminId: pendingId } } as never;
      if (accepted && key?.PK === identityKeys.adminProfile(pendingId).PK) return { Item: { ...profile, adminId: pendingId } } as never;
      return {} as never;
    }
    if (command instanceof TransactWriteCommand) {
      if (command.input.TransactItems?.some((item) => item.Update?.Key?.PK === "ADMIN_GUARD")) accepted = true;
      return {} as never;
    }
    if (command instanceof PutCommand || command instanceof UpdateCommand) return {} as never;
    throw new Error("Unexpected DynamoDB operation");
  });
  const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "bdr-admins" }] } as never;
    if (command instanceof AdminGetUserCommand) {
      if (command.input.UserPoolId === "client-pool") throw missing();
      return { Username: command.input.Username, Enabled: true, UserStatus: "CONFIRMED", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"],
        UserAttributes: [{ Name: "sub", Value: command.input.Username }, { Name: "email", Value: email }] } as never;
    }
    throw new Error("Unexpected Cognito operation");
  });
  return { directory: new AdministratorDirectory(config), document, cognito };
}
describe("canonical administrator lifecycle", () => {
  it("activates a verified invite atomically and only increments the guard once", async () => {
    const { directory, document } = harness();
    await directory.complete("new-subject", "callback-request");
    await directory.complete("new-subject", "replayed-callback");
    const activations = document.mock.calls.flatMap(([command]) => command instanceof TransactWriteCommand ? command.input.TransactItems ?? [] : []);
    expect(activations.filter((item) => item.Update?.Key?.PK === "ADMIN_GUARD")).toHaveLength(1);
    expect(activations).toEqual(expect.arrayContaining([
      expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ adminId: pendingId, role: "BDR_ADMIN", totpEnrolled: true }), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" }) }),
      expect.objectContaining({ Put: expect.objectContaining({ Item: expect.objectContaining({ action: "ADMIN_ADDED", actorId: actor.adminId }) }) }),
    ]));
  });
  it("does not turn a legacy browser identity into an administrator", async () => {
    const { directory, document } = harness();
    document.mockResolvedValue({ Item: { issuer, sub: "legacy", organizationId: "bdr_portal_admins", status: "ACTIVE" } } as never);
    await expect(directory.complete("legacy", "request")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
  it("rejects unknown, disabled, non-MFA, and missing-group administrators", async () => {
    const { directory, cognito, document } = harness();
    await expect(directory.authorize(actor.sub)).resolves.toMatchObject({ profile });
    cognito.mockImplementation(async (command) => {
      if (command instanceof AdminGetUserCommand) return { Enabled: false, UserAttributes: [{ Name: "sub", Value: actor.sub }] } as never;
      return { Groups: [] } as never;
    });
    await expect(directory.authorize(actor.sub)).rejects.toMatchObject({ code: "FORBIDDEN" });
    document.mockResolvedValue({} as never);
    await expect(directory.authorize("unknown")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("checks client-pool uniqueness before creating an administrator", async () => {
    const { directory, cognito } = harness();
    cognito.mockResolvedValueOnce({ Enabled: true, UserStatus: "CONFIRMED", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"], UserAttributes: [{ Name: "sub", Value: actor.sub }] } as never)
      .mockResolvedValueOnce({ Groups: [{ GroupName: "bdr-admins" }] } as never)
      .mockResolvedValueOnce({ Username: "client" } as never);
    await expect(directory.invite(email, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(cognito.mock.calls.some(([command]) => command instanceof AdminCreateUserCommand)).toBe(false);
  });
  it("never resends an invitation just because the caller retries", async () => {
    const { directory, cognito } = harness();
    await expect(directory.invite(email, actor)).resolves.toEqual({ email, status: "PENDING" });
    expect(cognito.mock.calls.some(([command]) => command instanceof AdminCreateUserCommand)).toBe(false);
  });
  it("fails closed when the guard is missing, zero, negative or fractional", async () => {
    for (const count of [undefined, 0, -1, 1.5]) {
      vi.restoreAllMocks();
      const { directory, document } = harness();
      document.mockResolvedValueOnce({ Item: { issuer, sub: actor.sub, adminId: actor.adminId } } as never)
        .mockResolvedValueOnce({ Item: profile } as never)
        .mockResolvedValueOnce({ Item: { activeAdminCount: count } } as never);
      await expect(directory.eligible(actor.sub)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});

it("records ownership before sending credentials and does not send another email on retry", async () => {
  const records = new Map<string, Record<string, unknown>>([
    [identityKeys.subject(issuer, actor.sub).PK, { issuer, sub: actor.sub, adminId: actor.adminId }],
    [identityKeys.adminProfile(actor.adminId).PK, profile],
    ["ADMIN_GUARD", { activeAdminCount: 1 }],
  ]);
  const order: string[] = [];
  let created = false;
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: records.get(String(command.input.Key?.PK)) } as never;
    if (command instanceof PutCommand) { const item = command.input.Item!; records.set(String(item.PK), item); order.push("prepared"); return {} as never; }
    if (command instanceof TransactWriteCommand) {
      for (const action of command.input.TransactItems ?? []) {
        if (action.Put?.TableName === "control") records.set(String(action.Put.Item?.PK), action.Put.Item!);
        if (action.Update?.TableName === "control") {
          const key = String(action.Update.Key?.PK);
          records.set(key, { ...records.get(key), status: "INVITED" });
        }
      }
      return {} as never;
    }
    throw new Error("Unexpected command");
  });
  const send = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "bdr-admins" }] } as never;
    if (command instanceof AdminGetUserCommand) {
      if (command.input.UserPoolId === "client-pool" || command.input.Username === email && !created) throw missing();
      const sub = command.input.Username === actor.sub ? actor.sub : "new-subject";
      return { Username: sub, Enabled: true, UserStatus: sub === actor.sub ? "CONFIRMED" : "FORCE_CHANGE_PASSWORD", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"], UserAttributes: [{ Name: "sub", Value: sub }] } as never;
    }
    if (command instanceof AdminCreateUserCommand) {
      created = true; order.push(command.input.MessageAction ?? "unexpected");
      return { User: { Username: "new-subject", Attributes: [{ Name: "sub", Value: "new-subject" }] } } as never;
    }
    return {} as never; // Group assignment.
  });
  const directory = new AdministratorDirectory(config);
  await expect(directory.invite(email, actor)).resolves.toEqual({ email, status: "INVITED" });
  await expect(directory.invite(email, actor)).resolves.toEqual({ email, status: "PENDING" });
  expect(order).toEqual(["SUPPRESS", "prepared", "RESEND"]);
  expect(send.mock.calls.filter(([command]) => command instanceof AdminCreateUserCommand)).toHaveLength(2);
});

it("rejects disabled or unenrolled canonical profiles independently of Cognito tokens", async () => {
  for (const changed of [{ ...profile, status: "DISABLED" }, { ...profile, totpEnrolled: false }, { ...profile, role: "CLIENT" }]) {
    vi.restoreAllMocks();
    const { directory, document, cognito } = harness();
    document.mockResolvedValueOnce({ Item: { issuer, sub: actor.sub, adminId: actor.adminId } } as never)
      .mockResolvedValueOnce({ Item: changed } as never)
      .mockResolvedValueOnce({ Item: { activeAdminCount: 1 } } as never);
    await expect(directory.authorize(actor.sub)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(cognito).not.toHaveBeenCalled();
  }
});

it("claims the same global email key as client creation and stops if another owner wins", async () => {
  const { directory, document, cognito } = harness();
  document.mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key?.PK;
      if (key === "ADMIN_GUARD") return { Item: { activeAdminCount: 1 } } as never;
      if (key === identityKeys.adminProfile(actor.adminId).PK) return { Item: profile } as never;
      if (key === identityKeys.subject(issuer, actor.sub).PK) return { Item: { issuer, sub: actor.sub, adminId: actor.adminId } } as never;
      return {} as never;
    }
    if (command instanceof TransactWriteCommand) {
      const claim = command.input.TransactItems?.find((item) => item.Put?.Item?.PK === identityKeys.emailReservation(email).PK)?.Put;
      expect(claim).toMatchObject({ TableName: "identity", ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)", Item: { ownerType: "ADMIN", normalizedEmail: email } });
      throw Object.assign(new Error("concurrent client owns the email"), { name: "TransactionCanceledException" });
    }
    throw new Error("Unexpected operation");
  });
  cognito.mockImplementation(async (command) => {
    if (command instanceof AdminListGroupsForUserCommand) return { Groups: [{ GroupName: "bdr-admins" }] } as never;
    if (command instanceof AdminGetUserCommand && command.input.Username === actor.sub) return { Enabled: true, UserStatus: "CONFIRMED", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"], UserAttributes: [{ Name: "sub", Value: actor.sub }] } as never;
    if (command instanceof AdminGetUserCommand) throw missing();
    throw new Error("Must not create an account after losing the claim");
  });
  await expect(directory.invite(email, actor)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminCreateUserCommand)).toBe(false);
});
