import { AdminDisableUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, expect, it, vi } from "vitest";
import { revokeClientAccess } from "./client-revocation";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/client-pool";
const user = { organizationId: "org_0123456789abcdef", userId: "usr_0123456789abcdef", normalizedEmail: "client@example.com", email: "client@example.com", status: "ACTIVE", currentIssuer: issuer, currentSub: "client-sub", cognitoUsername: "client-sub", revision: "rev_original" };
const config = { tenantTable: "tenant", identityTable: "identity", sessionTable: "sessions", auditTable: "audit", clientPoolId: "client-pool", clientIssuer: issuer };
const actor = { adminId: "admin_0123456789abcdef", sub: "actor", requestId: "request" };
afterEach(() => vi.restoreAllMocks());
function harness() {
  let revoked = false;
  const order: string[] = [];
  const document = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: command.input.TableName === "tenant" ? { ...user, status: revoked ? "REVOKED" : "ACTIVE", revision: revoked ? "rev_changed" : user.revision } : { issuer, sub: user.currentSub, userId: user.userId, organizationId: user.organizationId, status: revoked ? "REVOKED" : "ACTIVE", invitationId: null } } as never;
    if (command instanceof TransactWriteCommand) { revoked = true; order.push("denied"); return {} as never; }
    if (command instanceof QueryCommand) {
      const suffix = command.input.ExclusiveStartKey ? "b" : "a";
      return { Items: [{ SK: `SESSION#${suffix.repeat(64)}`, sessionIdHash: suffix.repeat(64), revokedAt: null }], ...(!command.input.ExclusiveStartKey ? { LastEvaluatedKey: { PK: "subject", SK: "next" } } : {}) } as never;
    }
    if (command instanceof UpdateCommand) { order.push("session"); return {} as never; }
    throw new Error("Unexpected DynamoDB operation");
  });
  const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async () => { order.push("cognito"); return {} as never; });
  // Use SDK instances so the prototype mocks exercise the real command boundary.
  const run = () => revokeClientAccess(config, user.organizationId, user.userId, user.revision, actor,
    Object.create(DynamoDBDocumentClient.prototype) as DynamoDBDocumentClient, new CognitoIdentityProviderClient({}));
  return { document, cognito, order, run };
}
it("denies access before paginated session cleanup and Cognito revocation; retries are idempotent", async () => {
  const { run, order, document, cognito } = harness();
  await run(); await run();
  expect(order[0]).toBe("denied");
  expect(document.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
  expect(document.mock.calls.filter(([command]) => command instanceof UpdateCommand)).toHaveLength(8);
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminUserGlobalSignOutCommand)).toBe(true);
  expect(cognito.mock.calls.some(([command]) => command instanceof AdminDisableUserCommand)).toBe(true);
});
it("keeps access denied when Cognito fails and completes cleanup on retry", async () => {
  const { run, document, cognito } = harness();
  cognito.mockRejectedValueOnce(new Error("Cognito unavailable"));
  await expect(run()).rejects.toThrow("access is revoked");
  await run();
  expect(document.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
});
it("rejects changed membership ownership before mutations", async () => {
  const { run, document, cognito } = harness();
  document.mockResolvedValueOnce({ Item: { ...user, organizationId: "org_other_0123456789" } } as never);
  await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(cognito).not.toHaveBeenCalled();
  expect(document.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
});
