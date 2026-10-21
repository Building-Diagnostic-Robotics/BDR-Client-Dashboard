# Changelog

History of this repository from `git log` (newest first). Merge commits are omitted; the feature commit on each pull request is listed instead.

## Unreleased

- Add preview-first authentication reconciliation with reviewed snapshots, conditional membership/email repairs, restoration of an existing administrator mapping, and audited, resumable deletion of unfinished administrator invitations. Preserve current client access and administrator guard counts ([operator runbook](./docs/runbooks/authentication-reconciliation.md)).
- Prevent client invitations from reassigning or enabling existing accounts; use server-resolved organization ownership and a shared conditional email reservation for new administrator/client accounts. Record client ownership before emailing credentials and distinguish invitations from existing membership in the administrator UI.
- Correct authentication audits to distinguish revoked historical memberships from the current authorized owner, and report stale email reservations. Add reconciliation, invitation ownership, concurrency and audit regression coverage; checks and AWS execution remain operator-run.
- `53eaa62` Refine client building detail view UI: navigation chevron, compact heading, outline download buttons, and card-wide click-to-expand affordance ([docs/frontend.md](./docs/frontend.md)).
- `d7dd023` Add operator setup command for sample dashboard previews, isolated test folders, and audited client resets.
- `6c2ad33` Implement catalog report download service with sanitized filenames (`Building Name - Report Type.pdf`), UTF-8 Content-Disposition, and rate-limited Download all ZIP ([docs/backend.md](./docs/backend.md), [docs/frontend.md](./docs/frontend.md)).
- `656fc40` Restore operational administrator building view with embedded scan attachment and report classifications; enable building prefix resolution via `/bff/portal/building-id`.
- `1ca83f3` Introduce opaque physical building and inspection catalog identities in tenant DynamoDB with exclusive source claims; close legacy raw routes to client sessions ([docs/architecture.md](./docs/architecture.md), [docs/api-contracts.md](./docs/api-contracts.md)).
- `84c5f87` Fix shared-building address fallback from `general_data.json` and speed up project listing with lean S3 metadata reads.
- `0b46aed` Restore client `/projects` landing page with search, restored building cards, and organization How to Read guide banner ([docs/frontend.md](./docs/frontend.md), Finding 13 in [audit-findings.md](./audit-findings.md)).
- `4887efc` Unified `/sign-in` page redesign with Cognito password reset request and confirmation endpoints ([docs/api-contracts.md](./docs/api-contracts.md)).
- `1765fb7` Enforce one-email-one-pool across client and administrator pools, client-first login resolution, and preflight email checks ([audit-findings.md](./audit-findings.md)).
- `f62469b` Grant bucket-level `s3:ListBucket` to Client BFF for discovery and update production authentication test suites.
- `3517057` Harden shared S3 JSON reads to fail closed on operational errors and add optimistic ETag concurrency for dashboard writes (Findings 4 & 5 in [audit-findings.md](./audit-findings.md)).
- `6f476ae` Fix shared-building client visibility for approved reports, re-enable disabled Cognito accounts on reinvite, and report disabled accounts as revoked.

## 2026-10-02

- `cfeae66` Let administrators hide report history, invite admins, and review waiting reports.
- `502e624` Fix building and map page types so the production build type-checks.
- `17c5a77` Keep client account responses compatible with the published dashboard.
- `934dec9` Let clients sign in and read shared building portal status.

## 2026-09-22

- `561b144` Add V1 handoff documentation.
- `f6a7c33` Bug fixes for the Download All reports button.
- `0db768e` Backend bug fixes.
- `a0001fd` Add inactivity timeout, max session limit, and re-auth policies.
- `ed1caa7` Add a download-all reports button.

## 2026-09-21

- `a18365e` Minor UI changes on the projects page.
- `90ab98f` Improve the report card layout.
- `6c92720` UI improvements on the projects page.
- `f5d5608` Improve the layout of the main page.

## 2026-09-18

- `dfb53c6` UI improvements on the main page.

## 2026-09-17

- `2d62285` Test suites for login, logout, and cached cookie sessions.
- `e888c4e` Refinements to the login page.
- `1ea461c` BDR login page and custom email invite for clients.

## 2026-09-16

- `22e0078` Clarify How to Read CLI publication errors.
- `fcdd14f` Fix the How to Read report bug.
- `e06774c` Callback fixes for Netlify.

## 2026-09-15

- `8fff9a3` Fix missing KMS issues.
- `5dd2633` Fix the reports publishing bug.

## 2026-09-14

- `0b64198` Implement a minimal UI for the dashboard.
- `bf7a566` Finish AWS development setup.
- `d076dce` Checkpoint 6: AWS setup.

## 2026-09-10

- `3a01209` Initialize the client dashboard repository.
