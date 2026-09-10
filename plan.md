# BDR Client Dashboard Plan

## Purpose

Build a secure client dashboard where BDR customers can sign in, view their buildings and scan history, and preview or download published reports. The latest scan is emphasized while all earlier scans and reports remain accessible.

The same application will include protected administration pages for BDR staff to manage organizations, users, projects, inspections, and reports.

## Core Domain Model

```text
Organization
  |-- Users
  `-- Projects / Buildings
        `-- Inspections / Scans
              `-- Reports
                    `-- Report Versions
```

Every entity uses an opaque unique ID that is not derived from an email address, name, street address, filename, or S3 path:

- `organizationId`: client/company identity.
- `userId`: portal user identity, mapped separately to the Cognito `sub`.
- `projectId`: persistent building/property identity.
- `inspectionId`: one physical scan event.
- `reportId`: one report category within an inspection.
- `reportVersionId`: an immutable published PDF version.
- `sourceScanId`: future ReportGen idempotency identity for a scan.

Each client user belongs to exactly one organization. The data model supports multiple users per organization even though the first release will allow one active client user per organization. BDR administrators are global and are not assigned to a client organization.

## Scan and Report Behavior

- A project represents one building or property and can contain any number of inspections.
- Reports belong to an inspection, never directly to a project.
- Scans are ordered by the actual `scannedAt` timestamp, newest first.
- The latest scan is visually dominant even when its reports are still pending.
- The previous completed scan remains easy to access.
- Multiple scans on the same day are distinguished by timestamp and `inspectionId`.
- The project card shows the latest scan date and status, report availability, and total scan count.
- The project page highlights the latest scan and presents older scans as history.
- Clients see the current report version; BDR administrators can view previous versions.
- Archiving hides records without permanently deleting metadata or published files.

The initial report categories are:

1. Assessment
2. Evidence
3. How to Read
4. Roof Takeoff
5. Capital Planning

An inspection remains visible when only some reports are available. Each category displays an available or not-yet-published status.

## Application Architecture

```text
Next.js portal on Netlify
  |-- Client routes
  `-- BDR admin routes
          |
          v
Portal Cognito user pool
          |
          v
API Gateway + Lambda services
  |-- Client API
  |-- Admin API
  `-- Future ReportGen Import Worker
          |
          +-- DynamoDB registry and audit records
          +-- Portal upload quarantine S3 bucket
          `-- Portal published-report S3 bucket
```

- Use a TypeScript monorepo for the Next.js application, Lambda services, shared API contracts, and AWS CDK infrastructure.
- Deploy isolated development and production environments in `us-east-1`.
- Each environment has separate Cognito, API, DynamoDB, S3, encryption, and monitoring resources.
- Use one invite-only portal Cognito pool per environment.
- BDR administrators belong to a protected `bdr-admins` Cognito group.
- Self-signup is disabled. BDR staff invite and revoke client users.
- MFA is optional in the first release. This is a known weakness for global administrator accounts and must remain configurable for later enforcement.
- Authorization is enforced by the API on every request; UI visibility is not an authorization control.
- Client-facing project metadata is stored in the portal registry. Clients cannot edit it in the first release.

## Initial Report Publication

The first release will use manual uploads only. No portal service receives access to the operational ReportGen bucket.

```text
BDR admin selects organization, project, and inspection
  -> uploads PDF to portal quarantine
  -> file validation and malware scan
  -> admin reviews report type and metadata
  -> admin clicks Publish
  -> immutable copy enters published storage
  -> DynamoDB current-version pointer updates atomically
  -> report becomes visible to the client
```

- Manual upload supports all five report categories.
- Upload through a short-lived presigned request with a configurable 500 MB limit.
- Validate the file extension, content type, PDF signature, size, and checksum.
- Scan quarantine uploads before publication. Only a successful clean result can be published.
- The administrator's Publish action is the approval step.
- Store published PDFs under unique version-specific keys; never overwrite an existing object.
- Generate short-lived preview and download URLs only after authorization.
- The client API can read only registered objects in the published-report bucket.
- The quarantine bucket and published bucket are private, encrypted, versioned, and blocked from public access.

## Future ReportGen Integration

ReportGen currently has no client-export service or isolated export bucket. This integration will be implemented later in the ReportGen repository.

```text
ReportGen operational S3
  -> ReportGen operator clicks Publish to Client Portal
  -> controlled ReportGen Export Service
  -> separate ReportGen export bucket
  -> portal Import Worker
  -> portal published-report bucket and registry
  -> automatic client visibility
```

The future design will follow these rules:

- The ReportGen Publish screen lets the operator select the destination portal organization and project.
- ReportGen queries only a narrow, AWS IAM-protected portal endpoint for active organization and project choices.
- The ReportGen Publish action is the final approval; no second dashboard-admin approval is required.
- Each scan has a stable `sourceScanId`, and every export attempt has a unique `exportId`.
- ReportGen copies only selected client-ready PDFs into an isolated export package.
- `manifest.json` is written last so its presence marks a complete package.
- The manifest contains destination IDs, scan identity, report types, checksums, sizes, generation time, and source provenance.
- Raw imagery, intermediate pipeline data, prompts, logs, credentials, configuration files, and unrelated artifacts are never exported.
- Only the separate portal Import Worker can read the export bucket. The normal client and admin APIs cannot read it.
- The portal validates the manifest, destination, checksums, report types, and idempotency before publishing.
- Successful imports become client-visible automatically after the portal transaction completes.
- Missing or invalid destination mappings fail closed; the system never guesses from names or paths.
- Export packages expire after 30 days. Portal-published copies remain retained.
- ReportGen reports `Publishing`, `Published`, or `Failed`; `Published` means the portal import completed successfully.
- The dashboard never browses the operational ReportGen bucket. Administrators browse portal import and publication history instead.

## Metadata Ownership

- The portal owns the project metadata shown to clients.
- Manual setup or a future ReportGen export can propose project and inspection metadata.
- ReportGen metadata does not silently overwrite current portal project metadata.
- Administrators can review and explicitly apply proposed metadata changes.
- Each inspection preserves an inspection-time metadata snapshot so historical reports remain understandable after project information changes.

## Persistence and Auditing

Use DynamoDB for:

- Organizations
- User profiles and organization membership
- Projects
- Inspections
- Reports and immutable report versions
- Source-system mappings and import idempotency
- Append-only audit events

Audit privileged changes with the actor, action, target, timestamp, and relevant before/after values.

## Required Verification

- Cross-organization access is denied for every client endpoint.
- Client tokens cannot access admin routes or ReportGen operator routes.
- ReportGen operator tokens cannot access portal client routes.
- Disabled or revoked users lose access.
- Archived projects, inspections, and reports disappear from client views but remain recoverable.
- Pending scans remain dominant while previous completed scans remain accessible.
- Repeated publication of the same `sourceScanId` does not create duplicate inspections.
- A replacement report updates the current version without removing earlier versions.
- Invalid, oversized, malicious, or failed-scan uploads cannot be published.
- Failed or duplicate future export events do not expose partial packages.
- Expired preview and download links can be refreshed after reauthorization.
- Development services have no access to production identities, data, or storage.

## Implementation Order

1. Establish the TypeScript workspace, shared contracts, local tooling, and development configuration.
2. Define the DynamoDB data model and authorization rules.
3. Provision the development Cognito, API, database, quarantine bucket, and published-report bucket with CDK.
4. Build invite-only authentication and role-protected client/admin application shells.
5. Implement organization, user, project, and inspection administration.
6. Implement manual upload, validation, scanning, publication, versioning, preview, and download.
7. Build the client project and scan-history experience.
8. Complete authorization, publication, failure-mode, and end-to-end validation in development.
9. Provision production and onboard the first client only after development acceptance passes.
10. Implement the ReportGen export service and automatic portal import as a later cross-repository phase.

