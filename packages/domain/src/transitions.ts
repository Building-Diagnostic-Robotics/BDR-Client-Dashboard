import type {
  Inspection,
  OrganizationDocument,
  Project,
  PublishInspectionRequest,
  Report,
  ReportDeliveryStatus,
  ReportType,
} from "@bdr/contracts";

import { conflict, invalidState } from "./errors";

const reportTypes: readonly ReportType[] = [
  "ASSESSMENT",
  "EVIDENCE",
  "ROOF_TAKEOFF",
  "CAPITAL_PLANNING",
];

export function createInspection(input: {
  organizationId: string;
  project: Project;
  inspectionId: string;
  scannedAt: string;
}): Inspection {
  if (
    input.project.organizationId !== input.organizationId ||
    input.project.lifecycleStatus !== "ACTIVE"
  ) {
    invalidState("Inspection requires an active project in the same organization");
  }
  if (!Number.isFinite(Date.parse(input.scannedAt))) {
    invalidState("Inspection scan time is invalid");
  }

  return {
    organizationId: input.organizationId,
    projectId: input.project.projectId,
    inspectionId: input.inspectionId,
    scannedAt: input.scannedAt,
    scanTimeZone: input.project.timeZone,
    lifecycleStatus: "ACTIVE",
    publicationStatus: "DRAFT",
    archivedAt: null,
    archivedByAdminId: null,
    archiveReason: null,
  };
}

export function validateInspectionPublication(
  inspection: Inspection,
  request: PublishInspectionRequest,
  currentRevision: string,
): void {
  if (inspection.lifecycleStatus !== "ACTIVE" || inspection.publicationStatus !== "DRAFT") {
    invalidState("Only an active draft inspection can be published");
  }
  if (request.confirmedProjectId !== inspection.projectId) {
    invalidState("Confirmed project does not match the inspection");
  }
  if (request.expectedRevision !== currentRevision) {
    conflict();
  }

  const classifiedTypes = new Set(request.classifications.map(({ reportType }) => reportType));
  if (
    classifiedTypes.size !== reportTypes.length ||
    reportTypes.some((reportType) => !classifiedTypes.has(reportType))
  ) {
    invalidState("Every inspection report category must be classified exactly once");
  }
  if (!request.classifications.some(({ deliveryStatus }) => deliveryStatus === "PUBLISHED")) {
    invalidState("At least one report must be ready for publication");
  }
}

export function publishInspection(
  inspection: Inspection,
  request: PublishInspectionRequest,
  currentRevision: string,
): Inspection {
  validateInspectionPublication(inspection, request, currentRevision);
  return { ...inspection, publicationStatus: "PUBLISHED" };
}

type ArchiveInput = Readonly<{
  archivedAt: string;
  archivedByAdminId: string;
  reason: string;
}>;

export function archiveProject(project: Project, archive: ArchiveInput): Project {
  if (project.lifecycleStatus !== "ACTIVE") {
    invalidState("Only an active project can be archived");
  }
  if (!archive.reason.trim()) {
    invalidState("Archive reason is required");
  }
  return {
    ...project,
    lifecycleStatus: "ARCHIVED",
    archivedAt: archive.archivedAt,
    archivedByAdminId: archive.archivedByAdminId,
    archiveReason: archive.reason.trim(),
  };
}

export function restoreProject(project: Project): Project {
  if (project.lifecycleStatus !== "ARCHIVED") {
    invalidState("Only an archived project can be restored");
  }
  return {
    ...project,
    lifecycleStatus: "ACTIVE",
    archivedAt: null,
    archivedByAdminId: null,
    archiveReason: null,
  };
}

export function archiveInspection(inspection: Inspection, archive: ArchiveInput): Inspection {
  if (inspection.lifecycleStatus !== "ACTIVE") {
    invalidState("Only an active inspection can be archived");
  }
  if (!archive.reason.trim()) {
    invalidState("Archive reason is required");
  }
  return {
    ...inspection,
    lifecycleStatus: "ARCHIVED",
    archivedAt: archive.archivedAt,
    archivedByAdminId: archive.archivedByAdminId,
    archiveReason: archive.reason.trim(),
  };
}

export function restoreInspection(inspection: Inspection): Inspection {
  if (inspection.lifecycleStatus !== "ARCHIVED") {
    invalidState("Only an archived inspection can be restored");
  }
  return {
    ...inspection,
    lifecycleStatus: "ACTIVE",
    archivedAt: null,
    archivedByAdminId: null,
    archiveReason: null,
  };
}

export function withdrawReport(
  report: Report,
  targetStatus: Exclude<ReportDeliveryStatus, "PUBLISHED">,
): Report {
  if (report.deliveryStatus !== "PUBLISHED" || report.currentVersionId === null) {
    invalidState("Only a published report can be withdrawn");
  }
  return { ...report, deliveryStatus: targetStatus, currentVersionId: null };
}

export function publishReportVersion(report: Report, reportVersionId: string): Report {
  if (!reportVersionId) {
    invalidState("A report version is required for publication");
  }
  return {
    ...report,
    deliveryStatus: "PUBLISHED",
    currentVersionId: reportVersionId,
  };
}

export function publishOrganizationDocumentVersion(
  document: OrganizationDocument,
  documentVersionId: string,
): OrganizationDocument {
  if (!documentVersionId) {
    invalidState("A document version is required for publication");
  }
  return {
    ...document,
    status: "PUBLISHED",
    currentVersionId: documentVersionId,
  };
}
