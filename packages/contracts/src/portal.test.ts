import { describe, expect, it } from "vitest";

import {
  portalBuildingDetailSchema,
  portalBuildingIdResponseSchema,
  portalBuildingListResponseSchema,
  updatePortalInspectionRequestSchema,
} from "./portal";

const reportTypes = [
  "ASSESSMENT",
  "EVIDENCE",
  "ROOF_TAKEOFF",
  "AS_BUILT",
  "CAPITAL_PLANNING",
] as const;

describe("portal catalog contracts", () => {
  it("accepts a building detail whose latest inspection includes all five report rows", () => {
    const inspection = {
      inspectionId: "pin_111111111111111111111111",
      scannedAt: "2026-10-01T14:00:00.000Z",
      uploadCompletedAt: "2026-10-01T16:00:00.000Z",
      timeZone: "America/New_York",
      availableReportTypes: ["ASSESSMENT"],
      latestReportUpdate: "2026-10-02T12:00:00.000Z",
      reports: reportTypes.map((reportType) => ({
        reportType,
        deliveryStatus: reportType === "ASSESSMENT" ? "AVAILABLE" : "NOT_INCLUDED",
        publishedAt: reportType === "ASSESSMENT" ? "2026-10-02T12:00:00.000Z" : null,
        filename: reportType === "ASSESSMENT" ? "assessment.pdf" : null,
      })),
    };

    expect(portalBuildingDetailSchema.parse({
      buildingId: "pbl_111111111111111111111111",
      displayName: "Main Tower",
      address: "100 Main Street",
      engineerNames: "Tony, Thom",
      revision: "rev_111111111111111111111111",
      latestInspection: inspection,
      inspectionCount: 1,
      provisional: false,
      inspections: [inspection],
    }).latestInspection?.reports).toHaveLength(5);
  });

  it("requires one pending classification for every report type", () => {
    expect(() => updatePortalInspectionRequestSchema.parse({
      reportStatuses: { ASSESSMENT: "IN_PREPARATION" },
      expectedRevision: "rev_111111111111111111111111",
    })).toThrow();
  });

  it("accepts only an opaque server-resolved building ID", () => {
    expect(portalBuildingIdResponseSchema.parse({
      buildingId: "pbl_111111111111111111111111",
    })).toEqual({ buildingId: "pbl_111111111111111111111111" });
  });

  it("keeps raw source prefixes out of client building-list responses", () => {
    expect(() => portalBuildingListResponseSchema.parse({
      admin: false,
      items: [{
        buildingId: "pbl_111111111111111111111111",
        buildingPrefix: "client/robot/date/building/",
        displayName: "Main Tower",
        address: "100 Main Street",
        engineerNames: "",
        revision: null,
        latestInspection: null,
        inspectionCount: 0,
        provisional: true,
      }],
    })).toThrow();
  });
});
