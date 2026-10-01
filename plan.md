# BDR Inspections Dashboard Plan

## V1 status

V1 is complete and deployed. The client dashboard supports invite-only client access, tenant-isolated projects, current and historical published inspections, four report classifications, organization-level How to Read, direct Preview/Download, ZIP downloads, immutable report replacements, project/inspection archive and restore, and client logout/session handling. The current pages also let clients and portal administrators sign in and work from shared building status. See [backend](./docs/backend.md) and [frontend](./docs/frontend.md).

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

## Shared building portal

ReportGen and this dashboard now share building status on `bdr-roofus-uploads`. ReportGen links a client folder, releases a building, and sends a PDF. This dashboard's `/bff/portal/*` routes perform the second approval and show buildings, the map, and review. The registry CLI and Admin API are unchanged and still own DynamoDB projects, inspections, and immutable portal-bucket versions.

ReportGen must not write portal DynamoDB, portal buckets, or client Cognito users. The Client BFF may touch only `reportgen_portal/*` and the per-building `reportgen/client_portal/` prefixes on the data bucket.

The new client pages (`/sign-in`, `/buildings/view`, `/map`, `/review`, `/admin-tools`) ship in this repository. They appear on https://bdrdashboard.netlify.app only after that site is published from this repo.

## Deferred work

- Moving registry administration (organizations, DynamoDB projects, portal-bucket publication) into ReportGen. That work, if it happens, stays on the Admin API.
- Client notification emails, personalized PDF watermarking, and multipart uploads.
- Replacing the CLI for registry publication.

## Operations

Use the tracked [runbooks](./docs/runbooks/) for first-admin bootstrap, onboarding, login branding, authentication tests, audit operations, and break-glass recovery. Development and production remain isolated; use CloudFormation outputs from the intended stack and never copy production users or data into development.
