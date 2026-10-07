import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPortalCatalogBuilding, resolvePortalArtifact } from "./catalog";
import { loadPortalStatus, provisionalPortalBuildingId, provisionalPortalInspectionId, resolvePortalArtifactSource } from "./buildings";

vi.mock("./buildings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./buildings")>();
  return { ...actual, loadPortalStatus: vi.fn(), resolvePortalArtifactSource: vi.fn() };
});

const prefix = "client/robot/2026-05-13/midland/";
const buildingId = "pbl_111111111111111111111111";
const inspectionId = "pin_111111111111111111111111";
const key = `${prefix}reportgen/client_portal/versions/random-assessment.pdf`;
const building = {
  organizationId: "org-client", buildingId, entityType: "PORTAL_BUILDING", displayName: "Midland Business Park",
  address: "100 Main Street", engineerNames: "Engineer", clientVisible: false, revision: "rev_111111111111111111111111",
  inspections: [{
    inspectionId, sourcePrefix: prefix, sourceId: "source", includedSectionIds: [],
    scannedAt: null, uploadCompletedAt: null, timeZone: "America/New_York",
    reportStatuses: {}, sourceFingerprint: "fingerprint", asBuilt: null,
  }],
};
const publishedStatus = () => ({ reports: { ASSESSMENT: { approvedKey: key, clientVisible: true, stale: false } } });

beforeEach(() => {
  vi.stubEnv("TENANT_DATA_TABLE_NAME", "tenant");
  vi.stubEnv("DATA_BUCKET_NAME", "reports");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.mocked(loadPortalStatus).mockResolvedValue(publishedStatus());
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({ Item: building } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function mockStatus(status: Record<string, unknown>) {
  return vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    if (!(command instanceof GetObjectCommand) || command.input.Key !== `${prefix}reportgen/client_portal/status.json`) {
      throw new Error("Unexpected metadata read");
    }
    return { ETag: '"current"', Body: { transformToString: async () => JSON.stringify(status) } } as never;
  });
}

describe("fresh catalog artifact resolution", () => {
  it("uses one publication read without operational enrichment and returns a friendly filename", async () => {
    const send = mockStatus(publishedStatus());
    await expect(resolvePortalArtifact("org-client", buildingId, inspectionId, "ASSESSMENT"))
      .resolves.toEqual({ key, filename: "Midland Business Park - Roof Assessment.pdf", contentType: "application/pdf" });
    expect(send).toHaveBeenCalledOnce();
    expect(loadPortalStatus).not.toHaveBeenCalled();
    expect(DynamoDBDocumentClient.prototype.send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ ConsistentRead: true, Key: { PK: "ORG#org-client", SK: `PORTAL_BUILDING#${buildingId}` } }),
    }));
  });

  it.each([
    { clientVisible: false, approvedKey: key },
    { clientVisible: true, stale: true, approvedKey: key },
    { clientVisible: true, approvedKey: "other/robot/date/building/reportgen/client_portal/assessment.pdf" },
    { clientVisible: true, approvedKey: `${prefix}reportgen/client_portal/evidence.pdf` },
    { clientVisible: true, approvedKey: `${prefix}raw/assessment.pdf` },
    { clientVisible: true, approvedKey: key, sourceKey: `${prefix}reportgen/client_portal/evidence.pdf` },
  ])("denies unavailable or mismatched publication state: %j", async (report) => {
    mockStatus({ reports: { ASSESSMENT: report } });
    await expect(resolvePortalArtifact("org-client", buildingId, inspectionId, "ASSESSMENT"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("checks publication state again after a report becomes stale", async () => {
    const status = publishedStatus();
    const send = mockStatus(status);
    await resolvePortalArtifact("org-client", buildingId, inspectionId, "ASSESSMENT");
    status.reports.ASSESSMENT.stale = true;
    await expect(resolvePortalArtifact("org-client", buildingId, inspectionId, "ASSESSMENT"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("accepts an opaque approved filename when its authoritative source matches the report type", async () => {
    const opaqueKey = `${prefix}reportgen/client_portal/versions/4f8c1234.pdf`;
    mockStatus({ reports: { ASSESSMENT: { clientVisible: true, approvedKey: opaqueKey, sourceKey: key } } });
    await expect(resolvePortalArtifact("org-client", buildingId, inspectionId, "ASSESSMENT"))
      .resolves.toMatchObject({ key: opaqueKey, filename: "Midland Business Park - Roof Assessment.pdf" });
  });

  it("does not trust a stored record for another organization or inspection", async () => {
    await expect(resolvePortalArtifact("org-other", buildingId, inspectionId, "ASSESSMENT"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resolvePortalArtifact("org-client", buildingId, "pin_other", "ASSESSMENT"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(loadPortalStatus).not.toHaveBeenCalled();
  });

  it("preserves fail-closed S3 errors", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(new Error("AccessDenied"));
    await expect(resolvePortalArtifact("org-client", buildingId, inspectionId, "ASSESSMENT"))
      .rejects.toThrow("AccessDenied");
  });

  it("uses the same friendly filename in catalog detail", async () => {
    const detail = await getPortalCatalogBuilding("org-client", buildingId);
    expect(detail.latestInspection?.reports.find((report) => report.reportType === "ASSESSMENT")?.filename)
      .toBe("Midland Business Park - Roof Assessment.pdf");
  });

  it("resolves provisional inspections without reconstructing section metadata, and denies claimed sources", async () => {
    vi.mocked(resolvePortalArtifactSource).mockResolvedValue({ prefix, displayName: "Midland Business Park", status: publishedStatus() });
    const send = vi.mocked(DynamoDBDocumentClient.prototype.send).mockImplementation(async (command) => {
      if (command instanceof GetCommand) return {} as never;
      if (command instanceof BatchGetCommand) return { Responses: { tenant: [] } } as never;
      throw new Error("Unexpected command");
    });
    await expect(resolvePortalArtifact("org-client", provisionalPortalBuildingId(prefix), provisionalPortalInspectionId(prefix), "ASSESSMENT"))
      .resolves.toMatchObject({ filename: "Midland Business Park - Roof Assessment.pdf" });
    expect(resolvePortalArtifactSource).toHaveBeenCalledWith("org-client", provisionalPortalBuildingId(prefix));
    expect(loadPortalStatus).not.toHaveBeenCalled();
    send.mockImplementation(async (command) => command instanceof GetCommand ? {} as never : {
      Responses: { tenant: [{ PK: "claimed", SK: "PROFILE" }] },
    } as never);
    await expect(resolvePortalArtifact("org-client", provisionalPortalBuildingId(prefix), provisionalPortalInspectionId(prefix), "ASSESSMENT"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("only serves an As-built published pointer belonging to the requested building and inspection", async () => {
    const asBuilt = {
      key: `reportgen_portal/as-built/org-client/${buildingId}/${inspectionId}/drafts/upl_${"a".repeat(32)}/as-built.png`,
      filename: "random.png", contentType: "image/png", sizeBytes: 10, publishedAt: "2026-10-01T00:00:00Z",
    };
    vi.mocked(DynamoDBDocumentClient.prototype.send).mockResolvedValue({
      Item: { ...building, inspections: [{ ...building.inspections[0], asBuilt }] },
    } as never);
    const s3 = vi.spyOn(S3Client.prototype, "send");
    await expect(resolvePortalArtifact("org-client", buildingId, inspectionId, "AS_BUILT"))
      .resolves.toMatchObject({ filename: "Midland Business Park - As-built.png", contentType: "image/png" });
    expect(s3).not.toHaveBeenCalled();
    asBuilt.key = asBuilt.key.replace("org-client", "org-other");
    await expect(resolvePortalArtifact("org-client", buildingId, inspectionId, "AS_BUILT"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
