"use client";

import { portalAdminReviewResponseSchema, portalFileResponseSchema, portalMutationResponseSchema, type PortalAdminReviewResponse, type PortalAdminReviewRow } from "@bdr/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ContentState } from "../../components/content-state";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { PortalShell, usePortal } from "../../components/portal-shell";
import { SectionHeader } from "../../components/section-header";
import { ClientApiError, getClient, postClient } from "../../lib/client-api";

type ReviewState = { status: "loading" } | { status: "ready"; result: PortalAdminReviewResponse } | { status: "error" };
const label = (name: string) => name.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

function generatedLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `Generated ${parsed.toLocaleString()}`;
}

function ReviewCard({ row, onApprove, onNotes }: { row: PortalAdminReviewRow; onApprove: () => Promise<void>; onNotes: (notes: string, markStale: boolean) => Promise<void> }) {
  const [notes, setNotes] = useState(""); const [markStale, setMarkStale] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const when = generatedLabel(row.generatedAt);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await work(); }
    catch (reason) { setError(reason instanceof ClientApiError && reason.status === 409 ? reason.message : "This report could not be updated. Refresh the queue and try again."); }
    finally { setBusy(false); }
  }
  function view() {
    const tab = window.open("about:blank", "_blank");
    if (!tab) { setError("Allow pop-ups to view this report."); return; }
    tab.opener = null; setError(null);
    void getClient(`/bff/portal/file?prefix=${encodeURIComponent(row.prefix)}&key=${encodeURIComponent(row.artifactKey!)}`, portalFileResponseSchema)
      .then((result) => { tab.location.href = result.url; })
      .catch(() => { tab.close(); setError("This report could not be opened. Please try again."); });
  }
  return <article className="report-row report-row--stack">
    <div className="report-row__info">
      <h3><Link href={`/buildings/view?prefix=${encodeURIComponent(row.prefix)}&client=${encodeURIComponent(row.prefix.split("/")[0]!)}`}>{row.name}</Link></h3>
      <p>{row.clientName} · {label(row.reportType)}{when ? ` · ${when}` : ""}</p>
    </div>
    <div className="report-row__status-col"><span className="status status--expected"><span className="status__dot" />Waiting for approval</span></div>
    <div className="report-row__actions-col artifact-actions--compact">
      {row.artifactKey ? <button className="button button--outline" type="button" onClick={view}>View</button> : null}
      <button className="button button--primary" type="button" disabled={busy} onClick={() => void run(onApprove)}>Approve</button>
    </div>
    <details className="review-notes"><summary>Send notes</summary>
      <form onSubmit={(event) => { event.preventDefault(); void run(() => onNotes(notes, markStale)); }}>
        <label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <label className="review-notes__check"><input type="checkbox" checked={markStale} onChange={(event) => setMarkStale(event.target.checked)} /><span>Mark the current file stale</span></label>
        <button className="button button--outline" type="submit" disabled={busy}>Send notes</button>
      </form>
    </details>
    {error ? <p role="alert">{error}</p> : null}
  </article>;
}

function ReviewContent() {
  const { admin } = usePortal();
  const [state, setState] = useState<ReviewState>({ status: "loading" }); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController(); setState({ status: "loading" });
    void getClient("/bff/portal/admin/review", portalAdminReviewResponseSchema, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setState({ status: "ready", result }); })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ClientApiError && error.status === 401) { window.location.reload(); return; }
        setState({ status: "error" });
      });
    return () => controller.abort();
  }, [admin, attempt]);
  const remove = (row: PortalAdminReviewRow) => setState((current) => current.status !== "ready" ? current : { ...current,
    result: { ...current.result, items: current.result.items.filter((item) => !(item.organizationId === row.organizationId && item.prefix === row.prefix && item.reportType === row.reportType)) } });
  if (!admin) return <ContentState status="error" title="Administrator access required" message="This queue is available to BDR administrators." />;
  const rows = state.status === "ready" ? state.result.items : [];
  return <>
    <PageHeader title="Review" description="Reports sent for approval across all inspections. View the file, approve it for the client, or send notes back."
      actions={<button className="button button--outline" disabled={state.status === "loading"} onClick={() => setAttempt((value) => value + 1)}>Refresh queue</button>} />
    <section className="report-panel" aria-labelledby="review-title">
      <SectionHeader title="Waiting for approval" titleId="review-title" count={state.status === "ready" ? rows.length : undefined} />
      {state.status === "loading" ? <ContentState status="loading" message="Loading reports…" /> : null}
      {state.status === "error" ? <ContentState status="error" title="Review unavailable" message="We could not check reports awaiting approval." onRetry={() => setAttempt((value) => value + 1)} /> : null}
      {state.status === "ready" && !state.result.complete ? <ContentState status="error" title="Review incomplete"
        message={<>Some inspections could not be checked. These results are incomplete. Affected clients: {[...new Set(state.result.failures.map((failure) => failure.clientName))].join(", ")}.</>}
        onRetry={() => setAttempt((value) => value + 1)} /> : null}
      {state.status === "ready" && state.result.complete && !rows.length ? <EmptyState title="Nothing waiting" description="All linked clients and inspections were checked. No reports are awaiting approval." /> : null}
      <div className="report-list">{rows.map((row) => <ReviewCard key={`${row.organizationId}:${row.prefix}:${row.reportType}`} row={row}
        onApprove={async () => { await postClient("/bff/portal/building", { prefix: row.prefix, reportType: row.reportKey, action: "approve" }, portalMutationResponseSchema); remove(row); }}
        onNotes={async (notes, markStale) => { await postClient("/bff/portal/building", { prefix: row.prefix, reportType: row.reportKey, action: "notes", notes, markStale }, portalMutationResponseSchema); if (markStale) remove(row); }}
      />)}</div>
    </section>
  </>;
}

export default function ReviewPage() { return <PortalShell><ReviewContent /></PortalShell>; }
