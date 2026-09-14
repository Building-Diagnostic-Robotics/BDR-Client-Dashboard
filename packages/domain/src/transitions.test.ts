import { describe, expect, it } from "vitest";

import type { Project, PublishInspectionRequest, Report } from "@bdr/contracts";

import { DomainError } from "./errors";
import {
  archiveInspection,
  createInspection,
  publishInspection,
  restoreInspection,
  validateInspectionPublication,
  withdrawReport,
} from "./transitions";

const organizationId = "org_0123456789abcdef";
const project: Project = {
  organizationId,
  projectId: "project_0123456789abcdef",
  displayName: "Midland Business Park",
  address: "4300 West Loop, Fort Worth, TX",
  timeZone: "America/Chicago",
  lifecycleStatus: "ACTIVE",
  archivedAt: null,
  archivedByAdminId: null,
  archiveReason: null,
};

const inspection = createInspection({
  organizationId,
  project,
  inspectionId: "inspection_0123456789abcdef",
  scannedAt: "2026-09-04T14:30:00.000Z",
});

const publication: PublishInspectionRequest = {
  expectedRevision: "revision-1",
  approvalConfirmed: true,
  approvalStatementVersion: "bdr-approval-v1",
  confirmedProjectId: project.projectId,
  classifications: [
    {
      reportType: "ASSESSMENT",
      deliveryStatus: "PUBLISHED",
      uploadSessionId: "upload_0123456789abcdef",
    },
    { reportType: "EVIDENCE", deliveryStatus: "EXPECTED", uploadSessionId: null },
    { reportType: "ROOF_TAKEOFF", deliveryStatus: "NOT_INCLUDED", uploadSessionId: null },
    {
      reportType: "CAPITAL_PLANNING",
      deliveryStatus: "NOT_APPLICABLE",
      uploadSessionId: null,
    },
  ],
};

describe("domain transitions", () => {
  it("copies the building timezone into the immutable inspection snapshot", () => {
    expect(inspection.scanTimeZone).toBe("America/Chicago");
    expect(inspection.publicationStatus).toBe("DRAFT");
  });

  it("validates revision, project confirmation, all categories, and a published report", () => {
    expect(() =>
      validateInspectionPublication(inspection, publication, "revision-1"),
    ).not.toThrow();
    expect(publishInspection(inspection, publication, "revision-1").publicationStatus).toBe(
      "PUBLISHED",
    );
    expect(() =>
      validateInspectionPublication(inspection, publication, "revision-2"),
    ).toThrowError(DomainError);
    expect(() =>
      validateInspectionPublication(
        inspection,
        { ...publication, classifications: publication.classifications.slice(0, 3) },
        "revision-1",
      ),
    ).toThrowError(DomainError);
  });

  it("archives and restores an inspection without changing publication state", () => {
    const published = { ...inspection, publicationStatus: "PUBLISHED" as const };
    expect(
      restoreInspection(
        archiveInspection(published, {
          archivedAt: "2026-09-13T14:00:00.000Z",
          archivedByAdminId: "admin_0123456789abcdef",
          reason: "Duplicate scan",
        }),
      ),
    ).toEqual(published);
  });

  it("withdraws access while retaining the report identity", () => {
    const report: Report = {
      organizationId,
      projectId: project.projectId,
      inspectionId: inspection.inspectionId,
      reportId: "report_0123456789abcdef",
      reportType: "ASSESSMENT",
      deliveryStatus: "PUBLISHED",
      currentVersionId: "version_0123456789abcdef",
    };
    expect(withdrawReport(report, "EXPECTED")).toEqual({
      ...report,
      deliveryStatus: "EXPECTED",
      currentVersionId: null,
    });
  });
});
