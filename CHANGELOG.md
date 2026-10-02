# Changelog

History of this repository from `git log` (newest first). Merge commits are omitted; the feature commit on each pull request is listed instead.

## Unreleased

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
