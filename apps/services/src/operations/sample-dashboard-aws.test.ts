import { AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminGetUserCommand, AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, DescribeUserPoolCommand, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { identityKeys, tenantKeys } from "@bdr/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AwsSampleDashboard, type SetupConfiguration } from "./sample-dashboard-aws";
import { hash, type SetupClient } from "./sample-dashboard";

const email = "client@example.com";
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/client-pool";
const config: SetupConfiguration = {
  context: { environment: "production", accountId: "123456789012", region: "us-east-1", bucket: "reports", tenantTable: "tenant", clientPool: "client-pool", clientPrefix: "bdr_sample_dashboard", organizationId: "org_sample", portalOrigin: "https://portal.example.com", operatorArn: "arn:aws:iam::123456789012:user/operator" },
  identityTable: "identity", sessionTable: "sessions", adminControlTable: "control", auditTable: "audit", adminPool: "admin-pool", issuer,
};
const client: SetupClient = {
  email, original: { username: "old-subject", sub: "old-subject", issuer, organizationId: "org_old", userId: "usr_old", revision: "rev_old", status: "ACTIVE" },
  phase: "resetting", username: null, sub: null,
};
const oldUser = { ...tenantKeys.user("org_old", "usr_old"), organizationId: "org_old", userId: "usr_old", currentIssuer: issuer, currentSub: "old-subject", normalizedEmail: email, status: "ACTIVE", revision: "rev_old" };
const oldIdentity = { ...identityKeys.subject(issuer, "old-subject"), issuer, sub: "old-subject", organizationId: "org_old", userId: "usr_old", status: "ACTIVE", invitationId: null };
const reservation = { ...identityKeys.emailReservation(email), normalizedEmail: email, organizationId: "org_old", userId: "usr_old" };
function cognitoUser(sub: string, address = email) { return { Username: sub, Attributes: [{ Name: "email", Value: address }, { Name: "sub", Value: sub }] }; }

beforeEach(() => {
  for (const key of ["AWS_REGION", "AWS_DEFAULT_REGION", "DATA_BUCKET_NAME", "TENANT_DATA_TABLE_NAME", "AUDIT_TABLE_NAME", "IDENTITY_TABLE_NAME", "CLIENT_USER_POOL_ID", "CLIENT_ISSUER", "ADMIN_ISSUER"]) vi.stubEnv(key, "before-test");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function mockAccounts() {
  const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof ListUsersCommand) return { Users: command.input.UserPoolId === "admin-pool" ? [] : [cognitoUser("old-subject")] } as never;
    if (command instanceof AdminDisableUserCommand || command instanceof AdminUserGlobalSignOutCommand || command instanceof AdminDeleteUserCommand) return {} as never;
    throw new Error("Unexpected Cognito operation");
  });
  const document = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      if (command.input.Key?.PK === reservation.PK) return { Item: reservation } as never;
      if (command.input.Key?.PK === oldIdentity.PK) return { Item: oldIdentity } as never;
      if (command.input.Key?.PK === oldUser.PK) return { Item: oldUser } as never;
    }
    if (command instanceof ScanCommand) {
      if (command.input.TableName === "tenant") return { Items: [oldUser] } as never;
      if (command.input.TableName === "sessions") return { Items: [{ PK: `SESSION#${"a".repeat(64)}`, SK: "SESSION", issuer, sub: "old-subject", sessionIdHash: "a".repeat(64), revokedAt: null }] } as never;
      if (command.input.TableName === "control") return { Items: [] } as never;
    }
    if (command instanceof QueryCommand) return { Items: [{ PK: oldIdentity.PK, SK: `SESSION#${"a".repeat(64)}`, sessionIdHash: "a".repeat(64), revokedAt: null }] } as never;
    if (command instanceof UpdateCommand || command instanceof TransactWriteCommand) return {} as never;
    throw new Error("Unexpected DynamoDB operation");
  });
  return { cognito, document };
}

describe("sample dashboard AWS boundaries", () => {
  it("rejects administrator matches including disabled/case-variant accounts", async () => {
    const send = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockResolvedValue({ Users: [cognitoUser("admin-sub", "CLIENT@EXAMPLE.COM")] } as never);
    const write = vi.spyOn(DynamoDBDocumentClient.prototype, "send");
    await expect(new AwsSampleDashboard(config).inspectClient(email)).rejects.toThrow("administrator");
    expect(send).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });
  it("checks every pool page before deciding an email is absent", async () => {
    const send = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
      if (!(command instanceof ListUsersCommand)) throw new Error("Unexpected operation");
      return (command.input.PaginationToken ? { Users: [cognitoUser("admin-sub")] } : { Users: [], PaginationToken: "next" }) as never;
    });
    await expect(new AwsSampleDashboard(config).inspectClient(email)).rejects.toThrow("administrator");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("requires a unique matching membership and immutable identity", async () => {
    mockAccounts();
    await expect(new AwsSampleDashboard(config).inspectClient(email)).resolves.toMatchObject(client.original!);
    vi.mocked(DynamoDBDocumentClient.prototype.send).mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { Item: command.input.Key?.PK === reservation.PK ? reservation : oldIdentity } as never;
      if (command instanceof ScanCommand) return { Items: [oldUser, { ...oldUser, organizationId: "org_other", userId: "usr_other" }] } as never;
      throw new Error("Unexpected operation");
    });
    await expect(new AwsSampleDashboard(config).inspectClient(email)).rejects.toThrow("Ambiguous client membership");
  });
  it("revokes canonical sessions and subject pointers and conditionally releases only the matching reservation", async () => {
    const { cognito, document } = mockAccounts();
    await new AwsSampleDashboard(config).resetClient(client);
    const transactions = document.mock.calls.flatMap(([command]) => command instanceof TransactWriteCommand ? command.input.TransactItems ?? [] : []);
    expect(transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ Update: expect.objectContaining({ TableName: "tenant", Key: tenantKeys.user("org_old", "usr_old"), ConditionExpression: "revision = :expected AND currentSub = :sub AND currentIssuer = :issuer" }) }),
      expect.objectContaining({ Delete: expect.objectContaining({ TableName: "identity", Key: identityKeys.emailReservation(email), ConditionExpression: "organizationId = :org AND userId = :user AND normalizedEmail = :email" }) }),
    ]));
    expect(document.mock.calls.filter(([command]) => command instanceof UpdateCommand && command.input.TableName === "sessions")).toHaveLength(2);
    expect(cognito.mock.calls.filter(([command]) => command instanceof AdminDeleteUserCommand).map(([command]) => command.input)).toEqual([{ UserPoolId: "client-pool", Username: "old-subject" }]);
  });
  it("rejects a foreign reservation before disabling or deleting an account", async () => {
    const { cognito, document } = mockAccounts();
    document.mockImplementation(async (command) => command instanceof GetCommand ? { Item: { ...reservation, organizationId: "org_other" } } as never : {} as never);
    await expect(new AwsSampleDashboard(config).resetClient(client)).rejects.toThrow("reservation ownership");
    expect(cognito.mock.calls.some(([command]) => command instanceof AdminDisableUserCommand || command instanceof AdminDeleteUserCommand)).toBe(false);
  });
  it("never adopts an existing Cognito account while creating a fresh invite", async () => {
    const { cognito } = mockAccounts();
    await expect(new AwsSampleDashboard(config).createClient(email)).rejects.toThrow("uncertain");
    expect(cognito.mock.calls.some(([command]) => command instanceof AdminCreateUserCommand)).toBe(false);
  });
  it("creates a real Cognito temporary-password invitation without setting a password or changing the template", async () => {
    const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof ListUsersCommand) return { Users: [] } as never;
      if (command instanceof AdminCreateUserCommand) return { User: cognitoUser("new-subject") } as never;
      throw new Error("Unexpected operation");
    });
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
    await expect(new AwsSampleDashboard(config).createClient(email)).resolves.toEqual({ username: "new-subject", sub: "new-subject" });
    const request = cognito.mock.calls.find(([command]) => command instanceof AdminCreateUserCommand)?.[0];
    expect(request?.input).toEqual({ UserPoolId: "client-pool", Username: email, DesiredDeliveryMediums: ["EMAIL"], UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }] });
  });
  it("verifies newly mapped users before accepting a completed checkpoint", async () => {
    const newUserId = `usr${hash("org_sample:client@example.com")}`.slice(0, 32);
    vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof ListUsersCommand) return { Users: command.input.UserPoolId === "admin-pool" ? [] : [cognitoUser("new-subject")] } as never;
      if (command instanceof AdminGetUserCommand) return { Enabled: true, UserStatus: "FORCE_CHANGE_PASSWORD" } as never;
      throw new Error("Unexpected operation");
    });
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
      const mapped = { ...oldIdentity, sub: "new-subject", organizationId: "org_sample", userId: newUserId };
      if (command instanceof GetCommand) return { Item: String(command.input.Key?.PK).startsWith("EMAIL#") ? { ...reservation, organizationId: "org_sample", userId: newUserId } : mapped } as never;
      if (command instanceof ScanCommand) return { Items: [{ ...oldUser, PK: "ORG#org_sample", SK: `USER#${newUserId}`, currentSub: "new-subject", organizationId: "org_sample", userId: newUserId }] } as never;
      throw new Error("Unexpected operation");
    });
    await expect(new AwsSampleDashboard(config).verifyClient({ ...client, phase: "done", sub: "new-subject", username: "new-subject" })).resolves.toBeUndefined();
  });
  it("leaves the existing invitation template unchanged and fails if its dashboard link is wrong", async () => {
    const cognito = vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockResolvedValue({ UserPool: { AdminCreateUserConfig: { InviteMessageTemplate: { EmailSubject: "Your BDR Inspections Dashboard invitation", EmailMessage: "https://portal.example.com/projects {username} {####}" } } } } as never);
    const port = new AwsSampleDashboard(config);
    await port.verifyInvitationTemplate();
    expect(cognito.mock.calls.every(([command]) => command instanceof DescribeUserPoolCommand)).toBe(true);
    cognito.mockResolvedValueOnce({ UserPool: { AdminCreateUserConfig: { InviteMessageTemplate: { EmailSubject: "Other" } } } } as never);
    await expect(port.verifyInvitationTemplate()).rejects.toThrow("template differs");
  });
  it("keeps manifest writes conditional so competing setup processes cannot overwrite a checkpoint", async () => {
    const write = vi.spyOn(S3Client.prototype, "send").mockRejectedValue(new Error("PreconditionFailed"));
    const port = new AwsSampleDashboard(config);
    // The conditional object contract is exercised separately from dataset preparation.
    const manifest = {
      version: 1 as const, seedId: "bdr-sample-dashboard-v1" as const,
      environment: config.context.environment, accountId: config.context.accountId, region: config.context.region, bucket: config.context.bucket,
      tenantTable: config.context.tenantTable, clientPool: config.context.clientPool, clientPrefix: config.context.clientPrefix, organizationId: config.context.organizationId,
      createdAt: "2026-10-07T20:00:00Z", files: Object.fromEntries(["ASSESSMENT", "EVIDENCE", "ROOF_TAKEOFF", "AS_BUILT", "CAPITAL_PLANNING"].map((type) => [type, { filename: "sample.pdf", sizeBytes: 1, sha256: "a".repeat(64) }])),
      clients: [], asBuilt: {}, complete: false, lease: null,
    };
    const { setupManifestSchema } = await import("./sample-dashboard");
    await expect(port.saveManifest(setupManifestSchema.parse(manifest), '"prior"')).rejects.toThrow("PreconditionFailed");
    const command = write.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toMatchObject({ IfMatch: '"prior"', Key: "bdr_sample_dashboard/seed-manifest.json" });
  });
});
