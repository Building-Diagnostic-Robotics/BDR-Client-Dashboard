"use client";

import {
  clientOrganizationDocumentMetadataSchema,
  clientProjectListResponseSchema,
  type ClientOrganizationDocumentMetadata,
  type ClientProject,
} from "@bdr/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ArtifactActions } from "../../components/artifact-actions";
import { ArrowRightIcon, BuildingIcon, FileIcon } from "../../components/icons";
import { usePortal } from "../../components/portal-shell";
import { ClientApiError, getClient } from "../../lib/client-api";
import { formatShortDate } from "../../lib/format";

type PageState =
  | { status: "loading" }
  | {
      status: "ready";
      projects: readonly ClientProject[];
      guide: ClientOrganizationDocumentMetadata | null;
    }
  | { status: "error"; message: string };

export default function ProjectsPage() {
  const { organization } = usePortal();
  const [state, setState] = useState<PageState>({ status: "loading" });

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

  return (
    <>
      <section className="page-heading">
        <p className="eyebrow">Client portal</p>
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
          {state.guide ? (
            <section className="guide-card" aria-labelledby="guide-title">
              <span className="icon-tile icon-tile--green"><FileIcon /></span>
              <div className="guide-card__copy">
                <p className="eyebrow">Reference guide</p>
                <h2 id="guide-title">How to Read Your BDR Reports</h2>
                <p>Understand report terminology, condition ratings, and recommended next steps.</p>
                <span className="updated-label">Updated {formatShortDate(state.guide.publishedAt)}</span>
              </div>
              <ArtifactActions
                accessPath="/bff/me/documents/how-to-read/access"
                label="the How to Read guide"
                compact
              />
            </section>
          ) : null}

          <section aria-labelledby="buildings-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Portfolio</p>
                <h2 id="buildings-title">Buildings</h2>
              </div>
              <span className="item-count">{state.projects.length} {state.projects.length === 1 ? "project" : "projects"}</span>
            </div>

            {state.projects.length === 0 ? (
              <div className="empty-card">
                <BuildingIcon />
                <h3>No projects available</h3>
                <p>Your published building projects will appear here.</p>
              </div>
            ) : (
              <div className="project-grid">
                {state.projects.map((project) => (
                  <Link className="project-card" href={`/projects/${encodeURIComponent(project.projectId)}`} key={project.projectId}>
                    <span className="icon-tile"><BuildingIcon /></span>
                    <div>
                      <h3>{project.displayName}</h3>
                      <p>{project.address}</p>
                    </div>
                    <span className="project-card__link">View project <ArrowRightIcon /></span>
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
