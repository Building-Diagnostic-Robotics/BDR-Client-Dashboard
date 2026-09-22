import type {
  ClientIdentity,
  ClientSession,
  DocumentVersion,
  Inspection,
  Organization,
  OrganizationDocument,
  Project,
  Report,
  ReportType,
  ReportVersion,
} from "@bdr/contracts";

import { authenticationRequired, forbidden, notFound } from "./errors";
import {
  identityKeys,
  publishedArtifactKey,
  sessionKeys,
  tenantKeys,
  type DynamoKey,
} from "./keys";
import { assertActiveClientSession } from "./sessions";

export type ConsistentRead = Readonly<{ consistentRead: true }>;

export interface ClientContextRepository {
  getClientSession(key: DynamoKey, options: ConsistentRead): Promise<ClientSession | null>;
  getClientIdentity(key: DynamoKey, options: ConsistentRead): Promise<ClientIdentity | null>;
  getOrganization(key: DynamoKey, options: ConsistentRead): Promise<Organization | null>;
}

export interface ClientVisibilityRepository extends ClientContextRepository {
  getProject(key: DynamoKey, options: ConsistentRead): Promise<Project | null>;
  getInspection(key: DynamoKey, options: ConsistentRead): Promise<Inspection | null>;
  getReport(key: DynamoKey, options: ConsistentRead): Promise<Report | null>;
  getReportVersion(key: DynamoKey, options: ConsistentRead): Promise<ReportVersion | null>;
  getOrganizationDocument(
    key: DynamoKey,
    options: ConsistentRead,
  ): Promise<OrganizationDocument | null>;
  getDocumentVersion(key: DynamoKey, options: ConsistentRead): Promise<DocumentVersion | null>;
  queryProjects(organizationPk: string, options: ConsistentRead): Promise<readonly Project[]>;
  queryInspections(
    organizationPk: string,
    projectId: string,
    options: ConsistentRead,
  ): Promise<readonly Inspection[]>;
  queryReports(
    organizationPk: string,
    projectId: string,
    inspectionId: string,
    options: ConsistentRead,
  ): Promise<readonly Report[]>;
}

const clientContextBrand: unique symbol = Symbol("ClientContext");

export type ClientContext = Readonly<{
  issuer: string;
  sub: string;
  userId: string;
  organization: Organization;
  [clientContextBrand]: true;
}>;

export type ArtifactDisposition = "VIEW" | "DOWNLOAD";

export type AuthorizedArtifact = Readonly<{
  key: string;
  versionId: string;
  disposition: ArtifactDisposition;
  filename: string;
  publishedAt: string;
}>;

export type VisibleReportMetadata = Readonly<{
  reportType: ReportType;
  deliveryStatus: Report["deliveryStatus"];
  publishedAt: string | null;
}>;

export type LatestInspectionSummary = Readonly<{
  scannedAt: string;
  scanTimeZone: string;
  overallStatus: "PUBLISHED" | "EXPECTED" | "NONE";
}>;

const consistentRead = { consistentRead: true } as const;

export type ActiveClientAuthentication = Readonly<{
  context: ClientContext;
  session: ClientSession;
  identity: ClientIdentity;
}>;

export async function loadActiveClientAuthentication(
  repository: ClientContextRepository,
  input: { rawSessionId: string; now: Date },
): Promise<ActiveClientAuthentication> {
  const session = await repository.getClientSession(
    sessionKeys.clientSession(input.rawSessionId),
    consistentRead,
  );
  assertActiveClientSession(session, input.rawSessionId, input.now);

  const identity = await repository.getClientIdentity(
    identityKeys.subject(session.issuer, session.sub),
    consistentRead,
  );
  if (!identity || identity.issuer !== session.issuer || identity.sub !== session.sub) {
    authenticationRequired();
  }
  if (identity.status !== "ACTIVE") forbidden();

  const organization = await repository.getOrganization(
    tenantKeys.organization(identity.organizationId),
    consistentRead,
  );
  if (
    !organization ||
    organization.organizationId !== identity.organizationId ||
    organization.status !== "ACTIVE"
  ) {
    forbidden();
  }

  return {
    session,
    identity,
    context: {
      issuer: session.issuer,
      sub: session.sub,
      userId: identity.userId,
      organization,
      [clientContextBrand]: true,
    } as ClientContext,
  };
}

function safeFilename(parts: readonly string[]): string {
  const stem = parts
    .join("-")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 116);
  return `${stem || "report"}.pdf`;
}

function reportName(reportType: ReportType): string {
  return {
    ASSESSMENT: "Roof-Assessment",
    EVIDENCE: "Inspection-Evidence",
    ROOF_TAKEOFF: "Roof-Takeoff",
    CAPITAL_PLANNING: "Capital-Planning",
  }[reportType];
}

export class ClientVisibilityPolicy {
  constructor(private readonly repository: ClientVisibilityRepository) {}

  async loadActiveClientContext(input: {
    rawSessionId: string;
    now: Date;
  }): Promise<ClientContext> {
    return (await loadActiveClientAuthentication(this.repository, input)).context;
  }

  async loadVisibleProject(context: ClientContext, projectId: string): Promise<Project> {
    const project = await this.repository.getProject(
      tenantKeys.project(context.organization.organizationId, projectId),
      consistentRead,
    );
    if (
      !project ||
      project.organizationId !== context.organization.organizationId ||
      project.projectId !== projectId ||
      project.lifecycleStatus !== "ACTIVE"
    ) {
      notFound();
    }
    return project;
  }

  async loadVisibleInspection(
    context: ClientContext,
    projectId: string,
    inspectionId: string,
  ): Promise<Inspection> {
    await this.loadVisibleProject(context, projectId);
    const inspection = await this.repository.getInspection(
      tenantKeys.inspection(context.organization.organizationId, projectId, inspectionId),
      consistentRead,
    );
    if (
      !inspection ||
      inspection.organizationId !== context.organization.organizationId ||
      inspection.projectId !== projectId ||
      inspection.inspectionId !== inspectionId ||
      inspection.lifecycleStatus !== "ACTIVE" ||
      inspection.publicationStatus !== "PUBLISHED"
    ) {
      notFound();
    }
    return inspection;
  }

  async authorizeCurrentReportAccess(input: {
    context: ClientContext;
    projectId: string;
    inspectionId: string;
    reportType: ReportType;
    disposition: ArtifactDisposition;
  }): Promise<AuthorizedArtifact> {
    const inspection = await this.loadVisibleInspection(
      input.context,
      input.projectId,
      input.inspectionId,
    );
    const organizationId = input.context.organization.organizationId;
    const report = await this.repository.getReport(
      tenantKeys.report(organizationId, input.projectId, input.inspectionId, input.reportType),
      consistentRead,
    );
    if (!report) notFound();
    const version = await this.loadCurrentReportVersion(
      organizationId,
      input.projectId,
      input.inspectionId,
      input.reportType,
      report,
    );

    const project = await this.loadVisibleProject(input.context, input.projectId);
    return {
      key: version.s3Key,
      versionId: version.s3VersionId,
      disposition: input.disposition,
      filename: safeFilename([
        project.displayName,
        reportName(input.reportType),
        inspection.scannedAt.slice(0, 10),
      ]),
      publishedAt: version.publishedAt,
    };
  }

  async authorizeCurrentOrganizationDocumentAccess(input: {
    context: ClientContext;
    disposition: ArtifactDisposition;
  }): Promise<AuthorizedArtifact> {
    const organizationId = input.context.organization.organizationId;
    const document = await this.repository.getOrganizationDocument(
      tenantKeys.organizationDocument(organizationId),
      consistentRead,
    );
    if (
      !document ||
      document.organizationId !== organizationId ||
      document.documentType !== "HOW_TO_READ" ||
      document.status !== "PUBLISHED" ||
      document.currentVersionId === null
    ) {
      notFound();
    }

    const version = await this.repository.getDocumentVersion(
      tenantKeys.documentVersion(organizationId, document.currentVersionId),
      consistentRead,
    );
    if (
      !version ||
      version.organizationId !== organizationId ||
      version.documentType !== "HOW_TO_READ" ||
      version.documentVersionId !== document.currentVersionId ||
      version.integrityStatus !== "VERIFIED" ||
      version.s3Key !== publishedArtifactKey(document.currentVersionId) ||
      !version.s3VersionId
    ) {
      notFound();
    }

    return {
      key: version.s3Key,
      versionId: version.s3VersionId,
      disposition: input.disposition,
      filename: safeFilename([input.context.organization.displayName, "How-to-Read"]),
      publishedAt: version.publishedAt,
    };
  }

  async listVisibleProjects(context: ClientContext): Promise<readonly Project[]> {
    const organizationId = context.organization.organizationId;
    const organizationPk = tenantKeys.organization(organizationId).PK;
    const projects = await this.repository.queryProjects(organizationPk, consistentRead);
    return projects.filter(
      (project) =>
        project.organizationId === organizationId && project.lifecycleStatus === "ACTIVE",
    );
  }

  /**
   * Returns the scan date and rolled-up report status for the most recent
   * published inspection of `projectId`, or null if none exists.
   *
   * overallStatus derivation (evaluated only on ACTIVE, PUBLISHED inspections):
   *   PUBLISHED – ≥1 report is PUBLISHED, none EXPECTED
   *   EXPECTED  – ≥1 report is EXPECTED (PUBLISHED may also be present)
   *   NONE      – all reports are NOT_INCLUDED or NOT_APPLICABLE
   */
  async latestInspectionSummaryForProject(
    context: ClientContext,
    project: Project,
  ): Promise<LatestInspectionSummary | null> {
    const organizationId = context.organization.organizationId;
    const organizationPk = tenantKeys.organization(organizationId).PK;
    const inspections = await this.repository.queryInspections(
      organizationPk,
      project.projectId,
      consistentRead,
    );
    const visible = inspections
      .filter(
        (i) =>
          i.organizationId === organizationId &&
          i.projectId === project.projectId &&
          i.lifecycleStatus === "ACTIVE" &&
          i.publicationStatus === "PUBLISHED",
      )
      .slice()
      .sort((a, b) => Date.parse(b.scannedAt) - Date.parse(a.scannedAt));

    const latest = visible[0];
    if (!latest) return null;

    const reports = await this.repository.queryReports(
      organizationPk,
      project.projectId,
      latest.inspectionId,
      consistentRead,
    );
    const validReports = reports.filter(
      (r) =>
        r.organizationId === organizationId &&
        r.projectId === project.projectId &&
        r.inspectionId === latest.inspectionId,
    );

    let overallStatus: LatestInspectionSummary["overallStatus"] = "NONE";
    for (const report of validReports) {
      if (report.deliveryStatus === "EXPECTED") {
        overallStatus = "EXPECTED";
        break;
      }
      if (report.deliveryStatus === "PUBLISHED") {
        overallStatus = "PUBLISHED";
      }
    }

    return {
      scannedAt: latest.scannedAt,
      scanTimeZone: latest.scanTimeZone,
      overallStatus,
    };
  }

  async listVisibleInspections(
    context: ClientContext,
    projectId: string,
  ): Promise<readonly Inspection[]> {
    await this.loadVisibleProject(context, projectId);
    const organizationId = context.organization.organizationId;
    const inspections = await this.repository.queryInspections(
      tenantKeys.organization(organizationId).PK,
      projectId,
      consistentRead,
    );
    return inspections
      .filter(
        (inspection) =>
          inspection.organizationId === organizationId &&
          inspection.projectId === projectId &&
          inspection.lifecycleStatus === "ACTIVE" &&
          inspection.publicationStatus === "PUBLISHED",
      )
      .slice()
      .sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt));
  }

  async listVisibleReportMetadata(
    context: ClientContext,
    projectId: string,
    inspectionId: string,
  ): Promise<readonly VisibleReportMetadata[]> {
    await this.loadVisibleInspection(context, projectId, inspectionId);
    const organizationId = context.organization.organizationId;
    const reports = await this.repository.queryReports(
      tenantKeys.organization(organizationId).PK,
      projectId,
      inspectionId,
      consistentRead,
    );
    const visibleReports = reports.filter(
      (report) =>
        report.organizationId === organizationId &&
        report.projectId === projectId &&
        report.inspectionId === inspectionId,
    );

    return Promise.all(visibleReports.map(async (report) => {
      if (report.deliveryStatus !== "PUBLISHED") {
        return {
          reportType: report.reportType,
          deliveryStatus: report.deliveryStatus,
          publishedAt: null,
        };
      }
      const version = await this.loadCurrentReportVersion(
        organizationId,
        projectId,
        inspectionId,
        report.reportType,
        report,
      );
      return {
        reportType: report.reportType,
        deliveryStatus: report.deliveryStatus,
        publishedAt: version.publishedAt,
      };
    }));
  }

  private async loadCurrentReportVersion(
    organizationId: string,
    projectId: string,
    inspectionId: string,
    reportType: ReportType,
    report: Report,
  ): Promise<ReportVersion> {
    if (
      report.organizationId !== organizationId ||
      report.projectId !== projectId ||
      report.inspectionId !== inspectionId ||
      report.reportType !== reportType ||
      report.deliveryStatus !== "PUBLISHED" ||
      report.currentVersionId === null
    ) {
      notFound();
    }

    const version = await this.repository.getReportVersion(
      tenantKeys.reportVersion(
        organizationId,
        projectId,
        inspectionId,
        reportType,
        report.currentVersionId,
      ),
      consistentRead,
    );
    if (
      !version ||
      version.organizationId !== organizationId ||
      version.projectId !== projectId ||
      version.inspectionId !== inspectionId ||
      version.reportType !== reportType ||
      version.reportVersionId !== report.currentVersionId ||
      version.integrityStatus !== "VERIFIED" ||
      version.s3Key !== publishedArtifactKey(report.currentVersionId) ||
      !version.s3VersionId
    ) {
      notFound();
    }
    return version;
  }
}
