import { ArtifactActions } from "./artifact-actions";
import { FileIcon } from "./icons";

export function HowToReadBanner({
  updatedDateText,
  accessPath = "/bff/portal/how-to-read/current/access",
  error = false,
  className = "",
}: {
  updatedDateText?: string | undefined;
  accessPath?: string | undefined;
  error?: boolean | undefined;
  className?: string | undefined;
}) {
  if (error) {
    return (
      <div className={`guide-banner guide-banner--error ${className}`.trim()} role="alert">
        <p>The How to Read guide is temporarily unavailable.</p>
      </div>
    );
  }

  return (
    <section
      className={`guide-banner ${className}`.trim()}
      aria-labelledby="guide-title"
    >
      <div className="guide-banner__main">
        <span className="guide-banner__icon">
          <FileIcon />
        </span>
        <div className="guide-banner__copy">
          <div className="guide-banner__heading-row">
            <h3 id="guide-title">How to Read Your BDR Reports</h3>
            {updatedDateText ? (
              <span className="updated-label">Updated {updatedDateText}</span>
            ) : null}
          </div>
          <p>Understand report terminology, condition ratings, and recommended next steps.</p>
        </div>
      </div>
      <div className="guide-banner__actions">
        <ArtifactActions
          accessPath={accessPath}
          label="the How to Read guide"
          compact
        />
      </div>
    </section>
  );
}
