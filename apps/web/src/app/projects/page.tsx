"use client";

import {
  clientOrganizationDocumentMetadataSchema,
  clientProjectListResponseSchema,
  type ClientOrganizationDocumentMetadata,
  type ClientProjectSummary,
} from "@bdr/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ArtifactActions } from "../../components/artifact-actions";
import { ArrowRightIcon, FileIcon, SearchIcon } from "../../components/icons";
import { usePortal } from "../../components/portal-shell";
import { ClientApiError, getClient } from "../../lib/client-api";
import { formatReportUpdatedDate, formatShortDate } from "../../lib/format";

type PageState =
  | { status: "loading" }
  | {
      status: "ready";
      projects: readonly ClientProjectSummary[];
      guide: ClientOrganizationDocumentMetadata | null;
    }
  | { status: "error"; message: string };

export default function ProjectsPage() {
  const { organization } = usePortal();
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [projects, guide] = await Promise.all([
          getClient("/bff/me/projects", clientProjectListResponseSchema),
          getClient(
            "/bff/me/documents/how-to-read",
            clientOrganizationDocumentMetadataSchema,
          ).catch((reason) => {
            if (reason instanceof ClientApiError && reason.status === 404) return null;
            throw reason;
          }),
        ]);
        if (active) setState({ status: "ready", projects: projects.items, guide });
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

  const filteredProjects = state.status === "ready"
    ? state.projects.filter((project) => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        return (
          project.displayName.toLowerCase().includes(q) ||
          project.address.toLowerCase().includes(q)
        );
      })
    : [];

  return (
    <>
      <section className="page-heading">
        <h1>Your projects</h1>
        <p>Inspection reports and building information for {organization.displayName}.</p>
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
                <h2 id="buildings-title">Buildings</h2>
                <span className="count-badge" aria-label={`${state.projects.length} buildings`}>
                  {state.projects.length}
                </span>
              </div>
              {state.projects.length > 0 ? (
                <div className="search-bar">
                  <SearchIcon className="search-bar__icon" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by building name or address…"
                    aria-label="Search buildings"
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

            {state.projects.length === 0 ? (
              <div className="empty-card">
                <h3>No projects available</h3>
                <p>Your published building projects will appear here.</p>
              </div>
            ) : filteredProjects.length === 0 ? (
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
              <div className="project-grid">
                {filteredProjects.map((project) => {
                  const li = project.latestInspection;
                  return (
                    <Link
                      className="project-card"
                      href={`/projects/${encodeURIComponent(project.projectId)}`}
                      key={project.projectId}
                    >
                      <div className="project-card__body">
                        <div className="project-card__header">
                          <div className="project-card__title-wrap">
                            <h3>{project.displayName}</h3>
                            <p className="project-card__address">{project.address}</p>
                          </div>
                          <span className="project-card__arrow" aria-hidden="true">
                            <ArrowRightIcon />
                          </span>
                        </div>
                      </div>
                      <div className="project-card__footer">
                        <div className="meta-item">
                          <span className="meta-label">Last scanned:</span>
                          {li ? (
                            <span className="meta-value">{formatShortDate(li.scannedAt, li.scanTimeZone)}</span>
                          ) : (
                            <span className="meta-value meta-value--none">No scans yet</span>
                          )}
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">Reports:</span>
                          {project.latestReportUpdate ? (
                            <span className="meta-value">
                              {formatReportUpdatedDate(
                                project.latestReportUpdate.publishedAt,
                                project.latestReportUpdate.scanTimeZone,
                              )}
                            </span>
                          ) : (
                            <span className="meta-value meta-value--none">No reports yet</span>
                          )}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {state.guide ? (
            <section className="guide-banner" aria-labelledby="guide-title">
              <div className="guide-banner__main">
                <span className="guide-banner__icon"><FileIcon /></span>
                <div className="guide-banner__copy">
                  <div className="guide-banner__heading-row">
                    <h3 id="guide-title">How to Read Your BDR Reports</h3>
                    <span className="updated-label">Updated {formatShortDate(state.guide.publishedAt)}</span>
                  </div>
                  <p>Understand report terminology, condition ratings, and recommended next steps.</p>
                </div>
              </div>
              <div className="guide-banner__actions">
                <ArtifactActions
                  accessPath="/bff/me/documents/how-to-read/access"
                  label="the How to Read guide"
                  compact
                />
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}
