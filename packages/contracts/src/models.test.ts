import { describe, expect, it } from "vitest";

import {
  inspectionSchema,
  organizationDocumentSchema,
  projectSchema,
  reportSchema,
  reportTypeSchema,
} from "./models";
import { clientSessionSchema } from "./auth";
import {
  createUploadSessionRequestSchema,
  publishInspectionRequestSchema,
} from "./publication";

const id = (name: string) => `${name}_0123456789abcdef`;
const sha256 = "a".repeat(64);

describe("dashboard contracts", () => {
  it("requires encrypted browser-session tokens and absolute expiry", () => {
    expect(() =>
      clientSessionSchema.parse({
        sessionIdHash: "a".repeat(64),
        issuer: "https://issuer.example.com/",
        sub: "subject",
        absoluteExpiresAt: "2026-09-20T14:00:00.000Z",
        ttlExpiresAt: 1,
        revokedAt: null,
      }),
    ).toThrow();
  });
  it("defines exactly four inspection report categories", () => {
    expect(reportTypeSchema.options).toEqual([
      "ASSESSMENT",
      "EVIDENCE",
      "ROOF_TAKEOFF",
      "CAPITAL_PLANNING",
    ]);
  });

  it("keeps How to Read at organization level", () => {
    expect(
      organizationDocumentSchema.parse({
        organizationId: id("org"),
        organizationDocumentId: id("document"),
        documentType: "HOW_TO_READ",
        status: "PUBLISHED",
        currentVersionId: id("document_version"),
      }),
    ).toMatchObject({ documentType: "HOW_TO_READ" });
  });

  it("rejects a published report without a current version", () => {
    const result = reportSchema.safeParse({
      organizationId: id("org"),
      projectId: id("project"),
      inspectionId: id("inspection"),
      reportId: id("report"),
      reportType: "ASSESSMENT",
      deliveryStatus: "PUBLISHED",
      currentVersionId: null,
    });

    expect(result.success).toBe(false);
  });

  it("requires a valid building timezone snapshot", () => {
    expect(
      inspectionSchema.safeParse({
        organizationId: id("org"),
        projectId: id("project"),
        inspectionId: id("inspection"),
        scannedAt: "2026-09-04T14:30:00Z",
        scanTimeZone: "America/New_York",
        lifecycleStatus: "ACTIVE",
        publicationStatus: "DRAFT",
        archivedAt: null,
        archivedByAdminId: null,
        archiveReason: null,
      }).success,
    ).toBe(true);

    expect(
      inspectionSchema.safeParse({
        organizationId: id("org"),
        projectId: id("project"),
        inspectionId: id("inspection"),
        scannedAt: "2026-09-04T14:30:00Z",
        scanTimeZone: "Eastern Time",
        lifecycleStatus: "ACTIVE",
        publicationStatus: "DRAFT",
        archivedAt: null,
        archivedByAdminId: null,
        archiveReason: null,
      }).success,
    ).toBe(false);
  });

  it("requires complete archive metadata and clears it for active records", () => {
    const baseProject = {
      organizationId: id("org"),
      projectId: id("project"),
      displayName: "Midland Business Park",
      address: "4300 West Loop, Fort Worth, TX",
      timeZone: "America/Chicago",
    };
    expect(
      projectSchema.safeParse({
        ...baseProject,
        lifecycleStatus: "ARCHIVED",
        archivedAt: null,
        archivedByAdminId: null,
        archiveReason: null,
      }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({
        ...baseProject,
        lifecycleStatus: "ARCHIVED",
        archivedAt: "2026-09-13T14:00:00.000Z",
        archivedByAdminId: id("admin"),
        archiveReason: "Duplicate project",
      }).success,
    ).toBe(true);
  });

  it("keeps report and organization-document upload targets distinct", () => {
    expect(
      createUploadSessionRequestSchema.parse({
        target: {
          kind: "ORGANIZATION_DOCUMENT",
          organizationId: id("org"),
          documentType: "HOW_TO_READ",
        },
        sizeBytes: 2_000_000,
        sha256,
        contentType: "application/pdf",
        originalFilename: "how-to-read.pdf",
      }).target.kind,
    ).toBe("ORGANIZATION_DOCUMENT");
    expect(
      createUploadSessionRequestSchema.safeParse({
        target: {
          kind: "ORGANIZATION_DOCUMENT",
          organizationId: id("org"),
          documentType: "HOW_TO_READ",
        },
        sizeBytes: 100 * 1024 * 1024 + 1,
        sha256,
        contentType: "application/pdf",
        originalFilename: "too-large.pdf",
      }).success,
    ).toBe(false);
  });

  it("requires the v1 approval attestation and all four classifications", () => {
    const result = publishInspectionRequestSchema.safeParse({
      expectedRevision: "revision-1",
      approvalConfirmed: true,
      approvalStatementVersion: "bdr-approval-v1",
      confirmedProjectId: id("project"),
      classifications: reportTypeSchema.options.map((reportType) => ({
        reportType,
        deliveryStatus: "NOT_INCLUDED",
        uploadSessionId: null,
      })),
    });

    expect(result.success).toBe(true);
  });
});
