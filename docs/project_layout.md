# Project Layout

This repository is an npm workspace. The client dashboard, administration CLI, backend services, contracts, and AWS infrastructure are intentionally kept together so every visible workflow can share the same domain and API rules.

```text
apps/
  web/             Next.js client dashboard deployed through Netlify
  services/        Lambda handlers and portal service implementations
  portal-admin/    Local authenticated administration CLI
packages/
  contracts/       Zod schemas and API/domain types
  domain/          Keys, transitions, sessions, transactions, visibility policy
  infrastructure/  AWS CDK stack and Cognito login branding command
e2e/               Local fixtures and live Playwright authentication tests
docs/              Architecture, backend, frontend, contracts, runbooks, and handoff material
```

## Application ownership

| Area | Responsibility | Important entry points |
| --- | --- | --- |
| `apps/web` | Client pages, authenticated dashboard UI, direct artifact actions, browser security headers. | `src/app`, `src/components/portal-shell.tsx`, `src/lib/client-api.ts`. See [frontend](./frontend.md). |
| `apps/services` | Client BFF, Admin API, authentication, building portal status, physical-building inspection catalog, upload presigning, publication, artifact signing, and audit export. | `src/client-bff.ts`, `src/admin-api.ts`, `src/portal/buildings.ts`, `src/portal/catalog.ts`, `src/publisher.ts`. See [backend](./backend.md). |
| `apps/portal-admin` | Current BDR administration client and operator confirmations. | `bin/portal-admin.mjs`, `src/commands.ts`, `src/workflows.ts` |
| `packages/contracts` | Shared request/response and entity validation. | `src/admin.ts`, `src/publication.ts`, `src/client.ts`, `src/portal.ts`, `src/models.ts` |
| `packages/domain` | Tenant keys, publication/lifecycle state rules, session checks, and client visibility predicate. | `src/keys.ts`, `src/transitions.ts`, `src/visibility.ts` |
| `packages/infrastructure` | Environment-specific CDK resources, IAM, CloudWatch, CloudTrail, and Cognito branding. | `bin/app.ts`, `src/portal-stack.ts` |

## Data and deployment ownership

The CDK stack owns portal Cognito pools, Lambda functions, APIs, DynamoDB tables, KMS keys, portal S3 buckets, audit export scheduling, CloudTrail selectors, and alarms. Netlify owns only the client frontend and proxy configuration for the Client BFF. The dashboard frontend uses relative `/bff/*` paths and must not contain AWS credentials, Cognito client secrets, or direct portal data-store access.

The deployed stack exposes the values needed by operators through CloudFormation outputs, including the Client BFF URL, Admin API URL, Cognito user-pool IDs, Admin CLI client ID, admin login domain, alarm topic ARN, and audit archive bucket name. Retrieve those values from the matching environment stack rather than copying environment-specific values into source files.

## Tests and checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check all workspaces. |
| `npm run test` | Run workspace unit and contract tests. |
| `npm run build` | Build all workspaces. |
| `npm run test:e2e` | Run local fixture-based Chromium/WebKit browser checks. |
| `npm run test:e2e:production` | Run live production checks using the Git-ignored `.env.e2e.local`. |
| `npm run synth -- --quiet` | Synthesize the development CDK stack without deployment. |

Live credentials, Playwright artifacts, local environment files, and generated deployment output are intentionally Git-ignored.

## ReportGen boundary

`BDR_ReportGen` is a separate repository and deployment. It owns report generation, the operator UI, and the first approval on the shared building path.

This repository owns client sign-in, the Client BFF, the registry (DynamoDB, portal buckets, CLI, Admin API), and the second approval that makes a shared-path PDF visible.

Shared objects, all on `bdr-roofus-uploads`:

| Object | Writer | Reader |
| --- | --- | --- |
| `reportgen_portal/org_links.json` | ReportGen link, and Client BFF client-folder tools | Both |
| `reportgen_portal/as-built/{organization}/{building}/{inspection}/drafts/{upload}/*` | Dashboard administrator | Client BFF only after the immutable upload is referenced by a published catalog revision |
| `{building}reportgen/client_portal/status.json` | Both | Both |
| `{building}reportgen/client_portal/approved/{TYPE}/*.pdf` | ReportGen on send | Client BFF when a client or admin opens the file |

ReportGen must not write portal DynamoDB, portal buckets, or client Cognito users. Registry publication stays on the Admin API. The Client BFF may read and update only the shared prefixes above.
