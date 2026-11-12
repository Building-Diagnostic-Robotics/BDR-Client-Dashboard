import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portalSourceId, provisionalPortalBuildingId } from "./buildings";
import { getPortalCatalogBuilding, listPortalCatalogBuildings } from "./catalog";

const organizationId = "org_client_0123456789";
const date = "2026-10-01T12:00:00.000Z";

function storedBuilding(index: number, inspectionCount = 1) {
  const buildingId = `pbl_${String(index).padStart(24, "0")}`;
  return {
    PK: `ORG#${organizationId}`, SK: `PORTAL_BUILDING#${buildingId}`, entityType: "PORTAL_BUILDING", organizationId, buildingId,
    displayName: `Building ${index}`, address: "100 Main Street", engineerNames: "Engineer", clientVisible: false, revision: "rev_0123456789abcdef",
    inspections: Array.from({ length: inspectionCount }, (_, i) => {
      const sourcePrefix = `client/robot/2026-10-${String(i + 1).padStart(2, "0")}/building-${index}/`;
      return { inspectionId: `pin_${String(index * 100 + i).padStart(24, "0")}`, sourcePrefix, sourceId: portalSourceId(sourcePrefix),
        includedSectionIds: ["Section_1"], scannedAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        uploadCompletedAt: date, timeZone: "UTC", reportStatuses: {}, sourceFingerprint: "fingerprint", asBuilt: null };
    }),
  };
}

function harness(buildings = [storedBuilding(1)]) {
  let active = 0; let peak = 0;
  const statuses = new Map<string, Record<string, unknown>>();
  let failedSource: string | undefined;
  let failedHead = false;
  for (const building of buildings) for (const inspection of building.inspections) statuses.set(inspection.sourcePrefix, {
    reports: { ASSESSMENT: { clientVisible: true, stale: false, approvedKey: `${inspection.sourcePrefix}reportgen/client_portal/assessment.pdf`, generatedAt: date } },
  });
  const dynamo = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      const row = buildings.find((building) => building.PK === command.input.Key?.PK && building.SK === command.input.Key?.SK);
      return (row ? { Item: row } : {}) as never;
    }
    if (command instanceof QueryCommand) return { Items: command.input.ExpressionAttributeValues?.[":pk"] === `ORG#${organizationId}` ? buildings : [] } as never;
    if (command instanceof BatchGetCommand) return { Responses: { tenant: [] } } as never;
    throw new Error("Unexpected catalog mutation");
  });
  const s3 = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (command instanceof ListObjectsV2Command && command.input.Prefix === "client/") return { CommonPrefixes: [] } as never;
      if (command instanceof HeadObjectCommand) {
        if (failedHead) throw new Error("Metadata unavailable");
        return { LastModified: new Date("2026-10-03T12:00:00Z") } as never;
      }
      if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected operational enrichment");
      const key = command.input.Key!;
      let value: unknown;
      if (key === "reportgen_portal/org_links.json") value = { organizations: [{ organizationId, displayName: "Client", clientPrefixes: ["client"] }] };
      else {
        if (!key.endsWith("reportgen/client_portal/status.json")) throw new Error(`Catalog must not read scan manifests, imagery, or history: ${key}`);
        const prefix = key.slice(0, -"reportgen/client_portal/status.json".length);
        if (prefix === failedSource) throw new Error("AccessDenied");
        value = statuses.get(prefix);
        if (!value) throw new Error(`Unknown publication source: ${prefix}`);
      }
      return { ETag: '"current"', Body: { transformToString: async () => JSON.stringify(value) } } as never;
    } finally { active--; }
  });
  return { s3, dynamo, statuses, peak: () => peak, fail: (prefix: string) => { failedSource = prefix; }, failHead: () => { failedHead = true; } };
}

beforeEach(() => {
  vi.stubEnv("DATA_BUCKET_NAME", "reports"); vi.stubEnv("TENANT_DATA_TABLE_NAME", "tenant");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("memory-bounded client catalog reads", () => {
  it("lists multiple buildings from publication state without reading operational scan manifests", async () => {
    const buildings = Array.from({ length: 8 }, (_, i) => storedBuilding(i + 1, 3));
    const { s3, peak } = harness(buildings);
    const result = await listPortalCatalogBuildings(organizationId);
    expect(result).toHaveLength(8);
    expect(result.every((row) => row.inspectionCount === 3 && row.latestInspection?.availableReportTypes.join() === "ASSESSMENT")).toBe(true);
    expect(peak()).toBe(4);
    const reads = s3.mock.calls.flatMap(([command]) => command instanceof GetObjectCommand ? [command.input.Key] : []);
    expect(reads).toHaveLength(9); // Eight latest statuses plus the organization links.
    expect(reads.every((key) => key?.endsWith("status.json") || key === "reportgen_portal/org_links.json")).toBe(true);
  });

  it("loads all inspection details with at most four reads and only publication metadata", async () => {
    const building = storedBuilding(1, 12); const { s3, peak } = harness([building]);
    const detail = await getPortalCatalogBuilding(organizationId, building.buildingId);
    expect(detail.inspections).toHaveLength(12);
    expect(detail.inspections.every((inspection) => inspection.reports.length === 5)).toBe(true);
    expect(peak()).toBe(4);
    expect(s3.mock.calls).toHaveLength(12);
    expect(detail.latestInspection?.latestReportUpdate).toBe(date);
  });

  it("keeps provisional building details free of scan manifest and image reads", async () => {
    const prefix = "client/robot/2026-10-01/tower/";
    const objects: Record<string, unknown> = {
      "reportgen_portal/org_links.json": { organizations: [{ organizationId, clientPrefixes: ["client"] }] },
      [`${prefix}reportgen/client_portal/status.json`]: { released: true, displayName: "Tower", address: "100 Main Street", scanTime: date,
        reports: { ASSESSMENT: { clientVisible: true, approvedKey: `${prefix}reportgen/client_portal/assessment.pdf`, generatedAt: date } } },
      [`${prefix}general_data.json`]: {},
      [`${prefix}Section_1/gnss_session.json`]: { completion_tag: "complete", collection_start_time: date, timeZone: "UTC" },
      [`${prefix}Section_1/_UPLOAD_COMPLETE.json`]: { completed_at_epoch: Date.parse(date) / 1000 },
    };
    const children: Record<string, string[]> = { "client/": ["client/robot/"], "client/robot/": ["client/robot/2026-10-01/"],
      "client/robot/2026-10-01/": [prefix], [prefix]: [`${prefix}Section_1/`, `${prefix}reportgen/`] };
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
    const s3 = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command) return { CommonPrefixes: (children[command.input.Prefix ?? ""] ?? []).map((Prefix) => ({ Prefix })) } as never;
      if (!(command instanceof GetObjectCommand) || !(command.input.Key! in objects)) throw new Error("Unexpected operational enrichment/manifest read");
      return { ETag: '"current"', Body: { transformToString: async () => JSON.stringify(objects[command.input.Key!]) } } as never;
    });
    const detail = await getPortalCatalogBuilding(organizationId, provisionalPortalBuildingId(prefix));
    expect(detail.provisional).toBe(true);
    expect(detail.latestInspection?.availableReportTypes).toEqual(["ASSESSMENT"]);
    expect(detail.latestInspection?.scannedAt).toBe(date);
    expect(s3.mock.calls.some(([command]) => command instanceof GetObjectCommand && command.input.Key?.endsWith("manifest.json"))).toBe(false);
  });

  it("shares the read limit when checking older inspections across multiple hidden buildings", async () => {
    const buildings = Array.from({ length: 4 }, (_, i) => storedBuilding(i + 1, 8));
    const { statuses, peak } = harness(buildings);
    for (const building of buildings) for (const inspection of building.inspections.slice(1)) statuses.set(inspection.sourcePrefix, { reports: {} });
    const rows = await listPortalCatalogBuildings(organizationId);
    expect(rows).toHaveLength(4); // A published older inspection still makes its building visible.
    expect(rows.every((row) => row.latestInspection?.availableReportTypes.length === 0)).toBe(true);
    expect(peak()).toBe(4);
  });

  it("does not turn failed publication reads into empty projects or cached results", async () => {
    const building = storedBuilding(1); const { fail } = harness([building]);
    await expect(listPortalCatalogBuildings(organizationId)).resolves.toHaveLength(1);
    fail(building.inspections[0]!.sourcePrefix);
    await expect(listPortalCatalogBuildings(organizationId)).rejects.toThrow("AccessDenied");
    await expect(getPortalCatalogBuilding(organizationId, building.buildingId)).rejects.toThrow("AccessDenied");
  });

  it.each([
    { clientVisible: false },
    { stale: true },
    { approvedKey: "other/robot/date/building/reportgen/client_portal/assessment.pdf" },
    { sourceKey: "client/robot/date/building/reportgen/client_portal/evidence.pdf" },
  ])("retains publication and ownership checks in lean detail reads: %j", async (override) => {
    const building = storedBuilding(1); const { statuses } = harness([building]);
    const prefix = building.inspections[0]!.sourcePrefix;
    statuses.set(prefix, { reports: { ASSESSMENT: { clientVisible: true, stale: false, approvedKey: `${prefix}reportgen/client_portal/assessment.pdf`, generatedAt: date, ...override } } });
    await expect(getPortalCatalogBuilding(organizationId, building.buildingId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listPortalCatalogBuildings(organizationId)).toEqual([]);
  });

  it("does not load another organization's building", async () => {
    const building = storedBuilding(1); const { s3 } = harness([building]);
    await expect(getPortalCatalogBuilding("org_other_0123456789", building.buildingId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s3.mock.calls.some(([command]) => command instanceof GetObjectCommand && command.input.Key?.endsWith("status.json"))).toBe(false);
  });

  it.each([
    { timestamps: { reportgenApprovedAt: "2026-10-02T12:00:00Z", generatedAt: date, clientApprovedAt: "2026-10-04T12:00:00Z" }, expected: "2026-10-02T12:00:00.000Z" },
    { timestamps: { generatedAt: date, clientApprovedAt: "2026-10-04T12:00:00Z" }, expected: date },
    { timestamps: { clientApprovedAt: "2026-10-04T12:00:00Z", at: date }, expected: "2026-10-04T12:00:00.000Z" },
    { timestamps: { at: date }, expected: date },
    { timestamps: {}, expected: "2026-10-03T12:00:00.000Z" },
  ])("preserves report timestamp precedence and the metadata-only fallback: %j", async ({ timestamps, expected }) => {
    const building = storedBuilding(1); const { statuses, s3 } = harness([building]); const prefix = building.inspections[0]!.sourcePrefix;
    statuses.set(prefix, { reports: { ASSESSMENT: { clientVisible: true, approvedKey: `${prefix}reportgen/client_portal/assessment.pdf`, ...timestamps } } });
    const detail = await getPortalCatalogBuilding(organizationId, building.buildingId);
    expect(detail.latestInspection?.latestReportUpdate).toBe(expected);
    expect(s3.mock.calls.filter(([command]) => command instanceof HeadObjectCommand)).toHaveLength(Object.keys(timestamps).length ? 0 : 1);
  });

  it("keeps the existing approvedAt fallback when optional file timestamp metadata is unavailable", async () => {
    const building = storedBuilding(1); const { statuses, failHead } = harness([building]); const prefix = building.inspections[0]!.sourcePrefix;
    statuses.set(prefix, { reports: { ASSESSMENT: { clientVisible: true, approvedKey: `${prefix}reportgen/client_portal/assessment.pdf`, approvedAt: date } } });
    failHead();
    const detail = await getPortalCatalogBuilding(organizationId, building.buildingId);
    expect(detail.latestInspection?.latestReportUpdate).toBe(date);
    expect(detail.latestInspection?.availableReportTypes).toEqual(["ASSESSMENT"]);
  });
});
