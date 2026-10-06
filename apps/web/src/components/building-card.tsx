import Link from "next/link";
import type { ReactNode } from "react";

import { ArrowRightIcon } from "./icons";

export function BuildingCard({
  href,
  onClick,
  displayName,
  address,
  scanDateText,
  reportsStatusText,
  reportsStatusIsNone = false,
  footer,
  className = "",
}: {
  href?: string | undefined;
  onClick?: (() => void) | undefined;
  displayName: string;
  address?: string | null | undefined;
  scanDateText?: string | undefined;
  reportsStatusText?: string | undefined;
  reportsStatusIsNone?: boolean | undefined;
  footer?: ReactNode | undefined;
  className?: string | undefined;
}) {
  const content = (
    <>
      <div className="project-card__body">
        <div className="project-card__header">
          <div className="project-card__title-wrap">
            <h3>{displayName}</h3>
            <p className="project-card__address">{address || "No address yet"}</p>
          </div>
          <span className="project-card__arrow" aria-hidden="true">
            <ArrowRightIcon />
          </span>
        </div>
      </div>
      {footer ? (
        footer
      ) : scanDateText || reportsStatusText ? (
        <div className="project-card__footer">
          {scanDateText ? (
            <div className="meta-item">
              <span className="meta-label">Last scanned:</span>
              <span className={scanDateText === "No scans yet" ? "meta-value meta-value--none" : "meta-value"}>
                {scanDateText}
              </span>
            </div>
          ) : null}
          {reportsStatusText ? (
            <div className="meta-item">
              <span className="meta-label">Reports:</span>
              <span className={reportsStatusIsNone ? "meta-value meta-value--none" : "meta-value"}>
                {reportsStatusText}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`project-card ${className}`.trim()}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`project-card ${className}`.trim()}
    >
      {content}
    </button>
  );
}
