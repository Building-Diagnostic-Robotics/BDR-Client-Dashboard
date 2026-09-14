import { describe, expect, it } from "vitest";

import type {
  ClientIdentity,
  ClientSession,
  DocumentVersion,
  Inspection,
  Organization,
  OrganizationDocument,
  Project,
  Report,
  ReportVersion,
} from "@bdr/contracts";

import { DomainError } from "./errors";
import { publishedArtifactKey, sha256, type DynamoKey } from "./keys";
import {
  ClientVisibilityPolicy,
  type ClientVisibilityRepository,
  type ConsistentRead,
} from "./visibility";

const organizationId = "org_0123456789abcdef";
const projectId = "project_0123456789abcdef";
const inspectionId = "inspection_0123456789abcdef";
const reportVersionId = "report_version_0123456789abcdef";
const documentVersionId = "document_version_0123456789abcdef";
const rawSessionId = "unguessable-client-session";

class FixtureRepository implements ClientVisibilityRepository {
  readonly reads: Array<{ key: DynamoKey; consistent: boolean }> = [];

  session: ClientSession | null = {
    sessionIdHash: sha256(rawSessionId),
    issuer: "https://client.example.com/",
    sub: "client-subject",
    accessTokenCiphertext: "encrypted-access",
    refreshTokenCiphertext: "encrypted-refresh",
    accessTokenExpiresAt: "2026-09-13T14:15:00.000Z",
    csrfTokenHash: sha256("csrf-token"),
    absoluteExpiresAt: "2026-09-14T00:00:00.000Z",
    ttlExpiresAt: 1,
    revokedAt: null,
  };

  identity: ClientIdentity | null = {
    issuer: "https://client.example.com/",
    sub: "client-subject",
    userId: "user_0123456789abcdef",
    organizationId,
    status: "ACTIVE",
  };

  organization: Organization | null = {
    organizationId,
    displayName: "Midland Holdings",
    status: "ACTIVE",
  };

  project: Project | null = {
    organizationId,
    projectId,
    displayName: "Midland Business Park",
    address: "4300 West Loop, Fort Worth, TX",
    timeZone: "America/Chicago",
    lifecycleStatus: "ACTIVE",
    archivedAt: null,
    archivedByAdminId: null,
    archiveReason: null,
  };

  inspection: Inspection | null = {
    organizationId,
    projectId,
    inspectionId,
    scannedAt: "2026-09-04T14:30:00.000Z",
    scanTimeZone: "America/Chicago",
    lifecycleStatus: "ACTIVE",
    publicationStatus: "PUBLISHED",
    archivedAt: null,
    archivedByAdminId: null,
    archiveReason: null,
  };

  report: Report | null = {
    organizationId,
    projectId,
    inspectionId,
    reportId: "report_0123456789abcdef",
    reportType: "ASSESSMENT",
    deliveryStatus: "PUBLISHED",
    currentVersionId: reportVersionId,
  };

  reportVersion: ReportVersion | null = {
    organizationId,
    projectId,
    inspectionId,
    reportType: "ASSESSMENT",
    reportVersionId,
    s3Key: publishedArtifactKey(reportVersionId),
    s3VersionId: "s3-report-version",
    sha256: "a".repeat(64),
    sizeBytes: 2_000_000,
    contentType: "application/pdf",
    integrityStatus: "VERIFIED",
    publishedAt: "2026-09-07T15:00:00.000Z",
    publishedByAdminId: "admin_0123456789abcdef",
  };

  organizationDocument: OrganizationDocument | null = {
    organizationId,
    organizationDocumentId: "document_0123456789abcdef",
    documentType: "HOW_TO_READ",
    status: "PUBLISHED",
    currentVersionId: documentVersionId,
  };

  documentVersion: DocumentVersion | null = {
    organizationId,
    documentType: "HOW_TO_READ",
    documentVersionId,
    s3Key: publishedArtifactKey(documentVersionId),
    s3VersionId: "s3-document-version",
    sha256: "b".repeat(64),
    sizeBytes: 1_000_000,
    contentType: "application/pdf",
    integrityStatus: "VERIFIED",
    publishedAt: "2026-08-18T15:00:00.000Z",
    publishedByAdminId: "admin_0123456789abcdef",
  };

  private record(key: DynamoKey, options: ConsistentRead): void {
    this.reads.push({ key, consistent: options.consistentRead });
  }

  async getClientSession(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.session;
  }
  async getClientIdentity(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.identity;
  }
  async getOrganization(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.organization;
  }
  async getProject(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.project;
  }
  async getInspection(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.inspection;
  }
  async getReport(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.report;
  }
  async getReportVersion(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.reportVersion;
  }
  async getOrganizationDocument(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.organizationDocument;
  }
  async getDocumentVersion(key: DynamoKey, options: ConsistentRead) {
    this.record(key, options);
    return this.documentVersion;
  }
  async queryProjects(organizationPk: string, options: ConsistentRead) {
    this.record({ PK: organizationPk, SK: "PROJECT#" }, options);
    return this.project ? [this.project] : [];
  }
  async queryInspections(
    organizationPk: string,
    requestedProjectId: string,
    options: ConsistentRead,
  ) {
    this.record({ PK: organizationPk, SK: `INSPECTION#${requestedProjectId}#` }, options);
    return this.inspection ? [this.inspection] : [];
  }
  async queryReports(
    organizationPk: string,
    requestedProjectId: string,
    requestedInspectionId: string,
    options: ConsistentRead,
  ) {
    this.record(
      {
        PK: organizationPk,
        SK: `REPORT#${requestedProjectId}#${requestedInspectionId}#`,
      },
      options,
    );
    return this.report ? [this.report] : [];
  }
}

async function context(repository: FixtureRepository) {
  return new ClientVisibilityPolicy(repository).loadActiveClientContext({
    rawSessionId,
    now: new Date("2026-09-13T14:00:00.000Z"),
  });
}

describe("central client visibility policy", () => {
  it("uses strongly consistent base reads for session, identity, and organization", async () => {
    const repository = new FixtureRepository();
    await expect(context(repository)).resolves.toMatchObject({
      userId: "user_0123456789abcdef",
      organization: { organizationId },
    });
    expect(repository.reads).toHaveLength(3);
    expect(repository.reads.every(({ consistent }) => consistent)).toBe(true);
  });

  it("rejects expired sessions before identity or tenant data is loaded", async () => {
    const repository = new FixtureRepository();
    repository.session = {
      ...repository.session!,
      absoluteExpiresAt: "2026-09-13T13:59:59.000Z",
      ttlExpiresAt: 9_999_999_999,
    };
    await expect(context(repository)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(repository.reads).toHaveLength(1);
  });

  it("authorizes only the exact current verified report object", async () => {
    const repository = new FixtureRepository();
    const policy = new ClientVisibilityPolicy(repository);
    const clientContext = await context(repository);
    await expect(
      policy.authorizeCurrentReportAccess({
        context: clientContext,
        projectId,
        inspectionId,
        reportType: "ASSESSMENT",
        disposition: "DOWNLOAD",
      }),
    ).resolves.toEqual({
      key: publishedArtifactKey(reportVersionId),
      versionId: "s3-report-version",
      disposition: "DOWNLOAD",
      filename: "Midland-Business-Park-Roof-Assessment-2026-09-04.pdf",
    });
  });

  it("returns the same not-found error for draft ancestors and mismatched versions", async () => {
    const repository = new FixtureRepository();
    const policy = new ClientVisibilityPolicy(repository);
    const clientContext = await context(repository);
    repository.inspection = { ...repository.inspection!, publicationStatus: "DRAFT" };
    await expect(
      policy.authorizeCurrentReportAccess({
        context: clientContext,
        projectId,
        inspectionId,
        reportType: "ASSESSMENT",
        disposition: "VIEW",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    repository.inspection = { ...repository.inspection!, publicationStatus: "PUBLISHED" };
    repository.reportVersion = {
      ...repository.reportVersion!,
      s3Key: "versions/other_0123456789abcdef.pdf",
    };
    await expect(
      policy.authorizeCurrentReportAccess({
        context: clientContext,
        projectId,
        inspectionId,
        reportType: "ASSESSMENT",
        disposition: "VIEW",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not authorize metadata-only report states", async () => {
    const repository = new FixtureRepository();
    const policy = new ClientVisibilityPolicy(repository);
    const clientContext = await context(repository);
    repository.report = {
      ...repository.report!,
      deliveryStatus: "EXPECTED",
      currentVersionId: null,
    };
    await expect(
      policy.authorizeCurrentReportAccess({
        context: clientContext,
        projectId,
        inspectionId,
        reportType: "ASSESSMENT",
        disposition: "VIEW",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a record whose attributes claim a foreign organization", async () => {
    const repository = new FixtureRepository();
    const policy = new ClientVisibilityPolicy(repository);
    const clientContext = await context(repository);
    repository.project = {
      ...repository.project!,
      organizationId: "foreign_0123456789abcdef",
    };
    await expect(policy.loadVisibleProject(clientContext, projectId)).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it("authorizes How to Read without loading a project or inspection", async () => {
    const repository = new FixtureRepository();
    const policy = new ClientVisibilityPolicy(repository);
    const clientContext = await context(repository);
    repository.reads.length = 0;

    await expect(
      policy.authorizeCurrentOrganizationDocumentAccess({
        context: clientContext,
        disposition: "VIEW",
      }),
    ).resolves.toEqual({
      key: publishedArtifactKey(documentVersionId),
      versionId: "s3-document-version",
      disposition: "VIEW",
      filename: "Midland-Holdings-How-to-Read.pdf",
    });
    expect(repository.reads).toHaveLength(2);
    expect(repository.reads.some(({ key }) => key.SK.startsWith("PROJECT#"))).toBe(false);
  });

  it("keeps draft How to Read documents invisible", async () => {
    const repository = new FixtureRepository();
    const policy = new ClientVisibilityPolicy(repository);
    const clientContext = await context(repository);
    repository.organizationDocument = {
      ...repository.organizationDocument!,
      status: "DRAFT",
      currentVersionId: null,
    };
    await expect(
      policy.authorizeCurrentOrganizationDocumentAccess({
        context: clientContext,
        disposition: "VIEW",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
