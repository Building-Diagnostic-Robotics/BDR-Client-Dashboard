"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { PortalShell } from "../../components/portal-shell";
import { getClient, postClient } from "../../lib/client-api";

type Building = {
  buildingPrefix: string;
  displayName: string;
  awaitingReports?: string[];
};

type ReviewRow = {
  prefix: string;
  name: string;
  reportType: string;
  approvedKey?: string;
  generatedAt?: string;
};

type ReportStatus = {
  awaitingClientAdmin?: boolean;
  stale?: boolean;
  clientVisible?: boolean;
  approvedKey?: string;
  generatedAt?: string;
};

const asBuildings = {
  parse(value: unknown): { items: Building[] } {
    return { items: ((value as { items?: Building[] }).items ?? []) };
  },
};
const asStatus = { parse(value: unknown) { return (value ?? {}) as { reports?: Record<string, ReportStatus> }; } };
const asOk = { parse(value: unknown) { return value; } };
const asFile = { parse(value: unknown) { return value as { url: string }; } };

function isWaiting(report: ReportStatus | undefined): boolean {
  return Boolean(report?.awaitingClientAdmin && !report.stale && !report.clientVisible);
}

function reportLabel(name: string): string {
  return name.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function generatedLabel(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `Generated ${parsed.toLocaleString()}`;
}

function openFile(prefix: string, key: string) {
  void getClient(`/bff/portal/file?prefix=${encodeURIComponent(prefix)}&key=${encodeURIComponent(key)}`, asFile)
    .then((file) => window.open(file.url, "_blank"));
}

function ReviewCard({
  row,
  onApprove,
  onNotes,
}: {
  row: ReviewRow;
  onApprove: () => Promise<void>;
  onNotes: (notes: string, markStale: boolean) => Promise<void>;
}) {
  const [notes, setNotes] = useState("");
  const [markStale, setMarkStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const when = generatedLabel(row.generatedAt);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("This report could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="report-row report-row--stack">
      <div className="report-row__info">
        <h3>
          <Link href={`/buildings/view?prefix=${encodeURIComponent(row.prefix)}`}>{row.name}</Link>
        </h3>
        <p>{reportLabel(row.reportType)}{when ? ` · ${when}` : ""}</p>
      </div>
      <div className="report-row__status-col">
        <span className="status status--expected"><span className="status__dot" />Waiting for approval</span>
      </div>
      <div className="report-row__actions-col artifact-actions--compact">
        {row.approvedKey ? (
          <button className="button button--outline" type="button" onClick={() => openFile(row.prefix, row.approvedKey!)}>View</button>
        ) : null}
        <button className="button button--primary" type="button" disabled={busy} onClick={() => void run(onApprove)}>Approve</button>
      </div>
      <details className="review-notes">
        <summary>Send notes</summary>
        <form onSubmit={(event) => {
          event.preventDefault();
          void run(() => onNotes(notes, markStale));
        }}>
          <label>Notes
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <label className="review-notes__check">
            <input type="checkbox" checked={markStale} onChange={(event) => setMarkStale(event.target.checked)} />
            <span>Mark the current file stale</span>
          </label>
          <button className="button button--outline" type="submit" disabled={busy}>Send notes</button>
        </form>
      </details>
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}

export default function ReviewPage() {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const list = await getClient("/bff/portal/buildings", asBuildings);
      const listed = list.items.some((item) => Array.isArray(item.awaitingReports))
        ? list.items.filter((item) => (item.awaitingReports ?? []).length > 0)
        : list.items;
      const waiting: ReviewRow[] = [];
      for (const item of listed) {
        if (cancelled) return;
        try {
          const status = await getClient(`/bff/portal/building?prefix=${encodeURIComponent(item.buildingPrefix)}`, asStatus);
          for (const [reportType, report] of Object.entries(status.reports ?? {})) {
            if (isWaiting(report)) {
              waiting.push({
                prefix: item.buildingPrefix,
                name: item.displayName,
                reportType,
                ...(report.approvedKey ? { approvedKey: report.approvedKey } : {}),
                ...(report.generatedAt ? { generatedAt: report.generatedAt } : {}),
              });
            }
          }
        } catch {
          continue;
        }
        if (!cancelled) setRows([...waiting]);
      }
      if (!cancelled) setLoading(false);
    }
    void load().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function approve(prefix: string, reportType: string) {
    await postClient("/bff/portal/building", { prefix, reportType, action: "approve" }, asOk);
    setRows((current) => current.filter((row) => !(row.prefix === prefix && row.reportType === reportType)));
  }

  return (
    <PortalShell>
      <section>
        <header className="page-heading">
          <h1>Review</h1>
          <p>Reports sent for approval. View the file, approve it for the client, or send notes back.</p>
        </header>
        <section className="report-panel" aria-labelledby="review-title">
          <h2 id="review-title">Waiting for approval</h2>
          {loading && rows.length === 0 ? <p className="review-empty">Loading reports…</p> : null}
          {!loading && rows.length === 0 ? (
            <div className="empty-card"><h3>Nothing waiting</h3><p>Reports appear here after they are sent for approval.</p></div>
          ) : (
            <div className="report-list">
              {rows.map((row) => (
                <ReviewCard
                  key={`${row.prefix}${row.reportType}`}
                  row={row}
                  onApprove={async () => {
                    await approve(row.prefix, row.reportType);
                  }}
                  onNotes={async (notes, markStale) => {
                    await postClient("/bff/portal/building", {
                      prefix: row.prefix,
                      reportType: row.reportType,
                      action: "notes",
                      notes,
                      markStale,
                    }, asOk);
                    if (markStale) {
                      setRows((current) => current.filter((item) => !(item.prefix === row.prefix && item.reportType === row.reportType)));
                    }
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </section>
    </PortalShell>
  );
}
