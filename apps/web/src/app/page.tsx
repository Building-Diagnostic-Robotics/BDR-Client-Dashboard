import type { ReportDeliveryStatus, ReportType } from "@bdr/contracts";

type ReportSummary = {
  type: ReportType;
  name: string;
  description: string;
  status: ReportDeliveryStatus;
  updatedAt?: string;
};

const statusLabels: Record<ReportDeliveryStatus, string> = {
  PUBLISHED: "Available",
  EXPECTED: "In preparation",
  NOT_INCLUDED: "Not included",
  NOT_APPLICABLE: "Not applicable",
};

const reports: ReportSummary[] = [
  {
    type: "ASSESSMENT",
    name: "Roof Assessment",
    description: "Findings, conditions, and recommended actions",
    status: "PUBLISHED",
    updatedAt: "Updated Sep 7, 2026",
  },
  {
    type: "EVIDENCE",
    name: "Inspection Evidence",
    description: "Documented imagery and observed conditions",
    status: "PUBLISHED",
    updatedAt: "Published Sep 6, 2026",
  },
  {
    type: "ROOF_TAKEOFF",
    name: "Roof Takeoff",
    description: "Measured roof areas and quantities",
    status: "EXPECTED",
  },
  {
    type: "CAPITAL_PLANNING",
    name: "Capital Planning",
    description: "Long-term maintenance and budget outlook",
    status: "NOT_INCLUDED",
  },
];

function StatusBadge({ status }: { status: ReportDeliveryStatus }) {
  return (
    <span className={`status status--${status.toLowerCase()}`}>
      <span className="status__dot" aria-hidden="true" />
      {statusLabels[status]}
    </span>
  );
}

function ReportCard({ report }: { report: ReportSummary }) {
  const available = report.status === "PUBLISHED";

  return (
    <article className="report-card">
      <div className="report-card__heading">
        <span className="report-card__mark" aria-hidden="true">
          {report.name.charAt(0)}
        </span>
        <div>
          <h3>{report.name}</h3>
          <p>{report.description}</p>
        </div>
      </div>

      <div className="report-card__meta">
        <StatusBadge status={report.status} />
        {report.updatedAt ? <span>{report.updatedAt}</span> : null}
      </div>

      {available ? (
        <div className="report-card__actions" aria-label={`${report.name} actions`}>
          <button type="button" className="button button--secondary" disabled>
            Preview
          </button>
          <button type="button" className="button button--primary" disabled>
            Download PDF
          </button>
        </div>
      ) : (
        <p className="report-card__note">
          {report.status === "EXPECTED"
            ? "BDR will publish this report when it is ready."
            : "This report is not part of this inspection."}
        </p>
      )}
    </article>
  );
}

export default function DashboardPage() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#main-content" aria-label="BDR dashboard home">
          <span className="brand__symbol" aria-hidden="true">BDR</span>
          <span className="brand__name">Client Portal</span>
        </a>

        <nav aria-label="Primary navigation">
          <a className="nav-link nav-link--active" href="#projects" aria-current="page">
            <span aria-hidden="true">01</span>
            Projects
          </a>
          <a className="nav-link" href="#guide">
            <span aria-hidden="true">02</span>
            How to Read
          </a>
        </nav>

        <div className="sidebar__account">
          <span className="avatar" aria-hidden="true">MH</span>
          <div>
            <strong>Midland Holdings</strong>
            <span>Client account</span>
          </div>
        </div>
      </aside>

      <main id="main-content" className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Portfolio overview</p>
            <h1>Your buildings</h1>
          </div>
          <button type="button" className="account-button" aria-label="Open account menu" disabled>
            RS
          </button>
        </header>

        <section id="guide" className="guide-card" aria-labelledby="guide-title">
          <div className="guide-card__icon" aria-hidden="true">?</div>
          <div className="guide-card__copy">
            <p className="eyebrow">Reference guide</p>
            <h2 id="guide-title">How to Read Your BDR Reports</h2>
            <p>Understand report terminology, condition ratings, and recommended next steps.</p>
          </div>
          <div className="guide-card__actions">
            <span className="updated-label">Updated Aug 18, 2026</span>
            <button type="button" className="button button--light" disabled>
              View guide
            </button>
          </div>
        </section>

        <section id="projects" className="project" aria-labelledby="project-title">
          <div className="project__header">
            <div>
              <p className="eyebrow">Building 01</p>
              <h2 id="project-title">Midland Business Park</h2>
              <p className="project__address">4300 West Loop, Fort Worth, TX 76116</p>
            </div>
            <dl className="project__summary">
              <div>
                <dt>Latest scan</dt>
                <dd>Sep 4, 2026</dd>
              </div>
              <div>
                <dt>Published scans</dt>
                <dd>2</dd>
              </div>
            </dl>
          </div>

          <section className="inspection" aria-labelledby="latest-inspection-title">
            <div className="inspection__header">
              <div>
                <span className="latest-pill">Latest inspection</span>
                <h2 id="latest-inspection-title">September 4, 2026</h2>
                <p>Scanned at 9:30 AM CDT</p>
              </div>
              <span className="report-count">2 reports available</span>
            </div>

            <div className="report-grid">
              {reports.map((report) => (
                <ReportCard key={report.type} report={report} />
              ))}
            </div>
          </section>

          <section className="history" aria-labelledby="history-title">
            <div>
              <p className="eyebrow">Previous inspection</p>
              <h2 id="history-title">February 12, 2026</h2>
              <p>Four published reports</p>
            </div>
            <button type="button" className="button button--secondary" disabled>
              View inspection
            </button>
          </section>
        </section>
      </main>
    </div>
  );
}
