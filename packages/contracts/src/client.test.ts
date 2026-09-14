import { describe, expect, it } from "vitest";

import {
  clientInspectionSchema,
  clientMeResponseSchema,
  clientProjectSchema,
  clientReportMetadataSchema,
} from "./client";

describe("client response contracts", () => {
  it("rejects internal organization and user identifiers", () => {
    expect(clientMeResponseSchema.safeParse({
      userId: "user_0123456789abcdef",
      organization: {
        organizationId: "org_0123456789abcdef",
        displayName: "Midland Holdings",
        status: "ACTIVE",
      },
    }).success).toBe(false);
  });

  it("rejects lifecycle and ownership fields in project and inspection responses", () => {
    expect(clientProjectSchema.safeParse({
      organizationId: "org_0123456789abcdef",
      projectId: "project_0123456789abcdef",
      displayName: "Midland Business Park",
      address: "4300 West Loop, Fort Worth, TX",
      timeZone: "America/Chicago",
      lifecycleStatus: "ACTIVE",
    }).success).toBe(false);

    expect(clientInspectionSchema.safeParse({
      projectId: "project_0123456789abcdef",
      inspectionId: "inspection_0123456789abcdef",
      scannedAt: "2026-09-04T14:30:00.000Z",
      scanTimeZone: "America/Chicago",
      publicationStatus: "PUBLISHED",
    }).success).toBe(false);
  });

  it("rejects report and version identifiers in report metadata", () => {
    expect(clientReportMetadataSchema.safeParse({
      reportId: "report_0123456789abcdef",
      reportType: "ASSESSMENT",
      deliveryStatus: "PUBLISHED",
      currentVersionId: "version_0123456789abcdef",
      publishedAt: "2026-09-07T15:00:00.000Z",
    }).success).toBe(false);
  });
});
