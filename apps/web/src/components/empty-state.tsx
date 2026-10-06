import type { ReactNode } from "react";

import { SearchIcon } from "./icons";

export function EmptyState({
  title,
  description,
  isSearch = false,
  onClearSearch,
  action,
  className = "",
}: {
  title: string;
  description: ReactNode;
  isSearch?: boolean | undefined;
  onClearSearch?: (() => void) | undefined;
  action?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div className={`empty-card ${isSearch ? "empty-card--search" : ""} ${className}`.trim()}>
      {isSearch ? <SearchIcon className="empty-card__search-icon" /> : null}
      <h3>{title}</h3>
      <p>{description}</p>
      {onClearSearch ? (
        <button
          type="button"
          className="button button--outline"
          onClick={onClearSearch}
        >
          Clear search
        </button>
      ) : null}
      {action}
    </div>
  );
}
