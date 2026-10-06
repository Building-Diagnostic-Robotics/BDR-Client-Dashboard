# Changelog

History of this repository from `git log` (newest first). Merge commits are omitted; the feature commit on each pull request is listed instead.

## Unreleased

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
