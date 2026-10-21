"use client";

import { portalBuildingListResponseSchema } from "@bdr/contracts";
import { Suspense, useEffect, useState } from "react";

import { AdminProjects } from "./admin-projects";
import { BuildingCard } from "../../components/building-card";
import { ContentState } from "../../components/content-state";
import { EmptyState } from "../../components/empty-state";
import { HowToReadBanner } from "../../components/how-to-read-banner";
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

function ClientProjects() {
  const { organization } = usePortal();
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [guideState, setGuideState] = useState<GuideState>({ status: "loading" });
  const [searchQuery, setSearchQuery] = useState("");

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
    void loadGuide();
    return () => {
      active = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Client View
  // ---------------------------------------------------------------------------
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

function ProjectsPageContent() {
  const { admin } = usePortal();
  return admin ? <AdminProjects /> : <ClientProjects />;
}

export default function ProjectsPage() {
  return (
    <Suspense>
      <ProjectsPageContent />
    </Suspense>
  );
}
