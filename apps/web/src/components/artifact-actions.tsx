"use client";

import { artifactAccessResponseSchema } from "@bdr/contracts";
import { useState } from "react";

import { ClientApiError, loginPath, postClient } from "../lib/client-api";
import { DownloadIcon, EyeIcon } from "./icons";

type Disposition = "VIEW" | "DOWNLOAD";

export function ArtifactActions({
  accessPath,
  requestBody,
  label,
  compact = false,
  downloadVariant = "outline-green",
}: {
  accessPath: string;
  requestBody?: Readonly<Record<string, unknown>> | undefined;
  label: string;
  compact?: boolean;
  downloadVariant?: "primary" | "outline" | "outline-green";
}) {
  const [pending, setPending] = useState<Disposition | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(disposition: Disposition) {
    setPending(disposition);
    setError(null);
    const previewWindow = disposition === "VIEW" ? window.open("about:blank", "_blank") : null;
    if (previewWindow) {
      previewWindow.opener = null;
    }

    try {
      if (previewWindow) {
        previewWindow.document.title = "Opening report…";
        previewWindow.document.body.textContent = "Opening report…";
      }
      const access = await postClient(
        accessPath,
        { ...requestBody, disposition },
        artifactAccessResponseSchema,
      );
      if (disposition === "VIEW") {
        if (previewWindow) previewWindow.location.replace(access.url);
        else window.location.assign(access.url);
      } else {
        window.location.assign(access.url);
      }
    } catch (reason) {
      previewWindow?.close();
      if (reason instanceof ClientApiError && reason.status === 401) {
        window.location.replace(loginPath(window.location.pathname));
        return;
      }
      setError(`We could not open ${label}. Please try again.`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={compact ? "artifact-actions artifact-actions--compact" : "artifact-actions"} aria-busy={pending !== null}>
      <button
        className="button button--outline"
        type="button"
        onClick={() => void open("VIEW")}
        disabled={pending !== null}
      >
        <EyeIcon />
        {pending === "VIEW" ? "Opening…" : "View"}
      </button>
      <button
        className={
          downloadVariant === "outline-green"
            ? "button button--outline-green"
            : downloadVariant === "outline"
            ? "button button--outline"
            : "button button--primary"
        }
        type="button"
        onClick={() => void open("DOWNLOAD")}
        disabled={pending !== null}
      >
        <DownloadIcon />
        {pending === "DOWNLOAD" ? "Preparing…" : "Download"}
      </button>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </div>
  );
}
