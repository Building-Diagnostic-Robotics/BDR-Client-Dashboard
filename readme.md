# BDR Client Dashboard

BDR Client Dashboard is a secure web portal for Building Diagnostic Robotics clients. Customers will use it to view their buildings, review current and historical scans, and preview or download published inspection reports.

The first release keeps the dashboard client-only. BDR staff will manage client organizations, users, projects, inspections, and report publication through a protected local CLI backed by the Portal Admin API. Administration pages inside the internal BDR ReportGen platform are planned for a later phase.

The initial release will use administrator-uploaded PDFs stored in private portal-owned AWS storage. A later ReportGen integration will support controlled, automatic publication without exposing ReportGen's operational S3 bucket to the dashboard.

See [plan.md](./plan.md) for the current architecture and implementation plan.

The sole-administrator TOTP recovery procedure is documented in [docs/runbooks/admin-break-glass.md](./docs/runbooks/admin-break-glass.md). It must be tested in development before production onboarding.

Before the CLI can be used in a new environment, follow the one-time [first-administrator bootstrap runbook](./docs/runbooks/bootstrap-first-admin.md). The API intentionally has no unauthenticated bootstrap route.

Monthly locked audit exports, CloudTrail coverage, and alarm response are documented in [docs/runbooks/audit-operations.md](./docs/runbooks/audit-operations.md). After deploying an environment, subscribe a monitored destination to the `OperationalAlarmTopicArn` stack output.

## Development

The repository is an npm workspace with the Next.js client in `apps/web`, Lambda entry points in `apps/services`, the local operator CLI in `apps/portal-admin`, shared runtime-validated contracts in `packages/contracts`, tenant authorization and persistence rules in `packages/domain`, and reusable AWS CDK infrastructure in `packages/infrastructure`.

```bash
npm install
npm run dev
```

Run `npm run check` before submitting changes. It type-checks the workspaces, runs the contract tests, and creates a production build.

Synthesize the development AWS stack without deploying it:

```bash
npm run synth -- --quiet
```

Before an AWS deployment, provide globally unique Cognito domain prefixes and the real environment URLs as CDK context. Development and production must use separate values and separate stacks.

## Portal administration CLI

The CLI authenticates through the environment's administrator Cognito Managed Login using authorization code with PKCE. It keeps tokens in memory and calls only the Portal Admin API. Configure it from the matching CDK stack outputs:

```bash
export PORTAL_ADMIN_API_URL="https://example.execute-api.us-east-1.amazonaws.com"
export PORTAL_ADMIN_AUTH_DOMAIN="https://example.auth.us-east-1.amazoncognito.com"
export PORTAL_ADMIN_CLIENT_ID="..."
export PORTAL_ADMIN_CALLBACK_URL="http://127.0.0.1:8765/callback"
```

Example administration operations:

```bash
npm run cli --workspace @bdr/portal-admin -- organizations create --name "Example Client"
npm run cli --workspace @bdr/portal-admin -- projects create --organization org_x --name "Main Building" --address "1 Main St" --timezone America/New_York
npm run cli --workspace @bdr/portal-admin -- inspections create --organization org_x --project project_x --scanned-at 2026-09-13T10:00:00-04:00
npm run cli --workspace @bdr/portal-admin -- uploads put --organization org_x --project project_x --inspection inspection_x --type ASSESSMENT --file ./assessment.pdf
npm run cli --workspace @bdr/portal-admin -- inspections publish --organization org_x --project project_x --inspection inspection_x --classifications ./classifications.json
npm run cli --workspace @bdr/portal-admin -- reports publish --organization org_x --project project_x --inspection inspection_x --type ASSESSMENT --upload-session upload_x
npm run cli --workspace @bdr/portal-admin -- uploads put --organization org_x --document how-to-read --file ./how-to-read.pdf
npm run cli --workspace @bdr/portal-admin -- how-to-read publish --organization org_x --upload-session upload_x
```

Create operations send idempotency keys. Archive, restore, revocation, cancellation, and identity replacement require the current revision and an exact resource-ID confirmation. Upload commands print their idempotency key; keep the returned upload session ID for the classifications file or a later replacement command.

The inspection classifications file is a JSON array with exactly one entry for each of `ASSESSMENT`, `EVIDENCE`, `ROOF_TAKEOFF`, and `CAPITAL_PLANNING`. Use `PUBLISHED` with a ready `uploadSessionId`, or use `EXPECTED`, `NOT_INCLUDED`, or `NOT_APPLICABLE` with `uploadSessionId: null`.
