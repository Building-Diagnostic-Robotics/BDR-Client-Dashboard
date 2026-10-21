# BDR Inspections Dashboard Plan

## V1 Status and Current Operating Model

The V1 Registry Path is complete and deployed. It provides invite-only client access, tenant-isolated projects, current and historical published inspections, four report classifications, organization-level How to Read, direct Preview/Download, ZIP downloads, immutable report replacements, project/inspection archive and restore, and client logout/session handling. BDR staff administer V1 through the authenticated `portal-admin` CLI and the Portal Admin API.

Published client content follows these core rules:
- Client access is derived strictly from the authenticated user profile and organization session, never browser-supplied identifiers.
- Draft or archived content is never client-visible.
- A published report points to one verified immutable version; replacement updates the pointer and retains earlier versions internally.
- Uploads enter a private staging bucket and become visible only after exact source/destination verification and a committed registry transaction.
- The private published bucket is the only bucket the registry client signer can access. Presigned URLs expire after five minutes.
- How to Read is an organization-level document, not an inspection report.

## Shared Building Portal Architecture

The dashboard also provides a shared-building portal path that integrates with ReportGen on the operational data bucket (`bdr-roofus-uploads`). ReportGen links a client folder, releases a building, and uploads report PDFs. The dashboard provides the administrative approval workflow, physical-building catalog grouping, and client report delivery.

Key shared-portal architecture rules:
- **Physical Catalog Model:** Buildings and inspections are stored as physical entities in tenant DynamoDB (`portalBuilding`, `portalInspection`), with exclusive source claims (`portalSource`) preventing one scan from being attached to multiple buildings.
- **Client Report Access:** Clients receive five fixed report types per inspection (`ASSESSMENT`, `EVIDENCE`, `ROOF_TAKEOFF`, `AS_BUILT`, `CAPITAL_PLANNING`). Report requests use `POST /bff/portal/artifact-access` with opaque IDs; the Client BFF resolves approved S3 keys server-side after verifying tenant ownership, publication status, and report matching.
- **Legacy Route Isolation:** The legacy raw status and file endpoints (`GET /bff/portal/file`, `GET /bff/portal/building`, `POST /bff/portal/building`) reject non-admin client sessions with HTTP 403.
- **Client Organization Guide:** The organization How to Read document is served via session-secured endpoints (`GET /bff/portal/how-to-read/current` and `POST /bff/portal/how-to-read/current/access`) and displayed in the client landing page banner.

## Reconciled Work Status

### Implemented and Validated
- **S3 Read Error Resilience:** `readJson` and `readJsonVersion` in `apps/services/src/portal/json-state.ts` fail closed on operational S3 errors (throttling, 5xx, network drops, and malformed JSON), treating only genuine S3 404s as empty state.
- **Dashboard Conditional Writes:** Writes to `org_links.json` and building `status.json` enforce S3 ETags (`If-Match` / `If-None-Match: *`) and return HTTP 409 conflicts on concurrent changes.
- **One-Email-One-Pool Enforcement:** Cross-pool email collisions between client and administrator Cognito pools are rejected during provisioning, and sign-in resolves client accounts first.
- **Catalog Client Report Delivery:** Secure view, download, and rate-limited ZIP downloads with sanitized filenames (`Building Name - Report Type.pdf`).
- **Organization How to Read Restoration:** Landing page banner on `/projects` and session-derived download endpoints.
- **Validation Baselines:** Strict TypeScript compiler errors in `@bdr/services` resolved and Playwright browser fixtures updated.

### Planned Security Fixes (In Progress — Not Yet Complete)
1. **Client Revocation Session Invalidation:** Update `revokeClientUser` to invalidate active sessions in `SESSION_TABLE_NAME` and set `status = "REVOKED"` on matching `SUBJECT#` records in `IDENTITY_TABLE_NAME`.
2. **Canonical Administrator Provisioning & Authorization:** Synchronize `POST /bff/portal/admins` with DynamoDB `AdminProfile` creation, `ADMIN_GUARD` `ACTIVE_COUNT` incrementing, and audit logging to prevent CLI/API lockout and maintain last-administrator guards.
3. **Administrator MFA Onboarding Flow:** Handle multi-step MFA challenge transitions following temporary password replacement (`NEW_PASSWORD_REQUIRED`) in `passwordLogin` to eliminate administrator onboarding failures.

### Deliberately Deferred Work
- **ReportGen Cross-Writer Ownership Split:** Splitting shared S3 state into writer-owned files (`reportgen_status.json` owned by ReportGen and `portal_state.json` owned by the dashboard) is deferred pending coordinated ReportGen changes.
- **Shared Dev/Prod Bucket Isolation:** Both development and production CDK stacks currently share `DATA_BUCKET_NAME` (`bdr-roofus-uploads`). Parameterizing this bucket is deferred pending coordination with the ReportGen owner; until resolved, development mutations must be treated as production-impacting.
- **Client Notification Emails:** SES outbound emails remain blocked pending verified sending domain identity; notifications stay queued on `pendingAdminEmail`.
- **Administrator Review Queue N+1 Optimization:** Sequential fetching of building statuses in `/review` deferred.
- **ReportGen Internal Administration UI:** Porting admin features into ReportGen deferred; the CLI and dashboard admin tools remain the active administrative paths.
- **Remaining UI Polish:** Typography, spacing, and responsive design adjustments across dashboard cards and views.
- **S3 Pagination for High-Scale Folders:** Looping continuation tokens in `listChildren` deferred until folder counts exceed 1,000.
- **Shared Contract Migration for Review Page:** Migrating local type parsers in `/review` to `@bdr/contracts` deferred.

## Operations and Environment Boundary

Use the tracked [runbooks](./docs/runbooks/) for first-admin bootstrap, onboarding, login branding, authentication tests, audit operations, and break-glass recovery.

> [!WARNING]
> While portal Cognito pools, APIs, DynamoDB tables, portal publication buckets, KMS keys, and alarms are isolated per environment in `us-east-1`, the operational data bucket `DATA_BUCKET_NAME` (`bdr-roofus-uploads`) is currently **shared** between development and production. Operators and developers must exercise caution: mutations performed in development affect shared-building files in production.
