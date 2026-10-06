import type { ReactNode } from "react";

import { CountBadge } from "./count-badge";

export function SectionHeader({
  title,
  titleId,
  count,
  countLabel,
  children,
  className = "",
}: {
  title: ReactNode;
  titleId?: string | undefined;
  count?: number | string | undefined;
  countLabel?: string | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={`section-header-row ${className}`.trim()}>
      <div className="section-title-wrap">
        <h2 id={titleId}>{title}</h2>
        {count !== undefined ? (
          <CountBadge count={count} label={countLabel} />
        ) : null}
      </div>
      {children}
    </div>
  );
}
