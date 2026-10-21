"use client";

import { portalAdminBuildingCountSchema, portalAdminBuildingListSchema, portalAdminClientListSchema, type PortalAdminBuildingSummary, type PortalAdminClient } from "@bdr/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BuildingCard } from "../../components/building-card";
import { ContentState } from "../../components/content-state";
import { EmptyState } from "../../components/empty-state";
import { ArrowRightIcon } from "../../components/icons";
import { PageHeader } from "../../components/page-header";
import { SearchBar } from "../../components/search-bar";
import { SectionHeader } from "../../components/section-header";
import { ClientApiError, getClient } from "../../lib/client-api";
import { formatBuildingReportsStatus, formatBuildingScanDate } from "../../lib/format";

type ReadState<T> = { status: "loading" } | { status: "ready"; items: T[] } | { status: "error" };
type Counts = Record<string, number | "error">;
function expired(error: unknown) { if (error instanceof ClientApiError && error.status === 401) { window.location.reload(); return true; } return false; }

export function AdminProjects() {
  const requestedClient = useSearchParams().get("client");
  const [directory, setDirectory] = useState<ReadState<PortalAdminClient>>({ status: "loading" });
  const [buildings, setBuildings] = useState<ReadState<PortalAdminBuildingSummary> & { organizationId: string | null }>({ status: "loading", organizationId: null });
  const [counts, setCounts] = useState<Counts>({}); const countsRef = useRef<Counts>({});
  const [directoryRetry, setDirectoryRetry] = useState(0); const [buildingRetry, setBuildingRetry] = useState(0); const [countRetry, setCountRetry] = useState(0);
  const [search, setSearch] = useState(""); const [robot, setRobot] = useState(""); const [report, setReport] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const selected = directory.status === "ready" ? directory.items.find((client) => client.organizationId === requestedClient || client.clientPrefixes.includes(requestedClient ?? "")) : undefined;
  const selectedOrganization = selected?.organizationId;
  const rememberCount = (id: string, value: number | "error") => { countsRef.current = { ...countsRef.current, [id]: value }; setCounts(countsRef.current); };

  useEffect(() => {
    const controller = new AbortController(); setDirectory({ status: "loading" });
    void getClient("/bff/portal/admin/clients", portalAdminClientListSchema, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { countsRef.current = {}; setCounts({}); setDirectory({ status: "ready", items: result.items }); } })
      .catch((error) => { if (!controller.signal.aborted && !expired(error)) setDirectory({ status: "error" }); });
    return () => controller.abort();
  }, [directoryRetry]);

  useEffect(() => {
    setSearch(""); setRobot(""); setReport(""); setFrom(""); setTo("");
  }, [requestedClient]);

  useEffect(() => {
    if (directory.status !== "ready" || requestedClient) return;
    const controller = new AbortController();
    const waiting = directory.items.filter((client) => typeof countsRef.current[client.organizationId] !== "number");
    let next = 0;
    async function worker() {
      while (!controller.signal.aborted && next < waiting.length) {
        const client = waiting[next++]!;
        try {
          const result = await getClient(`/bff/portal/admin/clients/${encodeURIComponent(client.organizationId)}/building-count`, portalAdminBuildingCountSchema, controller.signal);
          if (!controller.signal.aborted) rememberCount(client.organizationId, result.count);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (expired(error)) { controller.abort(); return; }
          rememberCount(client.organizationId, "error");
        }
      }
    }
    void Promise.all([worker(), worker()]);
    return () => controller.abort();
  }, [directory, requestedClient, countRetry]);

  useEffect(() => {
    if (!selectedOrganization) return;
    const controller = new AbortController(); setBuildings({ status: "loading", organizationId: selectedOrganization });
    void getClient(`/bff/portal/admin/clients/${encodeURIComponent(selectedOrganization)}/buildings`, portalAdminBuildingListSchema, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setBuildings({ status: "ready", items: result.items, organizationId: selectedOrganization }); rememberCount(selectedOrganization, result.items.length);
      })
      .catch((error) => { if (!controller.signal.aborted && !expired(error)) setBuildings({ status: "error", organizationId: selectedOrganization }); });
    return () => controller.abort();
  }, [selectedOrganization, buildingRetry]);

  const clients = directory.status === "ready" ? directory.items : [];
  const query = search.trim().toLowerCase();
  const listed = clients.filter((client) => client.displayName.toLowerCase().includes(query) || client.clientPrefixes.some((prefix) => prefix.toLowerCase().includes(query)));
  const buildingState = buildings.organizationId === selectedOrganization ? buildings : { status: "loading" as const };
  const items = buildingState.status === "ready" ? buildingState.items : [];
  const robots = [...new Set(items.map((item) => item.buildingPrefix.split("/")[1]).filter(Boolean))].sort();
  const filtered = items.filter((item) => {
    if (robot && item.buildingPrefix.split("/")[1] !== robot) return false;
    if (report && !item.readyReports.includes(report as PortalAdminBuildingSummary["readyReports"][number])) return false;
    const day = item.scanTime?.slice(0, 10) ?? "";
    if (from && (!day || day < from) || to && (!day || day > to)) return false;
    return !query || `${item.displayName} ${item.address} ${item.buildingPrefix}`.toLowerCase().includes(query);
  });
  const clearFilters = () => { setSearch(""); setRobot(""); setReport(""); setFrom(""); setTo(""); };

  return <>
    <PageHeader title={requestedClient ? selected?.displayName ?? "Client" : "Clients"}
      description={requestedClient ? `Buildings for ${selected?.displayName ?? "this client"}.` : "Choose a client. Create a client and send invites from Organization tools."}
      actions={requestedClient ? <Link href="/projects" className="button button--outline">All clients</Link> : undefined} />
    {directory.status === "loading" ? <ContentState status="loading" message="Loading clients…" /> : null}
    {directory.status === "error" ? <ContentState status="error" title="Clients unavailable" message="We could not load your clients." onRetry={() => setDirectoryRetry((value) => value + 1)} /> : null}
    {directory.status === "ready" && requestedClient && !selected ? <ContentState status="error" title="Client unavailable" message="This client is not linked to an active organization." /> : null}
    {directory.status === "ready" && !requestedClient ? <section aria-labelledby="admin-clients-title">
      <SectionHeader title="Clients" titleId="admin-clients-title" count={clients.length} countLabel={`${clients.length} clients`}>
        {clients.length ? <SearchBar value={search} onChange={setSearch} placeholder="Search clients…" ariaLabel="Search clients" /> : null}
      </SectionHeader>
      {Object.values(counts).includes("error") ? <p role="status">Some building counts are unavailable. <button className="button button--outline" onClick={() => setCountRetry((value) => value + 1)}>Retry counts</button></p> : null}
      {!clients.length ? <EmptyState title="No clients available" description="Link a client in Organization tools to make it available here." /> : !listed.length ?
        <EmptyState isSearch title="No matching clients" description={<>No clients match “{search}”.</>} onClearSearch={() => setSearch("")} /> :
        <div className="project-grid">{listed.map((client) => {
          const count = counts[client.organizationId];
          return <Link className="project-card" key={client.organizationId} href={`/projects?client=${encodeURIComponent(client.clientPrefixes[0]!)}`}>
            <div className="project-card__body"><div className="project-card__header"><div className="project-card__title-wrap">
              <h3>{client.displayName}</h3><p className="project-card__address" aria-live="polite">{count === "error" ? "Building count unavailable" : typeof count === "number" ? `${count} ${count === 1 ? "building" : "buildings"}` : "Loading building count…"}</p>
            </div><span className="project-card__arrow" aria-hidden="true"><ArrowRightIcon /></span></div></div>
          </Link>;
        })}</div>}
    </section> : null}
    {selected ? <section aria-labelledby="admin-buildings-title">
      <SectionHeader title="Buildings" titleId="admin-buildings-title" count={buildingState.status === "ready" ? items.length : undefined}>
        <SearchBar value={search} onChange={setSearch} placeholder="Search buildings…" ariaLabel="Search buildings" />
      </SectionHeader>
      {buildingState.status === "loading" ? <ContentState status="loading" message="Loading buildings…" /> : buildingState.status === "error" ?
        <ContentState status="error" title="Buildings unavailable" message="We could not load buildings for this client." onRetry={() => setBuildingRetry((value) => value + 1)} /> : <>
          <div className="filter-bar">
            <label>Robot<select value={robot} onChange={(event) => setRobot(event.target.value)}><option value="">All</option>{robots.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label>Report<select value={report} onChange={(event) => setReport(event.target.value)}><option value="">All</option><option value="ASSESSMENT">Assessment</option><option value="EVIDENCE">Evidence</option><option value="ROOF_TAKEOFF">Roof takeoff</option><option value="AS_BUILT">As-built</option><option value="CAPITAL_PLANNING">Capital planning</option></select></label>
            <label>Scan from<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>Scan to<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
            {robot || report || from || to ? <button className="button button--outline" onClick={clearFilters}>Clear filters</button> : null}
          </div>
          {!items.length ? <EmptyState title="No buildings yet" description="Buildings for this client will appear here when available." /> : !filtered.length ?
            <EmptyState isSearch title="No matching buildings" description="No buildings match the current search and filters." onClearSearch={clearFilters} /> :
            <div className="project-grid">{filtered.map((item) => {
              const reportStatus = formatBuildingReportsStatus(item.readyReports, item.latestReportUpdate, item.timeZone);
              return <BuildingCard key={item.buildingId} href={`/buildings/view?prefix=${encodeURIComponent(item.buildingPrefix)}&buildingId=${encodeURIComponent(item.buildingId)}&client=${encodeURIComponent(selected.clientPrefixes[0]!)}`}
                displayName={item.displayName} address={item.address} scanDateText={formatBuildingScanDate(item.scanTime, item.timeZone)} reportsStatusText={reportStatus.text} reportsStatusIsNone={reportStatus.isNone} />;
            })}</div>}
        </>}
    </section> : null}
  </>;
}
