# BDR Inspections Dashboard Plan

## V1 status

V1 is complete and deployed. The client dashboard supports invite-only client access, tenant-isolated projects, current and historical published inspections, four report classifications, organization-level How to Read, direct Preview/Download, ZIP downloads, immutable report replacements, project/inspection archive and restore, and client logout/session handling.

Production Playwright validation passed in Chromium and WebKit using dedicated test clients. The current client UI is deployed through Netlify; AWS infrastructure, the Client BFF, Admin API, storage, Cognito, and monitoring are deployed through the portal CDK stack.

## Current operating model

BDR staff administer V1 through the authenticated `portal-admin` CLI. The CLI signs in through Portal Admin Cognito with TOTP, holds its access token only in memory, and calls the Portal Admin API. It does not receive AWS data-plane credentials.

The Admin API is the permanent administration boundary. It owns organizations, client users and invitations, projects, inspections, report classifications, uploads, publication, retained version history, organization-level How to Read, and archive/restore actions. The CLI remains supported after an admin UI is introduced.

Published client content follows these non-negotiable rules:

- Client access is derived from the active user profile and organization, never browser-supplied identifiers.
- Draft or archived content is never client-visible.
- A published report points to one verified immutable version; replacement changes the pointer and retains the earlier version internally.
- Uploads enter a private staging bucket and become visible only after exact source/destination verification and a committed registry update.
- The private published bucket is the only bucket the client signer can access. URLs expire after five minutes.
- How to Read is one organization-level document, not an inspection report.

See [architecture.md](./docs/architecture.md), [api-contracts.md](./docs/api-contracts.md), and [project_layout.md](./docs/project_layout.md) for the handoff reference.

## Next phase: ReportGen admin UI

The next product phase is an administration UI inside the existing BDR ReportGen application. It should be a client of the unchanged Portal Admin API and cover the current CLI workflows: organization/user management, projects, inspections, uploads, report classifications, publish/replace, How to Read, and archive/restore.

Do not allow ReportGen code to write portal DynamoDB records, manage portal client Cognito users, sign client report URLs, or copy objects between portal buckets directly. The UI must preserve API idempotency keys, revision conflict handling, operator confirmation, approval attestation, and immutable publication semantics.

Portal Admin Cognito and the CLI remain the implemented and supported administration method. The ReportGen authentication and cutover design is intentionally deferred to the ReportGen owner. If ReportGen identities are later authorized for portal administration, the design must provide explicit subject-to-`adminId` mapping, preserve audit attribution, require TOTP for every ReportGen user, and never map identities by email or display name.

## Deferred work

- Controlled ReportGen export/import: a separate export bucket or prefix, manifest-last publication, and a portal import worker. The portal must never read ReportGen operational buckets.
- Client notification emails, personalized PDF watermarking, multipart/resumable uploads, and report ingestion automation.
- Any ReportGen authentication integration, identity migration, or change to the current CLI administration path.

## Operations

Use the tracked [runbooks](./docs/runbooks/) for first-admin bootstrap, onboarding, login branding, authentication tests, audit operations, and break-glass recovery. Development and production remain isolated; use CloudFormation outputs from the intended stack and never copy production users or data into development.
