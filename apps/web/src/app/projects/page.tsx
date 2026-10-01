"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { ArrowRightIcon, SearchIcon } from "../../components/icons";
import { usePortal } from "../../components/portal-shell";
import { ClientApiError, getClient } from "../../lib/client-api";

type Building = {
  buildingPrefix: string;
  displayName: string;
  address: string;
  scanTime: string | null;
  uploadTime: string | null;
  readyReports: string[];
};

const asBuildings = {
  parse(value: unknown): { items: Building[]; admin: boolean } {
    const row = value as { items?: Building[]; admin?: boolean };
    return { items: row.items ?? [], admin: Boolean(row.admin) };
  },
};

type PageState =
  | { status: "loading" }
  | { status: "ready"; projects: readonly Building[] }
  | { status: "error"; message: string };

function clientName(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "").split("/")[0] || prefix;
}

function ProjectsPageContent() {
  const { organization } = usePortal();
  const requestedClient = useSearchParams().get("client");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [searchQuery, setSearchQuery] = useState("");
  const [robot, setRobot] = useState("");
  const [reportType, setReportType] = useState("");
  const [scanFrom, setScanFrom] = useState("");
  const [scanTo, setScanTo] = useState("");
  const [selectedClient, setSelectedClient] = useState<string | null>(requestedClient);
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const projects = await getClient("/bff/portal/buildings", asBuildings);
        if (active) {
          setAdmin(projects.admin);
          setState({ status: "ready", projects: projects.items });
        }
      } catch (reason) {
        if (reason instanceof ClientApiError && reason.status === 401) {
          window.location.reload();
          return;
        }
        if (active) setState({
          status: "error",
          message: "We could not load your projects. Please try again.",
        });
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  const clients = state.status === "ready"
    ? [...new Set(state.projects.map((project) => clientName(project.buildingPrefix)))].sort()
    : [];
  const showClients = admin && !selectedClient;
  const clientBuildings = state.status === "ready"
    ? (admin
      ? state.projects.filter((project) => selectedClient && clientName(project.buildingPrefix) === selectedClient)
      : state.projects)
    : [];
  const filteredClients = clients.filter((name) => name.toLowerCase().includes(searchQuery.trim().toLowerCase()));
  const filteredProjects = clientBuildings.filter((project) => {
    const q = searchQuery.trim().toLowerCase();
    const parts = project.buildingPrefix.split("/");
    const projectRobot = parts[1] || "";
    if (robot && projectRobot !== robot) return false;
    if (reportType && !project.readyReports.includes(reportType)) return false;
    const day = project.scanTime?.slice(0, 10) ?? "";
    if (scanFrom && (!day || day < scanFrom)) return false;
    if (scanTo && (!day || day > scanTo)) return false;
    if (!q) return true;
    return (
      project.displayName.toLowerCase().includes(q) ||
      project.address.toLowerCase().includes(q) ||
      project.buildingPrefix.toLowerCase().includes(q)
    );
  });
  const robots = [...new Set(clientBuildings.map((project) => project.buildingPrefix.split("/")[1]).filter(Boolean))].sort();

  return (
    <>
      <section className="page-heading">
        <div className="section-header-row">
          <h1>{showClients ? "Clients" : selectedClient ?? "Buildings"}</h1>
        </div>
        <p>
          {showClients
            ? "Choose a client. Create a client and send invites from Organization tools."
            : admin
              ? `Buildings for ${selectedClient}.`
              : `Buildings for ${organization.displayName}.`}
        </p>
      </section>

      {state.status === "loading" ? (
        <section className="content-state" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          <p>Loading projects…</p>
        </section>
      ) : null}

      {state.status === "error" ? (
        <section className="content-state content-state--error" role="alert">
          <h2>Projects unavailable</h2>
          <p>{state.message}</p>
          <button className="button button--primary" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </section>
      ) : null}

      {state.status === "ready" ? (
        <>
          <section aria-labelledby="buildings-title">
            <div className="section-header-row">
              <div className="section-title-wrap">
                <h2 id="buildings-title">{showClients ? "Clients" : "Buildings"}</h2>
                <span className="count-badge" aria-label={showClients ? `${clients.length} clients` : `${clientBuildings.length} buildings`}>
                  {showClients ? clients.length : clientBuildings.length}
                </span>
              </div>
              {state.projects.length > 0 ? (
                <div className="search-bar">
                  <SearchIcon className="search-bar__icon" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={showClients ? "Search clients…" : "Search buildings…"}
                    aria-label={showClients ? "Search clients" : "Search buildings"}
                    className="search-bar__input"
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      className="search-bar__clear"
                      onClick={() => setSearchQuery("")}
                      aria-label="Clear search"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {!showClients ? (
              <div className="filter-bar">
                {admin && selectedClient ? (
                  <button
                    type="button"
                    className="button button--outline"
                    onClick={() => {
                      setSelectedClient(null);
                      setSearchQuery("");
                      setRobot("");
                      setReportType("");
                      setScanFrom("");
                      setScanTo("");
                    }}
                  >
                    All clients
                  </button>
                ) : null}
                <label>Robot
                  <select value={robot} onChange={(event) => setRobot(event.target.value)}>
                    <option value="">All</option>
                    {robots.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label>Report
                  <select value={reportType} onChange={(event) => setReportType(event.target.value)}>
                    <option value="">All</option>
                    <option value="ASSESSMENT">Assessment</option>
                    <option value="EVIDENCE">Evidence</option>
                    <option value="ROOF_TAKEOFF">Roof takeoff</option>
                    <option value="CAPITAL_PLAN">Capital plan</option>
                  </select>
                </label>
                <label>Scan from
                  <input type="date" value={scanFrom} onChange={(event) => setScanFrom(event.target.value)} />
                </label>
                <label>Scan to
                  <input type="date" value={scanTo} onChange={(event) => setScanTo(event.target.value)} />
                </label>
                {scanFrom || scanTo || robot || reportType ? (
                  <button type="button" className="button button--outline" onClick={() => {
                    setRobot("");
                    setReportType("");
                    setScanFrom("");
                    setScanTo("");
                  }}>Clear filters</button>
                ) : null}
              </div>
            ) : null}
            {showClients && clients.length === 0 ? (
              <div className="empty-card">
                <h3>No clients available</h3>
                <p>Client folders appear here when buildings are available to your account.</p>
              </div>
            ) : showClients && filteredClients.length === 0 ? (
              <div className="empty-card empty-card--search">
                <SearchIcon className="empty-card__search-icon" />
                <h3>No matching clients</h3>
                <p>No clients match &ldquo;{searchQuery}&rdquo;.</p>
                <button type="button" className="button button--outline" onClick={() => setSearchQuery("")}>
                  Clear search
                </button>
              </div>
            ) : showClients ? (
              <div className="project-grid">
                {filteredClients.map((name) => {
                  const count = state.projects.filter((project) => clientName(project.buildingPrefix) === name).length;
                  return (
                    <button
                      type="button"
                      className="project-card"
                      key={name}
                      onClick={() => {
                        setSelectedClient(name);
                        setSearchQuery("");
                      }}
                    >
                      <div className="project-card__body">
                        <div className="project-card__header">
                          <div className="project-card__title-wrap">
                            <h3>{name}</h3>
                            <p className="project-card__address">{count} {count === 1 ? "building" : "buildings"}</p>
                          </div>
                          <span className="project-card__arrow" aria-hidden="true">
                            <ArrowRightIcon />
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : filteredProjects.length === 0 ? (
              searchQuery ? (
                <div className="empty-card empty-card--search">
                  <SearchIcon className="empty-card__search-icon" />
                  <h3>No matching buildings</h3>
                  <p>No buildings match &ldquo;{searchQuery}&rdquo;. Check the spelling or try another search term.</p>
                  <button
                    type="button"
                    className="button button--outline"
                    onClick={() => setSearchQuery("")}
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <div className="empty-card">
                  <h3>No buildings yet</h3>
                  <p>Buildings for this client appear here when they are available to your account.</p>
                </div>
              )
            ) : (
              <div className="project-grid">
                {filteredProjects.map((project) => (
                    <Link
                      className="project-card"
                      href={`/buildings/view?prefix=${encodeURIComponent(project.buildingPrefix)}`}
                      key={project.buildingPrefix}
                    >
                      <div className="project-card__body">
                        <div className="project-card__header">
                          <div className="project-card__title-wrap">
                            <h3>{project.displayName}</h3>
                            <p className="project-card__address">{project.address || "No address yet"}</p>
                          </div>
                          <span className="project-card__arrow" aria-hidden="true">
                            <ArrowRightIcon />
                          </span>
                        </div>
                      </div>
                      <div className="project-card__footer">
                        <div className="meta-item">
                          <span className="meta-label">Scan:</span>
                          <span className={project.scanTime ? "meta-value" : "meta-value meta-value--none"}>
                            {project.scanTime ?? "No scan time"}
                          </span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">Reports:</span>
                          <span className={project.readyReports.length ? "meta-value" : "meta-value meta-value--none"}>
                            {project.readyReports.join(", ") || "No reports yet"}
                          </span>
                        </div>
                      </div>
                    </Link>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense>
      <ProjectsPageContent />
    </Suspense>
  );
}
