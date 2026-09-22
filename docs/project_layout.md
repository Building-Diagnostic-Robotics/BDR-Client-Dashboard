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
docs/              Architecture, contracts, runbooks, and handoff material
```

## Application ownership

| Area | Responsibility | Important entry points |
| --- | --- | --- |
| `apps/web` | Client pages, authenticated dashboard UI, direct artifact actions, browser security headers. | `src/app`, `src/components/portal-shell.tsx`, `src/lib/client-api.ts` |
| `apps/services` | Client BFF, Admin API, authentication, upload presigning, publication, artifact signing, and audit export. | `src/client-bff.ts`, `src/admin-api.ts`, `src/publisher.ts` |
| `apps/portal-admin` | Current BDR administration client and operator confirmations. | `bin/portal-admin.mjs`, `src/commands.ts`, `src/workflows.ts` |
| `packages/contracts` | Shared request/response and entity validation. | `src/admin.ts`, `src/publication.ts`, `src/client.ts`, `src/models.ts` |
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

`BDR_ReportGen` is a separate repository and deployment. It owns report generation and internal operator workflows. This repository owns the portal registry, portal client access, publication storage, and the current CLI administration path.

When the ReportGen team adds administration pages, it should consume the Portal Admin API described in [api-contracts.md](./api-contracts.md). It must not reach into portal DynamoDB or S3 directly. Changes that introduce ReportGen authentication into portal administration are cross-repository security work and require a separate reviewed design.
