import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { sha256, tenantKeys } from "@bdr/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminClients, adminClientBuildings, adminClientBuildingCount, adminReview, pendingReviewRows } from "./admin-reads";
import { listChildren, portalSourceId } from "./buildings";
import { createPortalReadContext } from "./read-context";

const org = "org_alpha_0123456789"; const emptyOrg = "org_empty_0123456789";
const first = "alpha/robot/2026-01-01/tower/"; const latest = "alpha/robot/2026-02-01/tower/";
const buildingId = "pbl_0123456789abcdef01234567";
const artifact = (prefix: string) => `${prefix}reportgen/client_portal/assessment.pdf`;
const inspection = (prefix: string, date: string) => ({ inspectionId: `pin_${sha256(prefix).slice(0, 24)}`, sourceId: portalSourceId(prefix), sourcePrefix: prefix, includedSectionIds: [], scannedAt: `${date}T00:00:00Z`, uploadCompletedAt: null, timeZone: "UTC", reportStatuses: {}, sourceFingerprint: "unchanged", asBuilt: null });
const stored = { ...tenantKeys.portalBuilding(org, buildingId), entityType: "PORTAL_BUILDING", organizationId: org, buildingId, displayName: "Physical Tower", address: "100 Main Street", engineerNames: "", clientVisible: false, revision: "rev_0123456789abcdef", inspections: [inspection(first, "2026-01-01"), inspection(latest, "2026-02-01")] };
const status = (prefix: string) => ({ displayName: "Tower", address: "100 Main Street", scanTime: "2026-01-01T00:00:00Z", reports: {
  ASSESSMENT: { awaitingClientAdmin: true, stale: false, clientVisible: false, approvedKey: artifact(prefix), generatedAt: "2026-01-01T12:00:00Z" },
  ROOF_TAKEOFF: { awaitingClientAdmin: true, stale: true }, CAPITAL_PLAN: { awaitingClientAdmin: true, clientVisible: true },
} });
beforeEach(() => { vi.stubEnv("DATA_BUCKET_NAME", "reports"); vi.stubEnv("TENANT_DATA_TABLE_NAME", "tenant"); vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function harness() {
  const links = [{ organizationId: org, displayName: "Alpha Client", clientPrefixes: ["alpha/"] }, { organizationId: emptyOrg, displayName: "Empty Client", clientPrefixes: ["empty"] }];
  const faults = { status: "", metadata: false, discovery: false, claims: false, suspended: false, staleQueryPage: false };
  const dynamo = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      if (faults.metadata) return {} as never;
      const id = String(command.input.Key?.PK).slice(4);
      return { Item: { organizationId: id, displayName: id === org ? "Alpha Client" : "Empty Client", status: faults.suspended && id === emptyOrg ? "SUSPENDED" : "ACTIVE" } } as never;
    }
    if (command instanceof QueryCommand) {
      if (command.input.ExpressionAttributeValues?.[":pk"] !== `ORG#${org}`) return { Items: [] } as never;
      if (faults.staleQueryPage && !command.input.ExclusiveStartKey) return { Items: [], LastEvaluatedKey: { PK: `ORG#${org}`, SK: "PORTAL_first_page" } } as never;
      return { Items: [stored] } as never;
    }
    if (command instanceof BatchGetCommand) return { Responses: { tenant: (command.input.RequestItems?.tenant?.Keys ?? []).map((key) => ({ ...key, organizationId: faults.claims ? emptyOrg : org, buildingId })) } } as never;
    throw new Error("Unexpected DynamoDB mutation/read");
  });
  const s3 = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key!;
      if (key === "reportgen_portal/org_links.json") return { ETag: '"links"', Body: { transformToString: async () => JSON.stringify({ organizations: links }) } } as never;
      if (faults.status && key.startsWith(faults.status)) throw new Error("AccessDenied");
      const prefix = key.endsWith("reportgen/client_portal/status.json") ? key.slice(0, -"reportgen/client_portal/status.json".length) : null;
      if (prefix === first || prefix === latest) return { ETag: '"status"', Body: { transformToString: async () => JSON.stringify(status(prefix)) } } as never;
      throw new Error(`Unexpected full-detail read: ${key}`);
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix;
      if (faults.discovery && prefix === "alpha/") throw new Error("Discovery unavailable");
      const children = prefix === "alpha/" ? ["alpha/robot/"] : prefix === "alpha/robot/" ? ["alpha/robot/2026-01-01/", "alpha/robot/2026-02-01/"] : prefix === "alpha/robot/2026-01-01/" ? [first] : prefix === "alpha/robot/2026-02-01/" ? [latest] : [];
      return { CommonPrefixes: children.map((Prefix) => ({ Prefix })) } as never;
    }
    throw new Error("Unexpected S3 mutation or metadata enrichment");
  });
  return { links, faults, dynamo, s3 };
}

describe("lightweight administrator reads", () => {
  it("retains filename classification, artifact ownership, and legacy report key semantics", () => {
    const client = { organizationId: org, displayName: "Alpha Client", clientPrefixes: ["alpha"] };
    const pending = { awaitingClientAdmin: true, clientVisible: false, stale: false };
    expect(() => pendingReviewRows(client, first, "Tower", { reports: { ASSESSMENT: { ...pending, sourceKey: `${first}reportgen/client_portal/evidence.pdf` } } }))
      .toThrow("report_file_invalid");
    expect(() => pendingReviewRows(client, first, "Tower", { reports: { ASSESSMENT: { ...pending, sourceKey: artifact(first), approvedKey: artifact(latest) } } }))
      .toThrow("artifact_owner_invalid");
    expect(pendingReviewRows(client, first, "Tower", { reports: { CAPITAL_PLAN: { ...pending, sourceKey: `${first}reportgen/client_portal/capital_plan.pdf`, reportgenApprovedAt: "2026-01-01T12:00:00Z" } } }))
      .toMatchObject([{ reportType: "CAPITAL_PLANNING", reportKey: "CAPITAL_PLAN", generatedAt: "2026-01-01T12:00:00Z" }]);
  });
  it("lists active linked organizations including empty clients, without any building discovery", async () => {
    const { s3, dynamo, faults } = harness();
    expect((await adminClients("request")).items.map((client) => client.displayName)).toEqual(["Alpha Client", "Empty Client"]);
    expect(s3.mock.calls).toHaveLength(1);
    expect(dynamo.mock.calls.every(([command]) => command instanceof GetCommand)).toBe(true);
    faults.suspended = true;
    expect((await adminClients("request")).items).toHaveLength(1);
  });
  it("fails closed on ambiguous linked ownership and missing organization metadata", async () => {
    const { links, faults } = harness();
    faults.metadata = true;
    await expect(adminClients("request")).rejects.toThrow();
    faults.metadata = false; links[1]!.clientPrefixes = ["alpha"];
    await expect(adminClients("request")).rejects.toThrow("owner_conflict");
  });
  it("counts physical buildings using the same grouping as the selected client list", async () => {
    const { dynamo, s3 } = harness();
    expect((await adminClientBuildings(org, "request")).items).toMatchObject([{ buildingId, displayName: "Physical Tower", inspectionCount: 2 }]);
    expect(await adminClientBuildingCount(org, "request")).toEqual({ count: 1 });
    expect(dynamo.mock.calls.filter(([command]) => command instanceof GetCommand).every(([command]) => command instanceof GetCommand && command.input.Key?.PK === `ORG#${org}`)).toBe(true);
    expect(s3.mock.calls.some(([command]) => command instanceof ListObjectsV2Command && command.input.Prefix?.startsWith("empty"))).toBe(false);
    expect(await adminClientBuildingCount(emptyOrg, "request")).toEqual({ count: 0 });
  });
  it("rejects unlinked organizations without scanning any building folders", async () => {
    const { s3 } = harness();
    await expect(adminClientBuildings("org_unknown_0123456789", "request")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s3.mock.calls.some(([command]) => command instanceof ListObjectsV2Command)).toBe(false);
  });
  it("includes pending reports from old and current inspections without full-detail reads", async () => {
    const { faults, s3, dynamo } = harness(); faults.staleQueryPage = true;
    const result = await adminReview("request");
    expect(result.complete).toBe(true); expect(result.failures).toEqual([]);
    expect(result.items.map((row) => row.prefix)).toEqual([first, latest]);
    expect(result.items.every((row) => row.reportType === "ASSESSMENT" && row.name === "Physical Tower")).toBe(true);
    expect(s3.mock.calls.filter(([command]) => command instanceof GetObjectCommand && command.input.Key?.endsWith("status.json"))).toHaveLength(2);
    expect(dynamo.mock.calls.some(([command]) => command instanceof QueryCommand && command.input.ExclusiveStartKey)).toBe(true);
  });
  it("retains successful rows but reports incompleteness when one source read fails", async () => {
    const { faults } = harness(); faults.status = first;
    const result = await adminReview("request");
    expect(result.complete).toBe(false); expect(result.items.map((row) => row.prefix)).toEqual([latest]);
    expect(result.failures).toContainEqual({ organizationId: org, clientName: "Alpha Client", prefix: first });
  });
  it("does not report a clear queue when discovery or source ownership cannot be verified", async () => {
    const { faults } = harness(); faults.discovery = true;
    expect((await adminReview("request")).complete).toBe(false);
    faults.discovery = false; faults.claims = true;
    const result = await adminReview("request");
    expect(result.complete).toBe(false); expect(result.items).toEqual([]);
  });
});

describe("S3 discovery pagination", () => {
  it("follows continuation tokens and deduplicates prefixes across pages", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      if (!(command instanceof ListObjectsV2Command)) throw new Error("Unexpected operation");
      return command.input.ContinuationToken ? { CommonPrefixes: [{ Prefix: "alpha/" }, { Prefix: "beta/" }], IsTruncated: false } as never : { CommonPrefixes: [{ Prefix: "alpha/" }], IsTruncated: true, NextContinuationToken: "next" } as never;
    });
    const context = createPortalReadContext();
    await expect(listChildren("", context)).resolves.toEqual(["alpha/", "beta/"]);
    expect(send).toHaveBeenCalledTimes(2); expect(context.listObjectCount).toBe(2);
  });
  it("surfaces later-page failures and missing or repeated continuation tokens", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: "next" } as never).mockRejectedValueOnce(new Error("second page denied"));
    await expect(listChildren("alpha/")).rejects.toThrow("second page denied");
    send.mockResolvedValue({ IsTruncated: true } as never);
    await expect(listChildren("alpha/")).rejects.toThrow("pagination_incomplete");
    send.mockResolvedValue({ IsTruncated: true, NextContinuationToken: "repeated" } as never);
    await expect(listChildren("alpha/")).rejects.toThrow("pagination_incomplete");
  });
});
