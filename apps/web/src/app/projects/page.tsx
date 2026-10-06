"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { BuildingCard } from "../../components/building-card";
import { ContentState } from "../../components/content-state";
import { EmptyState } from "../../components/empty-state";
import { HowToReadBanner } from "../../components/how-to-read-banner";
import { ArrowRightIcon } from "../../components/icons";
import { PageHeader } from "../../components/page-header";
import { usePortal } from "../../components/portal-shell";
import { SearchBar } from "../../components/search-bar";
import { SectionHeader } from "../../components/section-header";
import { ClientApiError, getClient } from "../../lib/client-api";
import {
  formatBuildingReportsStatus,
  formatBuildingScanDate,
  formatShortDate,
} from "../../lib/format";

type Building = {
  buildingPrefix: string;
  displayName: string;
  address: string;
  scanTime: string | null;
  uploadTime: string | null;
  timeZone: string | null;
  readyReports: string[];
  latestReportUpdate: string | null;
};

const asBuildings = {
  parse(value: unknown): { items: Building[]; admin: boolean } {
    const row = value as { items?: Building[]; admin?: boolean };
    return {
      items: (row.items ?? []).map((item) => ({
        buildingPrefix: String(item.buildingPrefix || ""),
        displayName: String(item.displayName || ""),
        address: String(item.address || ""),
        scanTime: item.scanTime ? String(item.scanTime) : null,
        uploadTime: item.uploadTime ? String(item.uploadTime) : null,
        timeZone: item.timeZone ? String(item.timeZone) : null,
        readyReports: Array.isArray(item.readyReports) ? item.readyReports.map(String) : [],
        latestReportUpdate: item.latestReportUpdate ? String(item.latestReportUpdate) : null,
      })),
      admin: Boolean(row.admin),
    };
  },
};

type GuideMetadata = {
  updatedAt: string;
};

const asGuideMetadata = {
  parse(value: unknown): GuideMetadata {
    const row = value as { updatedAt?: unknown };
    if (!row || typeof row.updatedAt !== "string") {
      throw new Error("Invalid guide metadata response");
    }
    return { updatedAt: row.updatedAt };
  },
};

type PageState =
  | { status: "loading" }
  | { status: "ready"; projects: readonly Building[] }
  | { status: "error"; message: string };

type GuideState =
  | { status: "loading" }
  | { status: "ready"; guide: GuideMetadata | null }
  | { status: "error" };

function clientName(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "").split("/")[0] || prefix;
}

function ProjectsPageContent() {
  const { organization } = usePortal();
  const requestedClient = useSearchParams().get("client");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [guideState, setGuideState] = useState<GuideState>({ status: "loading" });
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
        const [projectsRes, guideRes] = await Promise.allSettled([
          getClient("/bff/portal/buildings", asBuildings),
          getClient("/bff/portal/how-to-read/current", asGuideMetadata),
        ]);

        if (!active) return;

        if (projectsRes.status === "rejected") {
          const reason = projectsRes.reason;
          if (reason instanceof ClientApiError && reason.status === 401) {
            window.location.reload();
            return;
          }
          setState({
            status: "error",
            message: "We could not load your projects. Please try again.",
          });
        } else {
          setAdmin(projectsRes.value.admin);
          setState({ status: "ready", projects: projectsRes.value.items });
        }

        if (guideRes.status === "fulfilled") {
          setGuideState({ status: "ready", guide: guideRes.value });
        } else {
          const reason = guideRes.reason;
          if (reason instanceof ClientApiError && reason.status === 404) {
            setGuideState({ status: "ready", guide: null });
          } else {
            setGuideState({ status: "error" });
          }
        }
      } catch {
        if (active) {
          setState({
            status: "error",
            message: "We could not load your projects. Please try again.",
          });
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Client View
  // ---------------------------------------------------------------------------
  if (!admin && state.status === "ready") {
    const q = searchQuery.trim().toLowerCase();
    const filteredProjects = !q
      ? state.projects
      : state.projects.filter(
          (project) =>
            project.displayName.toLowerCase().includes(q) ||
            project.address.toLowerCase().includes(q),
        );

    return (
      <>
        <PageHeader
          title="Your projects"
          description={`Inspection reports and building information for ${organization.displayName}.`}
        />

        <section aria-labelledby="buildings-title">
          <SectionHeader
            title="Buildings"
            titleId="buildings-title"
            count={state.projects.length}
            countLabel={`${state.projects.length} buildings`}
          >
            {state.projects.length > 0 ? (
              <SearchBar
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search by building name or address…"
                ariaLabel="Search buildings"
              />
            ) : null}
          </SectionHeader>

          {state.projects.length === 0 ? (
            <EmptyState
              title="No projects available"
              description="Your published building projects will appear here."
            />
          ) : filteredProjects.length === 0 ? (
            <EmptyState
              isSearch
              title="No matching buildings"
              description={
                <>
                  No buildings match &ldquo;{searchQuery}&rdquo;. Check the
                  spelling or try another search term.
                </>
              }
              onClearSearch={() => setSearchQuery("")}
            />
          ) : (
            <div className="project-grid">
              {filteredProjects.map((project) => {
                const reportsStatus = formatBuildingReportsStatus(
                  project.readyReports,
                  project.latestReportUpdate,
                  project.timeZone,
                );
                const scanDateText = formatBuildingScanDate(
                  project.scanTime,
                  project.timeZone,
                );
                return (
                  <BuildingCard
                    key={project.buildingPrefix}
                    href={`/buildings/view?prefix=${encodeURIComponent(project.buildingPrefix)}`}
                    displayName={project.displayName}
                    address={project.address}
                    scanDateText={scanDateText}
                    reportsStatusText={reportsStatus.text}
                    reportsStatusIsNone={reportsStatus.isNone}
                  />
                );
              })}
            </div>
          )}
        </section>

        {guideState.status === "error" ? (
          <HowToReadBanner error />
        ) : guideState.status === "ready" && guideState.guide ? (
          <HowToReadBanner
            updatedDateText={formatShortDate(guideState.guide.updatedAt)}
            accessPath="/bff/portal/how-to-read/current/access"
          />
        ) : null}
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Administrator View
  // ---------------------------------------------------------------------------
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
        <ContentState status="loading" message="Loading projects…" />
      ) : null}

      {state.status === "error" ? (
        <ContentState
          status="error"
          title="Projects unavailable"
          message={state.message}
          onRetry={() => window.location.reload()}
        />
      ) : null}

      {state.status === "ready" ? (
        <>
          <section aria-labelledby="buildings-title">
            <SectionHeader
              title={showClients ? "Clients" : "Buildings"}
              titleId="buildings-title"
              count={showClients ? clients.length : clientBuildings.length}
              countLabel={showClients ? `${clients.length} clients` : `${clientBuildings.length} buildings`}
            >
              {state.projects.length > 0 ? (
                <SearchBar
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder={showClients ? "Search clients…" : "Search buildings…"}
                  ariaLabel={showClients ? "Search clients" : "Search buildings"}
                />
              ) : null}
            </SectionHeader>

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
                <label>
                  Robot
                  <select value={robot} onChange={(event) => setRobot(event.target.value)}>
                    <option value="">All</option>
                    {robots.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label>
                  Report
                  <select value={reportType} onChange={(event) => setReportType(event.target.value)}>
                    <option value="">All</option>
                    <option value="ASSESSMENT">Assessment</option>
                    <option value="EVIDENCE">Evidence</option>
                    <option value="ROOF_TAKEOFF">Roof takeoff</option>
                    <option value="CAPITAL_PLAN">Capital plan</option>
                  </select>
                </label>
                <label>
                  Scan from
                  <input type="date" value={scanFrom} onChange={(event) => setScanFrom(event.target.value)} />
                </label>
                <label>
                  Scan to
                  <input type="date" value={scanTo} onChange={(event) => setScanTo(event.target.value)} />
                </label>
                {scanFrom || scanTo || robot || reportType ? (
                  <button
                    type="button"
                    className="button button--outline"
                    onClick={() => {
                      setRobot("");
                      setReportType("");
                      setScanFrom("");
                      setScanTo("");
                    }}
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : null}

            {showClients && clients.length === 0 ? (
              <EmptyState
                title="No clients available"
                description="Client folders appear here when buildings are available to your account."
              />
            ) : showClients && filteredClients.length === 0 ? (
              <EmptyState
                isSearch
                title="No matching clients"
                description={<>No clients match &ldquo;{searchQuery}&rdquo;.</>}
                onClearSearch={() => setSearchQuery("")}
              />
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
                <EmptyState
                  isSearch
                  title="No matching buildings"
                  description={<>No buildings match &ldquo;{searchQuery}&rdquo;. Check the spelling or try another search term.</>}
                  onClearSearch={() => setSearchQuery("")}
                />
              ) : (
                <EmptyState
                  title="No buildings yet"
                  description="Buildings for this client appear here when they are available to your account."
                />
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
