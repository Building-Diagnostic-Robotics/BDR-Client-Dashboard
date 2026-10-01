"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { usePortal } from "../../../components/portal-shell";
import { getClient, postClient } from "../../../lib/client-api";

type Status = Record<string, unknown>;

const asStatus = { parse(value: unknown): Status { return (value ?? {}) as Status; } };
const asOk = { parse(value: unknown) { return value; } };
const asUpload = { parse(value: unknown) { return value as { url: string }; } };
const asFile = { parse(value: unknown) { return value as { url: string }; } };

function openFile(prefix: string, key: string) {
  void getClient(`/bff/portal/file?prefix=${encodeURIComponent(prefix)}&key=${encodeURIComponent(key)}`, asFile)
    .then((file) => window.open(file.url, "_blank"));
}

function Aerial({ prefix }: { prefix: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const key = `${prefix.replace(/\/?$/, "/")}reportgen/aerial/aerial.png`;
    getClient(`/bff/portal/file?prefix=${encodeURIComponent(prefix)}&key=${encodeURIComponent(key)}`, asFile)
      .then((file) => setUrl(file.url))
      .catch(() => setUrl(null));
  }, [prefix]);
  if (!url) return null;
  return <img src={url} alt="Aerial" style={{ maxWidth: "100%" }} />;
}

function BuildingView() {
  const { organization } = usePortal();
  const params = useSearchParams();
  const prefix = params.get("prefix") || "";
  const [status, setStatus] = useState<Status | null>(null);
  const admin = organization.organizationId === "bdr_portal_admins" || Boolean(status?.admin);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prefix) return;
    getClient(`/bff/portal/building?prefix=${encodeURIComponent(prefix)}`, asStatus)
      .then(setStatus)
      .catch(() => setError("This building is unavailable."));
  }, [prefix]);

  async function approve(reportType: string) {
    setError(null);
    try {
      await postClient("/bff/portal/building", { prefix, action: "approve", reportType }, asOk);
      const next = await getClient(`/bff/portal/building?prefix=${encodeURIComponent(prefix)}`, asStatus);
      setStatus(next);
    } catch {
      setError("This account cannot approve the report.");
    }
  }

  async function setStale(reportType: string, action: "mark-stale" | "undo-stale") {
    setError(null);
    try {
      await postClient("/bff/portal/building", { prefix, action, reportType }, asOk);
      const next = await getClient(`/bff/portal/building?prefix=${encodeURIComponent(prefix)}`, asStatus);
      setStatus(next);
    } catch {
      setError(action === "undo-stale" ? "This stale mark could not be undone." : "This report could not be marked stale.");
    }
  }

  async function reload() {
    const next = await getClient(`/bff/portal/building?prefix=${encodeURIComponent(prefix)}`, asStatus);
    setStatus(next);
  }

  const reports = (status?.reports ?? {}) as Record<string, { clientVisible?: boolean; stale?: boolean; approvedKey?: string; awaitingClientAdmin?: boolean; generatedAt?: string }>;
  const takeoffOnly = Boolean(status?.roofTakeoffOnly);
  const mapReady = Boolean(status?.mapReady) && !takeoffOnly;
  const markedOff = status?.buildingMark === "no_report" || status?.buildingMark === "test_scan";
  const canEdit = admin || Object.values(reports).some((report) => report.clientVisible);
  const reportRows = Object.entries(reports);

  function generatedLabel(value?: string | null): string {
    if (!value) return "Not generated";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return `Generated ${parsed.toLocaleString()}`;
  }

  function reportLabel(name: string): string {
    return name.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function reportStatus(report: { clientVisible?: boolean; stale?: boolean; awaitingClientAdmin?: boolean }): { label: string; tone: string } {
    if (report.stale) return { label: "Stale", tone: "status--expected" };
    if (report.clientVisible) return { label: "Ready", tone: "status--published" };
    if (admin && report.awaitingClientAdmin) return { label: "Waiting for approval", tone: "status--expected" };
    return { label: "Not ready", tone: "status--not-included" };
  }

  return (
    <section>
      <p><Link className="button button--outline" href="/projects">{admin ? "Clients" : "Buildings"}</Link></p>
      <header className="page-heading">
        <h1>{String(status?.displayName || "Building")}</h1>
        <p>{String(status?.address || "No address yet")}</p>
      </header>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      {status?.pendingRerun ? (
        <p>A new file is being prepared. The previous file stays available.</p>
      ) : status?.clientMessage ? (
        <p>{String(status.clientMessage)}</p>
      ) : null}
      {status?.rerunError ? <p role="alert">Contact an admin.</p> : null}
      <div className="stat-row">
        <span><strong>Scan</strong>{String(status?.scanTime || "—")}</span>
        <span><strong>Upload</strong>{String(status?.uploadTime || "—")}</span>
      </div>

      <section className="report-panel" aria-labelledby="reports-title">
        <h2 id="reports-title">Reports</h2>
        {reportRows.length === 0 ? (
          <div className="empty-card"><h3>No reports yet</h3><p>Report status appears here when a file is prepared for this building.</p></div>
        ) : (
          <div className="report-list">
            {reportRows.map(([name, report]) => {
              const current = reportStatus(report);
              return (
                <article className="report-row" key={name}>
                  <div className="report-row__info">
                    <h3>{reportLabel(name)}</h3>
                    <p>{generatedLabel(report.generatedAt)}</p>
                  </div>
                  <div className="report-row__status-col">
                    <span className={`status ${current.tone}`}><span className="status__dot" />{current.label}</span>
                  </div>
                  <div className="report-row__actions-col artifact-actions--compact">
                    {admin && report.awaitingClientAdmin && !report.clientVisible ? (
                      <button className="button button--primary" type="button" onClick={() => approve(name)}>Approve</button>
                    ) : null}
                    {admin && report.clientVisible && !report.stale ? (
                      <button className="button button--outline" type="button" onClick={() => setStale(name, "mark-stale")}>Mark stale</button>
                    ) : null}
                    {admin && report.stale ? (
                      <button className="button button--primary" type="button" onClick={() => setStale(name, "undo-stale")}>Mark as ready</button>
                    ) : null}
                    {report.approvedKey && (admin || report.clientVisible || report.stale) ? (
                      <button className="button button--outline" type="button" onClick={() => openFile(prefix, String(report.approvedKey))}>Open PDF</button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      {(() => {
        const stored = (Array.isArray(status?.history) ? status.history : []) as Array<{ reportType?: string; key?: string; approvedKey?: string; label?: string; stale?: boolean; at?: string; generatedAt?: string; reportgenApprovedAt?: string }>;
        const seen = new Set(stored.map((item) => item.key || item.approvedKey));
        const history = [
          ...stored,
          ...reportRows
            .filter(([, report]) => report.stale && report.approvedKey && !seen.has(report.approvedKey))
            .map(([name, report]) => ({ reportType: name, key: report.approvedKey, stale: true, label: "Stale", generatedAt: report.generatedAt })),
        ];
        if (history.length === 0) return null;
        return (
        <section className="report-panel" aria-labelledby="history-title">
          <h2 id="history-title">History</h2>
          <div className="report-list">
            {history.map((item, index) => {
              const key = item.key || item.approvedKey;
              return (
                <article className="report-row" key={`${key || "history"}-${index}`}>
                  <div className="report-row__info">
                    <h3>{reportLabel(String(item.reportType || "Report"))}</h3>
                    <p>{generatedLabel(item.generatedAt || item.reportgenApprovedAt || item.at)}</p>
                  </div>
                  <div className="report-row__status-col">
                    <span className={`status ${item.stale ? "status--expected" : "status--published"}`}>
                      <span className="status__dot" />{item.stale ? "Stale" : item.label || "Approved"}
                    </span>
                  </div>
                  <div className="report-row__actions-col">
                    {key ? <button className="button button--outline" type="button" onClick={() => openFile(prefix, key)}>Open PDF</button> : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        );
      })()}
      {status?.released ? <Aerial prefix={prefix} /> : null}

      {admin ? (
        <details className="fold">
          <summary>Visit status{status?.buildingMark ? ` · ${status.buildingMark === "test_scan" ? "Test scan" : "No report"}` : ""}</summary>
          <div className="form-grid">
            <p>Choose this when the visit should not produce a client report. Stored files stay in place. Setting it back to a normal visit does not restore hidden files.</p>
            <label>Status
              <select
                value={String(status?.buildingMark || "")}
                onChange={(event) => {
                  const mark = event.target.value || null;
                  void postClient("/bff/portal/building", { prefix, action: "building-mark", mark }, asOk).then(reload);
                }}
              >
                <option value="">Normal visit</option>
                <option value="no_report">No report needed</option>
                <option value="test_scan">Test scan</option>
              </select>
            </label>
          </div>
        </details>
      ) : null}
      {admin ? (
        <details className="fold">
          <summary>Hide from clients{status?.hidden ? " · Hidden" : ""}</summary>
          <div className="form-grid">
            {status?.hidden ? (
              <>
                <p>Hidden{status.hideReason ? `: ${String(status.hideReason)}` : ""}. Clients do not see this building.</p>
                <button className="button button--outline" type="button" onClick={() => {
                  void postClient("/bff/portal/building", { prefix, action: "restore" }, asOk).then(reload);
                }}>Restore</button>
              </>
            ) : (
              <form onSubmit={(event) => {
                event.preventDefault();
                const reason = String(new FormData(event.currentTarget).get("reason") || "");
                void postClient("/bff/portal/building", { prefix, action: "hide", reason }, asOk).then(reload);
              }}>
                <label>Reason
                  <input name="reason" required placeholder="Superseded scan" />
                </label>
                <button className="button button--outline" type="submit">Hide from clients</button>
              </form>
            )}
          </div>
        </details>
      ) : null}
      {!admin && !markedOff ? (
        <form className="surface form-grid" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void postClient("/bff/portal/building", {
            prefix,
            action: "takeoff-building",
            clientPrefix: prefix.split("/")[0],
            displayName: String(form.get("name") || ""),
            address: String(form.get("address") || ""),
          }, asOk);
        }}>
          <h2>Request roof takeoff</h2>
          <label>Name<input name="name" required /></label>
          <label>Address<input name="address" /></label>
          <p>A new building requires an as-built after it is created.</p>
          <button className="button button--primary" type="submit">Request roof takeoff</button>
        </form>
      ) : null}
      {canEdit && !markedOff ? (
      <>
      <details className="fold">
        <summary>Building details</summary>
        <form className="form-grid" key={String(status?.updatedAt || "building")} onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void postClient("/bff/portal/building", {
            prefix,
            action: "identity",
            displayName: String(form.get("displayName") || ""),
            address: String(form.get("address") || ""),
            engineers: String(form.get("engineers") || ""),
          }, asOk).then(reload).catch(() => setError("Building details could not be saved."));
        }}>
          <label>Name<input name="displayName" defaultValue={String(status?.displayName || "")} /></label>
          <label>Location<input name="address" defaultValue={String(status?.address || "")} /></label>
          <label>Engineers<input name="engineers" defaultValue={String(status?.engineers || "")} /></label>
          <button className="button button--primary" type="submit">Save building</button>
          {!admin ? <p>Saving marks the current ready files stale.</p> : null}
        </form>
      </details>
      {!takeoffOnly ? (
        <details className="fold">
          <summary>Capital planning</summary>
          <form className="form-grid" onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void postClient("/bff/portal/building", {
              prefix,
              action: "capital-plan",
              inputs: {
                plan_start_year: Number(form.get("plan_start_year")),
                plan_years: Number(form.get("plan_years")),
                annual_budget: Number(form.get("annual_budget")),
                replacement_cost_per_sqft: Number(form.get("replacement_cost_per_sqft")),
                new_roof_service_life_years: Number(form.get("new_roof_service_life_years")),
              },
            }, asOk).then(reload).catch(() => setError("Capital planning could not be saved."));
          }}>
            <label>Start year<input name="plan_start_year" type="number" required /></label>
            <label>Years<input name="plan_years" type="number" required /></label>
            <label>Annual budget<input name="annual_budget" type="number" required /></label>
            <label>Replacement cost per sqft<input name="replacement_cost_per_sqft" type="number" required /></label>
            <label>New roof service life<input name="new_roof_service_life_years" type="number" required /></label>
            <button className="button button--primary" type="submit">Save capital plan</button>
            {!admin ? <p>Saving marks the capital plan stale.</p> : null}
          </form>
        </details>
      ) : null}
      </>
      ) : null}
      {((status?.sections as Array<{ sectionId: string; mark?: string; scanTime?: string; uploadTime?: string }> | undefined) ?? []).length > 0 ? (
        <section className="report-panel" aria-labelledby="scans-title">
          <h2 id="scans-title">Scans</h2>
          <div className="report-list">
            {((status?.sections as Array<{ sectionId: string; mark?: string; scanTime?: string; uploadTime?: string }>) ?? []).map((section) => (
              <article className="report-row" key={section.sectionId} style={{ opacity: section.mark ? 0.6 : 1 }}>
                <div className="report-row__info">
                  <h3>{section.sectionId}</h3>
                  <p>Scan {section.scanTime || "—"} · Upload {section.uploadTime || "—"}</p>
                </div>
                <div className="report-row__status-col">
                  <span className={`status ${section.mark ? "status--expected" : "status--published"}`}>
                    <span className="status__dot" />
                    {section.mark === "bad" ? "Bad scan" : section.mark === "not_necessary" ? "Left out" : "Included"}
                  </span>
                </div>
                {canEdit && !markedOff ? (
                  <div className="report-row__actions-col">
                    <select
                      aria-label={`Include ${section.sectionId}`}
                      value={section.mark || ""}
                      onChange={(event) => {
                        const mark = event.target.value || null;
                        void postClient("/bff/portal/building", { prefix, action: "section-mark", sectionId: section.sectionId, mark }, asOk).then(reload);
                      }}
                    >
                      <option value="">Included</option>
                      <option value="not_necessary">Leave out of the report</option>
                      <option value="bad">Bad scan</option>
                    </select>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <details className="fold">
        <summary>As-built roof image</summary>
        <div className="form-grid">
          <p>Upload one roof image for takeoff. An admin can reject it and ask for another.</p>
          <input type="file" accept="image/*" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const ext = file.name.split(".").pop() || "png";
            void postClient("/bff/portal/building", { prefix, action: "asbuilt-upload", ext, contentType: file.type }, asUpload)
              .then(async (signed) => {
                await fetch(signed.url, { method: "PUT", headers: { "content-type": file.type }, body: file });
              });
          }} />
          {admin && status?.asBuiltKey ? (
            <button className="button button--outline" type="button" onClick={() => postClient("/bff/portal/building", { prefix, action: "reject-asbuilt" }, asOk).then(reload)}>Reject this image</button>
          ) : null}
        </div>
      </details>
      {mapReady ? (
        <p><Link href={`/map?prefix=${encodeURIComponent(prefix)}`}>Moisture map</Link></p>
      ) : null}
    </section>
  );
}

export default function BuildingViewPage() {
  return (
    <Suspense>
      <BuildingView />
    </Suspense>
  );
}
