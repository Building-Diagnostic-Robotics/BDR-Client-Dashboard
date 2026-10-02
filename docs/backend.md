# Backend

Commit history: [CHANGELOG.md](../CHANGELOG.md).

The backend lives in `apps/services` (`@bdr/services`). It is a set of Node.js 22 Lambda handlers. AWS CDK in `packages/infrastructure` deploys them. Shared request and entity schemas live in `packages/contracts`. Tenant keys, session rules, and publication state rules live in `packages/domain`.

The dashboard never talks to DynamoDB or S3 directly. Browser calls go to the Client BFF. Operators using the CLI call the Portal Admin API.

## Handlers

| Lambda | Entry | Role |
| --- | --- | --- |
| Client BFF | `src/client-bff.ts` | Browser authentication, session checks, published-registry reads, and the shared building portal. |
| Portal Admin API | `src/admin-api.ts` | Organizations, users, projects, inspections, uploads, publication, and archive/restore for the CLI. |
| Upload presigner | `src/upload-presigner.ts` | One immutable upload target in the private upload bucket. |
| Publisher | `src/publisher.ts` | Copy a verified upload into an immutable published object, then return that version for the registry commit. |
| Artifact signer | `src/artifact-signer.ts` | Five-minute read URL after the BFF has already authorized the caller. |
| Audit exporter | `src/audit-exporter.ts` | Monthly export of audit records into the locked archive bucket. |

Each file exports `handler`. CDK names the functions `{stack-prefix}-{service-name}` and bundles them for `nodejs22` on ARM64.

## Two data paths

The Client BFF serves two stores. Both require a live dashboard session. A caller’s organization comes from that session, not from an ID in the request.

**Published inspection registry.** DynamoDB holds organizations, projects, inspections, report classifications, and current version pointers. PDFs live in the private published bucket. `src/client/resources.ts` applies the client visibility rules: the organization, project, and inspection must be active, the inspection must be published, and the report must be a verified current version. Collection routes and direct report access use the same rules. Missing and invisible resources both return `404`.

**Shared building portal.** Building status is JSON in the data bucket named by `DATA_BUCKET_NAME` (the stack sets this to `bdr-roofus-uploads`). `src/portal/buildings.ts` reads and writes that status, links client folders to organizations in `reportgen_portal/org_links.json`, and manages Cognito users for those clients. The current dashboard pages use this path. Portal administrators are users whose token issuer is the Portal Admin Cognito pool and whose organization is recorded as a portal admin.

Registry publication through the CLI is unchanged. The building portal does not write the published-report registry.

## Authentication

`src/auth/client.ts` owns dashboard sessions. `src/auth/password-login.ts` checks an email and password against the admin pool first, then the client pool. `src/auth/admin-oauth.ts` verifies tokens from the admin pool when an administrator signs in through the dashboard.

Sign-in paths on the Client BFF:

| Route | Purpose |
| --- | --- |
| `POST /bff/auth/password` | Email and password. May return an MFA or new-password challenge before setting the session cookie. |
| `GET /bff/auth/start` | Hosted login. Chooses the admin or client pool from the email address. |
| `GET /bff/auth/login`, `GET /bff/auth/callback` | Client Cognito authorization-code callback. |
| `GET /bff/auth/admin/login`, `GET /bff/auth/admin/callback` | Administrator Cognito authorization-code callback. |
| `GET /bff/auth/session` | Confirms the opaque session and refreshes the CSRF cookie. |
| `POST /bff/logout` | Revokes the session and returns the Cognito logout URL. |

The browser receives a host-only `HttpOnly` session cookie and a CSRF cookie. Mutations must send `x-bdr-csrf` and come from the configured portal origin. Cognito refresh tokens stay encrypted in DynamoDB under the application KMS key.

A session lasts at most 8 hours (`SESSION_LIFETIME_MS` in `src/auth/client.ts`). It also ends after 30 minutes without activity (`CLIENT_INACTIVITY_TIMEOUT_MS` in `packages/domain/src/sessions.ts`). A successful request more than 5 minutes after the last activity extends the idle deadline and does not extend the 8-hour limit.

The Portal Admin API is separate. `src/auth/admin.ts` requires a Cognito access token, the `bdr-admins` group, an explicit issuer/sub mapping to `adminId`, an active admin profile, an active admin session, and confirmed software-token MFA. The CLI calls `POST /admin/auth/sessions` before other admin routes. See [API contracts](./api-contracts.md) for those routes, idempotency keys, and revision conflicts.

## Building portal routes

These routes live on the Client BFF. Reads return `404` when the session’s organization does not own the building prefix. Administrator routes return `403` for a client session. Mutations use the same CSRF check as other BFF writes.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /bff/portal/buildings` | Client or admin | Buildings visible to the caller. Each item includes `awaitingReports`, the report types still waiting for administrator approval. |
| `GET /bff/portal/building` | Client or admin | One building’s status. Buildings marked `no_report` or `test_scan` are not shown to clients as approved reports. When history is hidden for the building, clients still receive the history list as empty. Clients do not receive `historyHidden`, `historyHideReason`, or `hiddenHistoryKeys`. Administrators receive those fields and every history row, with `hiddenFromClients` on a version that clients cannot see. |
| `GET /bff/portal/file` | Client or admin | Short-lived read URL for an allowed key under a building the caller owns. Clients cannot open a history-only file while history is hidden, or a single version hidden from clients. The current approved file stays openable. |
| `POST /bff/portal/building` | Client or admin | Building actions. Approval, history hide/restore, stale, and building marks require an administrator. Clients may edit identity and capital-plan inputs on a visible report, which marks that report stale. |
| `POST /bff/portal/admins` | Admin | Body `{ "email" }`. Creates the person in the admin pool when needed, adds them to `bdr-admins`, and Cognito emails a temporary password. |
| `GET /bff/portal/clients` and the `client-*` routes | Admin | Link a folder, rename a client, invite, list, revoke, resend, or replace a user. |
| `GET` and `POST /bff/portal/how-to-read` | Admin | Read or replace the organization How to Read file stored for a client prefix. |

`POST /bff/portal/building` accepts an `action` field. Administrator actions include `approve`, `notes`, `hide-history`, `restore-history`, `hide-history-item`, `restore-history-item`, `building-mark`, `mark-stale`, `undo-stale`, and `reject-asbuilt`. `hide-history` requires `reason`. `hide-history-item` and `restore-history-item` require `key`, the stored PDF key. Hiding keeps the file in storage. Shared actions include `section-mark`, `capital-plan`, `identity`, `asbuilt-upload`, `takeoff-building`, and `edit-visible`. Unknown actions return `400`. `notes` records `pendingAdminEmail` and does not publish or hide a file. `markStale` on that action also marks the current report stale and removes it from the client’s current file.

Outbound portal email is not sent. `src/portal/email.ts` records the SES identity blocker, and notices stay on `pendingAdminEmail` in the building status until a sending domain is verified.

## Registry client routes

These still authorize against the published inspection registry:

- `GET /bff/me`, `GET /bff/me/projects`, `GET /bff/projects/{projectId}`
- Inspection and report lists under that project
- `POST .../reports/{reportType}/access` and the How to Read document access route

`/bff/me` includes `admin: true` when the session issuer is the Portal Admin pool. The building list page uses `/bff/portal/buildings`. The project detail page at `/projects/{projectId}` still uses the registry routes.

## Local checks

From the repository root:

```bash
npm run typecheck --workspace @bdr/services
npm run test --workspace @bdr/services
```

Handler tests sit next to the modules (`client-bff.test.ts`, `admin-api.test.ts`, `publisher.test.ts`, and the suites under `src/auth` and `src/admin`). Contract changes belong in `packages/contracts` and should be updated in the same change as the handler.
