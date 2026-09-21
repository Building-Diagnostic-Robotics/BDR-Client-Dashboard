"use client";

import {
  clientInspectionListResponseSchema,
  clientProjectSchema,
  clientReportListResponseSchema,
  type ClientInspection,
  type ClientProject,
  type ClientReportMetadata,
  type ReportDeliveryStatus,
  type ReportType,
} from "@bdr/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ArtifactActions } from "../../../components/artifact-actions";
import { ArrowRightIcon } from "../../../components/icons";
import { ClientApiError, getClient } from "../../../lib/client-api";
import { formatDate, formatReportUpdatedDate, formatScanTime } from "../../../lib/format";

type InspectionWithReports = Readonly<{
  inspection: ClientInspection;
  reports: readonly ClientReportMetadata[];
}>;

type PageState =
  | { status: "loading" }
  | { status: "ready"; project: ClientProject; inspections: readonly InspectionWithReports[] }
  | { status: "not-found" }
  | { status: "error" };

const reportContent: Record<ReportType, { name: string; description: string }> = {
  ASSESSMENT: {
    name: "Roof Assessment",
    description: "Roof conditions, findings, and recommended actions.",
  },
  EVIDENCE: {
    name: "Inspection Evidence",
    description: "Documented imagery and observed roof conditions.",
  },
  ROOF_TAKEOFF: {
    name: "Roof Takeoff",
    description: "Measured roof areas, perimeters, and quantities.",
  },
  CAPITAL_PLANNING: {
    name: "Capital Planning",
    description: "Long-term maintenance and budget recommendations.",
  },
};

const reportOrder: readonly ReportType[] = [
  "ASSESSMENT",
  "EVIDENCE",
  "ROOF_TAKEOFF",
  "CAPITAL_PLANNING",
];

const statusLabel: Record<ReportDeliveryStatus, string> = {
  PUBLISHED: "Available",
  EXPECTED: "In preparation",
  NOT_INCLUDED: "Not included",
  NOT_APPLICABLE: "Not applicable",
};

const statusNote: Record<Exclude<ReportDeliveryStatus, "PUBLISHED">, string> = {
  EXPECTED: "BDR is preparing this report.",
  NOT_INCLUDED: "This report was not included for this inspection.",
  NOT_APPLICABLE: "This report does not apply to this inspection.",
};

function ReportRow({
  report,
  projectId,
  inspectionId,
  timeZone,
}: {
  report: ClientReportMetadata;
  projectId: string;
  inspectionId: string;
  timeZone: string;
}) {
  const content = reportContent[report.reportType];
  return (
    <div className="report-row">
      <div className="report-row__info">
        <h3>{content.name}</h3>
        <p>{content.description}</p>
      </div>
      <div className="report-row__status-col">
        <span className={`status status--${report.deliveryStatus.toLowerCase().replaceAll("_", "-")}`}>
          <span className="status__dot" aria-hidden="true" />
          {statusLabel[report.deliveryStatus]}
        </span>
        {report.publishedAt ? (
          <span className="report-row__date">
            {formatReportUpdatedDate(report.publishedAt, timeZone)}
          </span>
        ) : null}
      </div>
      <div className="report-row__actions-col">
        {report.deliveryStatus === "PUBLISHED" ? (
          <ArtifactActions
            accessPath={`/bff/projects/${encodeURIComponent(projectId)}/inspections/${encodeURIComponent(inspectionId)}/reports/${report.reportType}/access`}
            label={content.name}
            compact
          />
        ) : (
          <p className="report-row__note">{statusNote[report.deliveryStatus]}</p>
        )}
      </div>
    </div>
  );
}

function InspectionSection({
  value,
  projectId,
  latest,
}: {
  value: InspectionWithReports;
  projectId: string;
  latest: boolean;
}) {
  const { inspection, reports } = value;
  const orderedReports = reports.slice().sort(
    (left, right) => reportOrder.indexOf(left.reportType) - reportOrder.indexOf(right.reportType),
  );
  const available = reports.filter((report) => report.deliveryStatus === "PUBLISHED").length;
  return (
    <section className={latest ? "inspection inspection--latest" : "inspection"}>
      <div className="inspection__header">
        <div>
          {latest ? (
            <span className="latest-pill">Latest inspection</span>
          ) : (
            <span className="previous-pill">Previous inspection</span>
          )}
          <h2>{formatDate(inspection.scannedAt, inspection.scanTimeZone)}</h2>
          <p className="inspection__sub">Scanned at {formatScanTime(inspection.scannedAt, inspection.scanTimeZone)}</p>
        </div>
        <span className="inspection__count">{available} of {reports.length} reports available</span>
      </div>
      <div className="report-list">
        {orderedReports.map((report) => (
          <ReportRow
            key={report.reportType}
            report={report}
            projectId={projectId}
            inspectionId={inspection.inspectionId}
            timeZone={inspection.scanTimeZone}
          />
        ))}
      </div>
    </section>
  );
}

export function ProjectDetail({ projectId }: { projectId: string }) {
  const [state, setState] = useState<PageState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load() {
      const encodedProjectId = encodeURIComponent(projectId);
      try {
        const [project, inspectionsResponse] = await Promise.all([
          getClient(`/bff/projects/${encodedProjectId}`, clientProjectSchema),
          getClient(`/bff/projects/${encodedProjectId}/inspections`, clientInspectionListResponseSchema),
        ]);
        const inspections = await Promise.all(inspectionsResponse.items.map(async (inspection) => {
          const reports = await getClient(
            `/bff/projects/${encodedProjectId}/inspections/${encodeURIComponent(inspection.inspectionId)}/reports`,
            clientReportListResponseSchema,
          );
          return { inspection, reports: reports.items };
        }));
        inspections.sort((left, right) =>
          Date.parse(right.inspection.scannedAt) - Date.parse(left.inspection.scannedAt));
        if (active) setState({ status: "ready", project, inspections });
      } catch (reason) {
        if (reason instanceof ClientApiError && reason.status === 401) {
          window.location.reload();
          return;
        }
        if (active) setState({
          status: reason instanceof ClientApiError && reason.status === 404 ? "not-found" : "error",
        });
      }
    }
    void load();
    return () => { active = false; };
  }, [projectId]);

  if (state.status === "loading") {
    return <section className="content-state" aria-busy="true"><span className="spinner" aria-hidden="true" /><p>Loading project…</p></section>;
  }

  if (state.status === "not-found" || state.status === "error") {
    return (
      <section className="content-state content-state--error" role="alert">
        <h1>{state.status === "not-found" ? "Project not found" : "Project unavailable"}</h1>
        <p>{state.status === "not-found"
          ? "This project is unavailable or you do not have access to it."
          : "We could not load this project. Please try again."}</p>
        <Link className="button button--outline" href="/projects">Back to projects</Link>
      </section>
    );
  }

  return (
    <>
      <Link className="back-link" href="/projects"><ArrowRightIcon /> Back to projects</Link>
      <section className="project-hero">
        <div>
          <h1>{state.project.displayName}</h1>
          <p className="project-hero__address">{state.project.address}</p>
        </div>
      </section>

      {state.inspections.length === 0 ? (
        <div className="empty-card">
          <h2>No published inspections</h2>
          <p>Published inspection reports will appear here.</p>
        </div>
      ) : (
        <div className="inspection-list">
          {state.inspections.map((inspection, index) => (
            <InspectionSection
              key={inspection.inspection.inspectionId}
              value={inspection}
              projectId={state.project.projectId}
              latest={index === 0}
            />
          ))}
        </div>
      )}
    </>
  );
}

