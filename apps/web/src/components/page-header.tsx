import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode | undefined;
  eyebrow?: string | undefined;
  actions?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <section className={`page-heading ${className}`.trim()}>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <div className="section-header-row">
        <h1>{title}</h1>
        {actions ? <div className="page-heading__actions">{actions}</div> : null}
      </div>
      {description ? <p>{description}</p> : null}
    </section>
  );
}
