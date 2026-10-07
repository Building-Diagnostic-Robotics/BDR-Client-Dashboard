"use client";

import { portalBuildingListResponseSchema } from "@bdr/contracts";
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
  buildingId: string;
  displayName: string;
  address: string;
  engineerNames: string;
  scanTime: string | null;
  uploadTime: string | null;
  timeZone: string | null;
  readyReports: string[];
  latestReportUpdate: string | null;
  inspectionCount: number;
};

const asBuildings = {
  parse(value: unknown): { items: Building[]; admin: boolean } {
    const row = portalBuildingListResponseSchema.parse(value);
    return {
      items: row.items.map((item) => ({
        buildingPrefix: "buildingPrefix" in item ? item.buildingPrefix : "",
        buildingId: item.buildingId,
        displayName: item.displayName,
        address: item.address,
        engineerNames: item.engineerNames,
        scanTime: item.latestInspection?.scannedAt ?? null,
        uploadTime: item.latestInspection?.uploadCompletedAt ?? null,
        timeZone: item.latestInspection?.timeZone ?? null,
        readyReports: item.latestInspection?.availableReportTypes ?? [],
        latestReportUpdate: item.latestInspection?.latestReportUpdate ?? null,
        inspectionCount: item.inspectionCount,
      })),
      admin: row.admin,
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
  const { organization, admin: portalAdmin } = usePortal();
  const admin = Boolean(portalAdmin);
  const requestedClient = useSearchParams().get("client");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [guideState, setGuideState] = useState<GuideState>({ status: "loading" });
  const [searchQuery, setSearchQuery] = useState("");
  const [robot, setRobot] = useState("");
  const [reportType, setReportType] = useState("");
  const [scanFrom, setScanFrom] = useState("");
  const [scanTo, setScanTo] = useState("");
  const [selectedClient, setSelectedClient] = useState<string | null>(requestedClient);

  useEffect(() => {
    let active = true;

    async function loadProjects() {
      try {
        const projects = await getClient("/bff/portal/buildings", asBuildings);
        if (!active) return;
        setState({ status: "ready", projects: projects.items });
      } catch (reason) {
        if (!active) return;
        if (reason instanceof ClientApiError && reason.status === 401) {
          window.location.reload();
          return;
        }
        setState({
          status: "error",
          message: "We could not load your projects. Please try again.",
        });
      }
    }

    async function loadGuide() {
      try {
        const guide = await getClient("/bff/portal/how-to-read/current", asGuideMetadata);
        if (active) setGuideState({ status: "ready", guide });
      } catch (reason) {
        if (!active) return;
        if (reason instanceof ClientApiError && reason.status === 401) {
          window.location.reload();
          return;
        }
        if (reason instanceof ClientApiError && reason.status === 404) {
          setGuideState({ status: "ready", guide: null });
        } else {
          setGuideState({ status: "error" });
        }
      }
    }

    void loadProjects();
    if (admin) {
      setGuideState({ status: "ready", guide: null });
    } else {
      void loadGuide();
    }
    return () => {
      active = false;
    };
  }, [admin]);

  // ---------------------------------------------------------------------------
  // Client View
  // ---------------------------------------------------------------------------
  if (!admin) {
    const q = searchQuery.trim().toLowerCase();
    const projects = state.status === "ready" ? state.projects : [];
    const filteredProjects = !q
      ? projects
      : projects.filter(
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
          <section aria-labelledby="buildings-title">
            <SectionHeader
              title="Buildings"
              titleId="buildings-title"
              count={projects.length}
              countLabel={`${projects.length} buildings`}
            >
              {projects.length > 0 ? (
                <SearchBar
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="Search by building name or address…"
                  ariaLabel="Search buildings"
                />
              ) : null}
            </SectionHeader>

            {projects.length === 0 ? (
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
                      key={project.buildingId || project.buildingPrefix}
                      href={project.buildingId
                        ? `/buildings/view?buildingId=${encodeURIComponent(project.buildingId)}`
                        : `/buildings/view?prefix=${encodeURIComponent(project.buildingPrefix)}`}
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
        ) : null}

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
                    href={project.buildingId
                      ? `/buildings/view?prefix=${encodeURIComponent(project.buildingPrefix)}&buildingId=${encodeURIComponent(project.buildingId)}&client=${encodeURIComponent(clientName(project.buildingPrefix))}`
                      : `/buildings/view?prefix=${encodeURIComponent(project.buildingPrefix)}&client=${encodeURIComponent(clientName(project.buildingPrefix))}`}
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
