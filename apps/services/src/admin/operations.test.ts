import { describe, expect, it, vi } from "vitest";

import { AwsPortalAdminOperations } from "./operations";

const organizationId = "org_0123456789abcdef";
const projectId = "project_0123456789abcdef";

describe("Phase 5 registry operations", () => {
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
    const active = { profile: { adminId: "admin_0123456789abcdef" }, identity: { sub: "admin-sub" } } as never;
    const inspection = await service.createInspection(organizationId, projectId, { scannedAt: "2026-09-13T10:00:00-04:00", idempotencyKey: "request_0123456789abcdef" }, { active, requestId: "request" });
    expect(inspection).toMatchObject({ publicationStatus: "DRAFT", scanTimeZone: "America/New_York" });
    const actions = transaction as Array<{ Put?: { Item?: Record<string, unknown> } }>;
    const reports = actions.filter((action) => action.Put?.Item?.reportType).map((action) => action.Put?.Item?.reportType);
    expect(reports).toEqual(expect.arrayContaining(["ASSESSMENT", "EVIDENCE", "ROOF_TAKEOFF", "CAPITAL_PLANNING"]));
    expect(reports).toHaveLength(4);
  });
});
