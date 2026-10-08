# Changelog

History of this repository from `git log` (newest first). Merge commits are omitted; the feature commit on each pull request is listed instead.

## Unreleased

- Refine the client building detail view UI: replace the text back arrow with a matching chevron icon labeled "Buildings", scale down the building heading size, remove the scan-specific engineers display and form input, omit redundant "Available" badges from published reports in favor of clean timestamp labels, style report download buttons with a branded green outline instead of solid fills, and enable card-wide click-to-expand with hover underline affordance on available report counts.

- Add an operator-run sample dashboard setup command with a read-only preview, isolated sample source folders, three physical buildings and eight inspections, five sample report types, conditional setup checkpoints, and audited client-account resets with fresh Cognito invitations. Preserve the deployed invitation email template. The command is not executed by implementation and requires explicit apply/reset flags.
- Scope catalog download browser assertions to application alerts, require the exact ZIP failure message for duplicate filenames, and serve View/Download fixtures over a temporary local HTTP server with attachment filename and downloaded-content checks for Chromium and WebKit.
- Improve client report access by resolving fresh publication state without operational section, history, or image enrichment; provisional artifact access discovers only organization-linked prefixes and rejects already claimed sources. Preserve source-based report classification for opaque approved filenames and validate artifact ownership before signing.
- Suggest sanitized `Building Name - Report Type.pdf` download filenames, use the same names in catalog responses and ZIP entries, retain PNG/JPEG extensions for As-built images, and sign UTF-8 Content-Disposition headers while keeping five-minute private URLs.
- Fetch at most two available reports concurrently for client Download all, show completion progress, cancel remaining fetches on failure, and reject duplicate ZIP filenames instead of silently overwriting reports. Record sanitized failure stages and artifact resolution duration without signed URLs.
- Show an opening message in report preview tabs and switch Data uploaded from relative ages to an inspection-local calendar date at 48 hours, using UTC when no timezone is available.
- Add catalog-specific service, BFF, filename/signing, formatting, and local browser regression coverage. Document the separate, operator-applied shared-report-bucket CORS fix: preserve ReportGen rules and add only dashboard GET/HEAD access. Implementation does not apply AWS changes or run validation suites.

- Restore the full operational administrator building page with report approval, stale toggling, PDF viewing, history visibility controls, scan section marks, building details, capital planning, visit status, and moisture map navigation, while embedding the new physical scan attachment and client report classifications card directly into the admin view.
- Enable administrator building prefix resolution via `GET /bff/portal/building-id` and link administrator project cards with prefix, building identity, and client context, preserving the dedicated client catalog experience for customer sessions.
- Harden the live authentication E2E test suite by eliminating navigation interruption races during history restoration across Chromium and WebKit, and add support for single-account live verification with graceful skips when secondary accounts or tenant buildings are absent.
- Fix TypeScript strict-mode compiler errors in `@bdr/services` by properly importing `DynamoDBDocumentClient` and explicitly typing unprocessed DynamoDB batch keys.
- Restore secure per-report View, Download, and Download all actions while resolving every S3 object server-side; add editable building identity metadata, explicit administrator scan attachment across every prefix linked to the organization, report classification, and private-draft-then-publish As-built workflows.
- Introduce opaque physical building and inspection identities with conditional DynamoDB writes, exclusive source claims, and atomic audit records; derive provisional identities for existing data, reject partial scan sections, preserve legacy client bookmarks through an authorized redirect, and close the retired raw status/action routes to client sessions.
- Normalize legacy timezone-less scan timestamps at the backend boundary so physical-building responses satisfy the shared absolute-time contract and render consistently across client time zones.
- Replace the building-page empty-state flash with an explicit loading skeleton and keep operational legacy history, map, capital-plan inputs, scan marks, and upload controls out of the client experience.
- Fix shared-building address fallback so `general_data.json` supplies a missing address even when `status.json` already has a display name; retain `No address yet` when neither source contains a verified value.
- Speed up the projects landing page by using a lean S3 summary read instead of full building-detail enrichment, loading the How to Read guide independently, and recording non-sensitive S3 operation and duration metrics.
- Rename the client navigation item from Buildings to Projects and underline only the navigation item selected for the current route.
- Restore the client landing page on `/projects`: branch client view from administrator view using the authenticated `admin` flag. Clients receive "Your projects", an organization description, a single building/address search bar, a 2-column grid, restored building cards linking to `/buildings/view?prefix=...`, and the shared How to Read guide banner beneath the grid.
- Formalize design tokens in `apps/web/src/app/tokens.css` (spacing scale, typography scale, border radii, borders, and semantic colors) and import at the top of `globals.css`.
- Standardize page templates and reusable UI primitives in `apps/web/src/components/` (`PageHeader`, `SectionHeader`, `SearchBar`, `EmptyState`, `ContentState`, `BuildingCard`, `HowToReadBanner`, `CountBadge`) to prevent unbounded growth of `globals.css`.
- Extend shared-building summaries with `latestReportUpdate` derived from the newest timestamp among client-visible reports, displaying relative formats under 24 hours, short dates after 24 hours, "Available" for un-timestamped reports, and "No reports yet" for none.
- Add session-secured How to Read PDF endpoints in Client BFF (`GET /bff/portal/how-to-read/current` and `POST /bff/portal/how-to-read/current/access`), ensuring organization resolution is strictly server-derived and never accepting client prefixes or S3 keys from the browser.
- Update live authentication test expectations for "Your projects", and add Playwright UI and backend vitest test suites covering landing page search, fallbacks, guide access, and administrator preservation.

- Restore and redesign the unified `/sign-in` page with a clean, responsive 30rem split card (white logo header with cropped BDR logo and light-gray form section), streamlined "Sign In" header, rounded inputs, green focus indicators, and green gradient submit buttons.
- Implement explicit screens for credentials, temporary-password replacement, authenticator code (MFA), forgot-password request, and code confirmation with live accessible password requirement validation (text and icons).
- Add Cognito password recovery endpoints `POST /bff/auth/password/reset/request` and `POST /bff/auth/password/reset/confirm` in Client BFF with client secret hashing, account resolution, mapped public errors, and uniform non-disclosure responses.
- Add shared Zod contracts in `@bdr/contracts` and unit and Playwright UI tests for password reset and authentication transitions.
- Enforce one-email-one-Cognito-pool across client and administrator provisioning, resolve dashboard sign-ins client-first with administrator fallback, preflight client email replacements before revocation, and add a read-only cross-pool overlap audit.

- Harden shared S3 JSON state reads so only missing objects produce empty initial state; malformed data, missing ETags, permission errors, throttling, network failures, and S3 server errors now fail closed instead of risking destructive overwrites.
- Add optimistic concurrency control for dashboard writes to `org_links.json` and building `status.json` using S3 ETags, return HTTP 409 for stale writes, and reload current data before an administrator retries a conflicting change.
- Tighten password-session token handling, align strict TypeScript contracts, update restored-session browser fixtures for the shared-building API, and preserve dashboard logo proportions.
- Fix production client and building discovery by granting the Client BFF bucket-level `s3:ListBucket` permission. This permits root discovery and lets missing optional S3 objects return `404` for the existing not-found handling, while object reads remain restricted to approved key patterns.
- Update production authentication tests for the custom dashboard sign-in page and shared-building endpoints instead of the retired direct Cognito redirect and registry-project flow.
- Make production logout and tenant-isolation tests deterministic across Chromium and WebKit by avoiding a reload/redirect race and allowing the secondary test organization to be empty while still denying access to the primary organization's building.
- Fix shared-building visibility so an approved report makes its building available to the client, including existing records where `clientVisible` was set before the building release flag.
- Re-enable an existing disabled Cognito client when an administrator explicitly invites that email again, and report disabled accounts as revoked instead of signed in.

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
