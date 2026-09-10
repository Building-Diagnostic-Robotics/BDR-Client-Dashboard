# BDR Client Dashboard

BDR Client Dashboard is a secure web portal for Building Diagnostic Robotics clients. Customers will use it to view their buildings, review current and historical scans, and preview or download published inspection reports.

The portal will also provide protected administration pages for BDR staff to manage client organizations, users, projects, inspections, and report publication.

The initial release will use administrator-uploaded PDFs stored in private portal-owned AWS storage. A later ReportGen integration will support controlled, automatic publication without exposing ReportGen's operational S3 bucket to the dashboard.

See [plan.md](./plan.md) for the current architecture and implementation plan.
