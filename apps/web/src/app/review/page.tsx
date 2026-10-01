"use client";

import { useEffect, useState } from "react";

import { PortalShell } from "../../components/portal-shell";
import { getClient, postClient } from "../../lib/client-api";

type Building = {
  buildingPrefix: string;
  displayName: string;
  readyReports: string[];
};

const asBuildings = {
  parse(value: unknown): { items: Building[] } {
    return { items: ((value as { items?: Building[] }).items ?? []) };
  },
};
const asStatus = { parse(value: unknown) { return (value ?? {}) as { reports?: Record<string, { awaitingClientAdmin?: boolean }> }; } };
const asOk = { parse(value: unknown) { return value; } };

export default function ReviewPage() {
  const [rows, setRows] = useState<Array<{ prefix: string; name: string; reportType: string }>>([]);
  const [notes, setNotes] = useState("");
  const [markStale, setMarkStale] = useState(false);

  useEffect(() => {
    async function load() {
      const list = await getClient("/bff/portal/buildings", asBuildings);
      const waiting: Array<{ prefix: string; name: string; reportType: string }> = [];
      for (const item of list.items) {
        const status = await getClient(`/bff/portal/building?prefix=${encodeURIComponent(item.buildingPrefix)}`, asStatus);
        for (const [reportType, report] of Object.entries(status.reports ?? {})) {
          if (report.awaitingClientAdmin) waiting.push({ prefix: item.buildingPrefix, name: item.displayName, reportType });
        }
      }
      setRows(waiting);
    }
    void load();
  }, []);

  async function act(prefix: string, reportType: string, action: "approve" | "notes") {
    await postClient("/bff/portal/building", { prefix, reportType, action, notes, markStale }, asOk);
    setRows((current) => current.filter((row) => !(row.prefix === prefix && row.reportType === reportType && action === "approve")));
  }

  return (
    <PortalShell>
      <section>
        <header className="page-heading">
          <h1>Review queue</h1>
          <p>Approve a file for the client, or send notes back to the operator.</p>
        </header>
        <div className="surface form-grid">
        <label>
          Notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={markStale} onChange={(event) => setMarkStale(event.target.checked)} />
          Mark the current file stale
        </label>
        </div>
        <ul>
          {rows.map((row) => (
            <li key={`${row.prefix}${row.reportType}`}>
              {row.name} · {row.reportType}
              <button className="button button--primary" type="button" onClick={() => act(row.prefix, row.reportType, "approve")}>Approve</button>
              <button className="button button--outline" type="button" onClick={() => act(row.prefix, row.reportType, "notes")}>Send notes</button>
            </li>
          ))}
        </ul>
      </section>
    </PortalShell>
  );
}
