import { describe, expect, it, vi } from "vitest";

import { AwsPortalAdminOperations } from "./operations";

const organizationId = "org_0123456789abcdef";
const projectId = "project_0123456789abcdef";

describe("Phase 5 registry operations", () => {
  const active = { profile: { adminId: "admin_0123456789abcdef" }, identity: { sub: "admin-sub" } } as never;

  it("uses the normalized email as the Cognito username for a new invitation", async () => {
    const cognitoInputs: Record<string, unknown>[] = [];
    const dynamo = vi.fn(async (command: { input: Record<string, unknown> }) => {
      if (command.input.TableName === "tenant" && command.input.Key) return { Item: { organizationId, displayName: "Client", status: "ACTIVE", revision: "rev_org_0123456789" } };
      if (command.input.Key) return {};
      if (command.input.TransactItems) return {};
      throw new Error(`Unexpected command ${JSON.stringify(command.input)}`);
    });
    const cognito = vi.fn(async (command: { input: Record<string, unknown> }) => {
      cognitoInputs.push(command.input);
      return { User: { Username: "generated-client-username", Attributes: [{ Name: "sub", Value: "client-sub" }] } };
    });
    const service = new AwsPortalAdminOperations(
      { tables: { identity: "identity", tenantData: "tenant", adminControl: "admin", session: "session", audit: "audit" }, clientUserPoolId: "pool", clientIssuer: "https://issuer.example.com/pool" },
      { dynamo: { send: dynamo } as never, cognito: { send: cognito } as never },
    );

    const invitation = await service.createInvitation(organizationId, { email: " Client@Example.com ", idempotencyKey: "request_0123456789abcdef" }, { active, requestId: "request" });

    expect(cognitoInputs).toHaveLength(1);
    expect(cognitoInputs[0]).toMatchObject({
      UserPoolId: "pool",
      Username: "client@example.com",
      UserAttributes: expect.arrayContaining([{ Name: "email", Value: "client@example.com" }]),
    });
    expect(invitation.cognitoUsername).toBe("generated-client-username");
  });

  it("migrates a failed opaque Cognito username when resending an invitation", async () => {
    const invitation = {
      invitationId: "invite_0123456789abcdef",
      organizationId,
      userId: "user_0123456789abcdef",
      email: "Client@Example.com",
      normalizedEmail: "client@example.com",
      status: "DELIVERY_FAILED",
      absoluteExpiresAt: "2026-09-20T12:00:00.000Z",
      ttlExpiresAt: null,
      acceptedAt: null,
      cognitoUsername: "client_invite_0123456789abcdef",
      issuer: "https://issuer.example.com/pool",
      sub: null,
      revision: "rev_invitation_0123456789",
    } as const;
    let transaction: Array<{ Update?: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } }> = [];
    const dynamo = vi.fn(async (command: { input: Record<string, unknown> }) => {
      if (command.input.Key) return { Item: invitation };
      if (command.input.TransactItems) {
        transaction = command.input.TransactItems as typeof transaction;
        return {};
      }
      throw new Error(`Unexpected command ${JSON.stringify(command.input)}`);
    });
    const cognitoInputs: Record<string, unknown>[] = [];
    const cognito = vi.fn(async (command: { input: Record<string, unknown> }) => {
      cognitoInputs.push(command.input);
      if (cognitoInputs.length === 1) throw Object.assign(new Error("not found"), { name: "UserNotFoundException" });
      return { User: { Username: "generated-client-username", Attributes: [{ Name: "sub", Value: "client-sub" }] } };
    });
    const service = new AwsPortalAdminOperations(
      { tables: { identity: "identity", tenantData: "tenant", adminControl: "admin", session: "session", audit: "audit" }, clientUserPoolId: "pool", clientIssuer: "https://issuer.example.com/pool" },
      { dynamo: { send: dynamo } as never, cognito: { send: cognito } as never },
    );

    const resent = await service.resendInvitation(organizationId, invitation.invitationId, { active, requestId: "request" });

    expect(cognitoInputs).toHaveLength(2);
    expect(cognitoInputs[0]).toMatchObject({ UserPoolId: "pool", Username: "client@example.com" });
    expect(cognitoInputs[1]).toMatchObject({ UserPoolId: "pool", Username: "client@example.com" });
    expect(resent).toMatchObject({ status: "PENDING", sub: "client-sub", cognitoUsername: "generated-client-username" });
    const invitationUpdate = transaction.find((action) => action.Update?.UpdateExpression?.includes("cognitoUsername"));
    expect(invitationUpdate?.Update?.ExpressionAttributeValues?.[":username"]).toBe("generated-client-username");
  });

  it("creates a draft inspection and all four classifications in one transaction", async () => {
    let transaction: unknown;
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      const key = command.input.Key as { SK?: string } | undefined;
      if (key?.SK === "META") return { Item: { organizationId, displayName: "Client", status: "ACTIVE", revision: "rev_org_0123456789" } };
      if (key?.SK === `PROJECT#${projectId}`) return { Item: { organizationId, projectId, displayName: "Building", address: "1 Main St", timeZone: "America/New_York", lifecycleStatus: "ACTIVE", archivedAt: null, archivedByAdminId: null, archiveReason: null, revision: "rev_project_123456" } };
      if (key?.SK?.startsWith("INSPECTION#")) return {};
      if (command.input.TransactItems) {
        transaction = command.input.TransactItems;
        return {};
      }
      throw new Error(`Unexpected command ${JSON.stringify(command.input)}`);
    });
    const service = new AwsPortalAdminOperations(
      { tables: { identity: "identity", tenantData: "tenant", adminControl: "admin", session: "session", audit: "audit" }, clientUserPoolId: "pool", clientIssuer: "https://issuer.example.com/pool" },
      { dynamo: { send } as never, cognito: { send: vi.fn() } as never },
    );
    const inspection = await service.createInspection(organizationId, projectId, { scannedAt: "2026-09-13T10:00:00-04:00", idempotencyKey: "request_0123456789abcdef" }, { active, requestId: "request" });
    expect(inspection).toMatchObject({ publicationStatus: "DRAFT", scanTimeZone: "America/New_York" });
    const actions = transaction as Array<{ Put?: { Item?: Record<string, unknown> } }>;
    const reports = actions.filter((action) => action.Put?.Item?.reportType).map((action) => action.Put?.Item?.reportType);
    expect(reports).toEqual(expect.arrayContaining(["ASSESSMENT", "EVIDENCE", "ROOF_TAKEOFF", "CAPITAL_PLANNING"]));
    expect(reports).toHaveLength(4);
  });
});
