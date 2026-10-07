"use client";

import {
  artifactAccessResponseSchema,
  portalAsBuiltUploadResponseSchema,
  portalBuildingDetailSchema,
  portalInspectionCandidateListSchema,
  type PortalBuildingDetail,
  type PortalInspection,
  type PortalInspectionCandidate,
  type PortalPendingReportStatus,
  type PortalReport,
  type PortalReportType,
} from "@bdr/contracts";
import JSZip from "jszip";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ArtifactActions } from "../../../components/artifact-actions";
import { ChevronDownIcon, DownloadIcon } from "../../../components/icons";
import { usePortal } from "../../../components/portal-shell";
import { ClientApiError, getClient, loginPath, postClient } from "../../../lib/client-api";
import { formatDate, formatReportUpdatedDate, formatShortDate, formatUploadAge } from "../../../lib/format";
import styles from "./building-detail.module.css";

const REPORT_CONTENT: Record<PortalReportType, { name: string; description: string }> = {
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
  AS_BUILT: {
    name: "As-built",
    description: "The approved roof plan or reference image provided by BDR.",
  },
  CAPITAL_PLANNING: {
    name: "Capital Planning",
    description: "Long-term maintenance and budget recommendations.",
  },
};

const STATUS_LABEL = {
  AVAILABLE: "Available",
  IN_PREPARATION: "In preparation",
  NOT_INCLUDED: "Not included",
} as const;

type PageState =
  | { status: "loading" }
  | { status: "ready"; building: PortalBuildingDetail }
  | { status: "not-found" }
  | { status: "error" };

type PendingAsBuilt = {
  file: File;
  filename: string;
  contentType: "application/pdf" | "image/png" | "image/jpeg";
  sizeBytes: number;
};

function statusClass(report: PortalReport): string {
  if (report.deliveryStatus === "AVAILABLE") return "status--published";
  if (report.deliveryStatus === "IN_PREPARATION") return "status--expected";
  return "status--not-included";
}

function ReportRow({
  buildingId,
  inspectionId,
  report,
  clientPrefix,
}: {
  buildingId: string;
  inspectionId: string;
  report: PortalReport;
  clientPrefix?: string | undefined;
}) {
  const content = REPORT_CONTENT[report.reportType];
  const available = report.deliveryStatus === "AVAILABLE";
  return (
    <article className={styles.reportRow}>
      <div className={styles.reportInfo}>
        <h3>{content.name}</h3>
        <p>{content.description}</p>
      </div>
      <div className={styles.reportStatus}>
        <span className={`status ${statusClass(report)}`}>
          <span className="status__dot" aria-hidden="true" />
          {STATUS_LABEL[report.deliveryStatus]}
        </span>
        {available && report.publishedAt ? (
          <span className={styles.publishedDate}>{formatReportUpdatedDate(report.publishedAt)}</span>
        ) : null}
      </div>
      {available ? (
        <ArtifactActions
          accessPath="/bff/portal/artifact-access"
          requestBody={{ buildingId, inspectionId, reportType: report.reportType, ...(clientPrefix ? { clientPrefix } : {}) }}
          label={content.name}
          compact
        />
      ) : <span />}
    </article>
  );
}

function InspectionCard({
  building,
  inspection,
  latest,
  clientPrefix,
}: {
  building: PortalBuildingDetail;
  inspection: PortalInspection;
  latest: boolean;
  clientPrefix?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(latest);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const available = inspection.reports.filter((report) => report.deliveryStatus === "AVAILABLE");

  async function downloadAll() {
    if (downloadStatus || available.length === 0) return;
    setDownloadError(null);
    setDownloadStatus("Preparing…");
    try {
      const zip = new JSZip();
      for (let index = 0; index < available.length; index += 1) {
        const report = available[index]!;
        setDownloadStatus(`Downloading (${index + 1}/${available.length})…`);
        const access = await postClient(
          "/bff/portal/artifact-access",
          {
            buildingId: building.buildingId,
            inspectionId: inspection.inspectionId,
            reportType: report.reportType,
            disposition: "DOWNLOAD",
            ...(clientPrefix ? { clientPrefix } : {}),
          },
          artifactAccessResponseSchema,
        );
        const response = await fetch(access.url);
        if (!response.ok) throw new Error("download_failed");
        zip.file(report.filename ?? `${REPORT_CONTENT[report.reportType].name}.pdf`, await response.blob());
      }
      setDownloadStatus("Creating ZIP…");
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const date = inspection.scannedAt ? formatShortDate(inspection.scannedAt).replace(/[\\/:*?"<>|]/g, "-") : "Inspection";
      anchor.href = url;
      anchor.download = `${building.displayName.replace(/[\\/:*?"<>|]/g, "-")} - ${date}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      if (reason instanceof ClientApiError && reason.status === 401) {
        window.location.replace(loginPath(window.location.pathname));
        return;
      }
      setDownloadError("We could not bundle all reports. Please download them individually.");
    } finally {
      setDownloadStatus(null);
    }
  }

  return (
    <section className={`${styles.inspection} ${latest ? styles.latest : ""}`}>
      <header className={styles.inspectionHeader}>
        <div>
          {latest ? <span className={styles.pill}>Latest inspection</span> : null}
          <h2>{inspection.scannedAt ? formatDate(inspection.scannedAt, inspection.timeZone ?? undefined) : "Inspection date unavailable"}</h2>
          <p>{formatUploadAge(inspection.uploadCompletedAt)} · {available.length} {available.length === 1 ? "report" : "reports"} available</p>
        </div>
        <div className={styles.headerActions}>
          {available.length > 0 ? (
            <button className="button button--outline button--sm" type="button" onClick={() => void downloadAll()} disabled={downloadStatus !== null}>
              <DownloadIcon /> {downloadStatus ?? "Download all (.zip)"}
            </button>
          ) : null}
          <button
            className="toggle-button"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse inspection reports" : "Expand inspection reports"}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDownIcon className={expanded ? "chevron chevron--expanded" : "chevron"} />
          </button>
        </div>
      </header>
      {downloadError ? <p className="action-error" role="alert">{downloadError}</p> : null}
      {expanded ? (
        <div className={styles.reportList}>
          {inspection.reports.map((report) => (
            <ReportRow
              key={report.reportType}
              buildingId={building.buildingId}
              inspectionId={inspection.inspectionId}
              report={report}
              clientPrefix={clientPrefix}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function EditDetails({
  building,
  onSaved,
  onCancel,
  clientPrefix,
}: {
  building: PortalBuildingDetail;
  onSaved: (building: PortalBuildingDetail) => void;
  onCancel: () => void;
  clientPrefix?: string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className={`${styles.editPanel} ${styles.formGrid}`} onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setBusy(true);
      setError(null);
      void postClient("/bff/portal/building-details", {
        buildingId: building.buildingId,
        displayName: String(data.get("displayName") ?? ""),
        address: String(data.get("address") ?? ""),
        engineerNames: String(data.get("engineerNames") ?? ""),
        expectedRevision: building.revision,
        ...(clientPrefix ? { clientPrefix } : {}),
      }, portalBuildingDetailSchema).then(onSaved).catch((reason) => {
        setError(reason instanceof ClientApiError && reason.status === 409
          ? "These details changed in another session. Reload before trying again."
          : "Building details could not be saved.");
      }).finally(() => setBusy(false));
    }}>
      <h2>Edit details</h2>
      <label>Building name<input name="displayName" defaultValue={building.displayName} required /></label>
      <label>Address<input name="address" defaultValue={building.address} placeholder="Add the building address" /></label>
      <label>Engineer names
        <input name="engineerNames" defaultValue={building.engineerNames} placeholder="Tony, Thom, Raul" />
        <span className={styles.help}>Add all names, separated by commas.</span>
      </label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
        <button className="button button--outline" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function AdminControls({
  building,
  clientPrefix,
  onChanged,
}: {
  building: PortalBuildingDetail;
  clientPrefix: string;
  onChanged: (building: PortalBuildingDetail) => void;
}) {
  const [candidates, setCandidates] = useState<PortalInspectionCandidate[] | null>(null);
  const [selectedSource, setSelectedSource] = useState("");
  const [included, setIncluded] = useState<string[]>([]);
  const [pendingAsBuilt, setPendingAsBuilt] = useState<Record<string, PendingAsBuilt>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCandidate = candidates?.find((candidate) => candidate.sourceId === selectedSource) ?? null;

  async function ensurePersisted(): Promise<PortalBuildingDetail> {
    if (building.revision) return building;
    const persisted = await postClient("/bff/portal/building-details", {
      buildingId: building.buildingId,
      clientPrefix,
      displayName: building.displayName,
      address: building.address,
      engineerNames: building.engineerNames,
      expectedRevision: null,
    }, portalBuildingDetailSchema);
    onChanged(persisted);
    return persisted;
  }

  async function saveStatuses(inspection: PortalInspection, form: HTMLFormElement) {
    setBusy(true);
    setError(null);
    try {
      const persisted = await ensurePersisted();
      if (!persisted.revision) throw new Error("missing_revision");
      const data = new FormData(form);
      const reportStatuses = Object.fromEntries(inspection.reports.map((report) => [
        report.reportType,
        report.deliveryStatus === "AVAILABLE"
          ? "IN_PREPARATION"
          : String(data.get(report.reportType) ?? report.deliveryStatus),
      ])) as Record<PortalReportType, PortalPendingReportStatus>;
      const next = await postClient("/bff/portal/inspection-status", {
        buildingId: persisted.buildingId,
        clientPrefix,
        inspectionId: inspection.inspectionId,
        reportStatuses,
        expectedRevision: persisted.revision,
      }, portalBuildingDetailSchema);
      onChanged(next);
    } catch {
      setError("Report classifications could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function loadCandidates() {
    setError(null);
    try {
      const params = new URLSearchParams({ client: clientPrefix, buildingId: building.buildingId });
      const result = await getClient(`/bff/portal/inspection-candidates?${params.toString()}`, portalInspectionCandidateListSchema);
      setCandidates(result.items);
    } catch {
      setError("Inspection candidates could not be loaded.");
    }
  }

  function stageAsBuilt(inspection: PortalInspection, file: File) {
    setError(null);
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type) || file.size > 50 * 1024 * 1024) {
      setError("Choose a PDF, PNG, or JPEG smaller than 50 MB.");
      return;
    }
    setPendingAsBuilt((current) => ({
      ...current,
      [inspection.inspectionId]: {
        file,
        filename: file.name,
        contentType: file.type as PendingAsBuilt["contentType"],
        sizeBytes: file.size,
      },
    }));
  }

  async function publishAsBuilt(inspection: PortalInspection, pending: PendingAsBuilt) {
    setBusy(true);
    setError(null);
    try {
      const persisted = await ensurePersisted();
      if (!persisted.revision) throw new Error("missing_revision");
      const upload = await postClient("/bff/portal/as-built-upload", {
        buildingId: persisted.buildingId,
        clientPrefix,
        inspectionId: inspection.inspectionId,
        filename: pending.filename,
        contentType: pending.contentType,
        sizeBytes: pending.sizeBytes,
      }, portalAsBuiltUploadResponseSchema);
      const response = await fetch(upload.url, {
        method: "PUT",
        headers: { "content-type": pending.contentType },
        body: pending.file,
      });
      if (!response.ok) throw new Error("upload_failed");
      const next = await postClient("/bff/portal/as-built-publish", {
        buildingId: persisted.buildingId,
        clientPrefix,
        inspectionId: inspection.inspectionId,
        uploadId: upload.uploadId,
        key: upload.key,
        filename: pending.filename,
        contentType: pending.contentType,
        sizeBytes: pending.sizeBytes,
        expectedRevision: persisted.revision,
      }, portalBuildingDetailSchema);
      setPendingAsBuilt((current) => {
        const nextPending = { ...current };
        delete nextPending[inspection.inspectionId];
        return nextPending;
      });
      onChanged(next);
    } catch (reason) {
      setError(reason instanceof ClientApiError && reason.status === 409
        ? "The building changed while this file was being published. Reload and review it before retrying."
        : "The As-built file could not be published.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.adminPanel}>
      <h2>Building administration</h2>
      <p>Attach only the completed scan selected for this physical building. Partial and interrupted sections cannot be included.</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button className="button button--outline" type="button" onClick={() => void loadCandidates()}>Find uploaded scans</button>
      </div>
      {candidates ? (
        <form className={styles.formGrid} onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void postClient("/bff/portal/inspection-attach", {
            buildingId: building.buildingId,
            clientPrefix,
            sourceId: selectedSource,
            includedSectionIds: included,
            expectedRevision: building.revision,
          }, portalBuildingDetailSchema).then((next) => {
            onChanged(next);
            setCandidates(null);
            setSelectedSource("");
            setIncluded([]);
          }).catch(() => setError("This uploaded scan could not be attached.")).finally(() => setBusy(false));
        }}>
          <label>Uploaded scan
            <select value={selectedSource} onChange={(event) => {
              const sourceId = event.target.value;
              setSelectedSource(sourceId);
              const candidate = candidates.find((value) => value.sourceId === sourceId);
              setIncluded(candidate?.sections.filter((section) => section.eligible).map((section) => section.sectionId) ?? []);
            }} required>
              <option value="">Choose a scan</option>
              {candidates.map((candidate) => (
                <option key={candidate.sourceId} value={candidate.sourceId} disabled={candidate.assigned}>
                  {candidate.displayName}{candidate.assigned ? " · already assigned" : ""}
                </option>
              ))}
            </select>
          </label>
          {selectedCandidate ? (
            <fieldset>
              <legend>Completed sections</legend>
              {selectedCandidate.sections.map((section) => (
                <label key={section.sectionId}>
                  <input
                    type="checkbox"
                    checked={included.includes(section.sectionId)}
                    disabled={!section.eligible}
                    onChange={(event) => setIncluded((current) => event.target.checked
                      ? [...current, section.sectionId]
                      : current.filter((value) => value !== section.sectionId))}
                  />
                  {section.sectionId} · {section.eligible ? "complete" : "partial or interrupted"}
                </label>
              ))}
            </fieldset>
          ) : null}
          <button className="button button--primary" type="submit" disabled={busy || included.length === 0}>Attach inspection</button>
        </form>
      ) : null}

      <h3>Client report classifications</h3>
      {building.inspections.map((inspection) => (
        <form className={styles.formGrid} key={inspection.inspectionId} onSubmit={(event) => {
          event.preventDefault();
          void saveStatuses(inspection, event.currentTarget);
        }}>
          <strong>{inspection.scannedAt ? formatShortDate(inspection.scannedAt, inspection.timeZone ?? undefined) : "Undated inspection"}</strong>
          <div className={styles.adminRows}>
            {inspection.reports.map((report) => (
              <label className={styles.adminRow} key={report.reportType}>
                <span>{REPORT_CONTENT[report.reportType].name}</span>
                <select name={report.reportType} defaultValue={report.deliveryStatus === "AVAILABLE" ? "IN_PREPARATION" : report.deliveryStatus} disabled={report.deliveryStatus === "AVAILABLE"}>
                  {report.deliveryStatus === "AVAILABLE" ? <option value="IN_PREPARATION">Available</option> : null}
                  <option value="IN_PREPARATION">In preparation</option>
                  <option value="NOT_INCLUDED">Not included</option>
                </select>
              </label>
            ))}
          </div>
          <button className="button button--outline" type="submit" disabled={busy}>Save classifications</button>
          <label>Choose As-built file
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) stageAsBuilt(inspection, file);
                event.currentTarget.value = "";
              }}
            />
            <span className={styles.help}>PDF, PNG, or JPEG. The file stays local until you explicitly publish it.</span>
          </label>
          {pendingAsBuilt[inspection.inspectionId] ? (
            <div className={styles.actions}>
              <span>Draft ready: {pendingAsBuilt[inspection.inspectionId]!.filename}</span>
              <button
                className="button button--primary"
                type="button"
                disabled={busy}
                onClick={() => void publishAsBuilt(inspection, pendingAsBuilt[inspection.inspectionId]!)}
              >
                {busy ? "Publishing…" : "Publish As-built"}
              </button>
              <button
                className="button button--outline"
                type="button"
                disabled={busy}
                onClick={() => setPendingAsBuilt((current) => {
                  const next = { ...current };
                  delete next[inspection.inspectionId];
                  return next;
                })}
              >
                Discard draft
              </button>
            </div>
          ) : null}
        </form>
      ))}
    </section>
  );
}

export function CatalogBuildingView({ buildingId, clientPrefix }: { buildingId: string; clientPrefix?: string | undefined }) {
  const { admin } = usePortal();
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const detailPath = useMemo(() => {
    const params = new URLSearchParams({ buildingId });
    if (clientPrefix) params.set("client", clientPrefix);
    return `/bff/portal/building-detail?${params.toString()}`;
  }, [buildingId, clientPrefix]);

  useEffect(() => {
    let active = true;
    getClient(detailPath, portalBuildingDetailSchema).then((building) => {
      if (active) setState({ status: "ready", building });
    }).catch((reason) => {
      if (!active) return;
      if (reason instanceof ClientApiError && reason.status === 401) {
        window.location.replace(loginPath(window.location.pathname));
        return;
      }
      setState({ status: reason instanceof ClientApiError && reason.status === 404 ? "not-found" : "error" });
    });
    return () => { active = false; };
  }, [detailPath]);

  if (state.status === "loading") {
    return (
      <section className={`${styles.editPanel} ${styles.loading}`} aria-busy="true" aria-label="Loading building">
        <div className={styles.skeletonLine} />
        <div className={styles.skeletonLine} />
        <div className={styles.skeletonLine} />
      </section>
    );
  }

  if (state.status !== "ready") {
    return (
      <section className="content-state content-state--error" role="alert">
        <h1>{state.status === "not-found" ? "Building not found" : "Building unavailable"}</h1>
        <p>{state.status === "not-found" ? "This building is unavailable or you do not have access to it." : "We could not load this building. Please try again."}</p>
        <Link className="button button--outline" href="/projects">Back to projects</Link>
      </section>
    );
  }

  const building = state.building;
  return (
    <section className={styles.page}>
      <Link className={styles.backLink} href="/projects">← Back to projects</Link>
      <header className={styles.hero}>
        <div>
          <h1>{building.displayName}</h1>
          <p className={styles.address}>{building.address || "No address yet"}</p>
          {building.engineerNames ? <p className={styles.engineers}>Engineers: {building.engineerNames}</p> : null}
        </div>
        <button className="button button--outline" type="button" onClick={() => setEditing((value) => !value)}>Edit details</button>
      </header>

      {editing ? (
        <EditDetails
          building={building}
          onCancel={() => setEditing(false)}
          clientPrefix={clientPrefix}
          onSaved={(next) => { setState({ status: "ready", building: next }); setEditing(false); }}
        />
      ) : null}

      {admin && clientPrefix ? (
        <AdminControls building={building} clientPrefix={clientPrefix} onChanged={(next) => setState({ status: "ready", building: next })} />
      ) : null}

      {building.inspections.length === 0 ? (
        <div className="empty-card"><h2>No inspections yet</h2><p>Accepted inspection data will appear here.</p></div>
      ) : (
        <div className={styles.inspectionList}>
          <InspectionCard
            building={building}
            inspection={building.inspections[0]!}
            latest
            clientPrefix={clientPrefix}
          />
          {building.inspections.length > 1 ? (
            <section className={styles.previousInspections}>
              <h2>Previous inspections</h2>
              {building.inspections.slice(1).map((inspection) => (
                <InspectionCard
                  key={inspection.inspectionId}
                  building={building}
                  inspection={inspection}
                  latest={false}
                  clientPrefix={clientPrefix}
                />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}
