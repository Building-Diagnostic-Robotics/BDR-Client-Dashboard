import type { ReactNode } from "react";

export function ContentState({
  status,
  title,
  message,
  onRetry,
  className = "",
}: {
  status: "loading" | "error";
  title?: string | undefined;
  message?: ReactNode | undefined;
  onRetry?: (() => void) | undefined;
  className?: string | undefined;
}) {
  if (status === "loading") {
    return (
      <section className={`content-state ${className}`.trim()} aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <p>{message ?? "Loading…"}</p>
      </section>
    );
  }

  return (
    <section className={`content-state content-state--error ${className}`.trim()} role="alert">
      <h2>{title ?? "Unavailable"}</h2>
      {message ? <p>{message}</p> : null}
      {onRetry ? (
        <button
          className="button button--primary"
          type="button"
          onClick={onRetry}
        >
          Try again
        </button>
      ) : null}
    </section>
  );
}
