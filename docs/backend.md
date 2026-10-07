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

**Shared building portal.** Report status and source metadata remain in the data bucket named by `DATA_BUCKET_NAME` (the stack sets this to `bdr-roofus-uploads`). `src/portal/buildings.ts` discovers those sources and manages organization links and Cognito users. `src/portal/catalog.ts` adds the client-facing physical-building model in the tenant DynamoDB table: one building can own multiple inspections, and a source can be claimed by only one building. Existing visible sources receive deterministic provisional building and inspection IDs until the first catalog mutation materializes them. Portal administrators are users whose token issuer is the Portal Admin Cognito pool and whose organization is recorded as a portal admin.

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
| `GET /bff/portal/buildings` | Client or admin | Physical-building summaries for the caller. Client ownership is session-derived. Administrator rows retain the source prefix needed to select the target organization and scan source. |
| `GET /bff/portal/building-detail` | Client or admin | One authorized physical building with ordered inspections and exactly five report rows per inspection. |
| `GET /bff/portal/building-id` | Client | Resolves an authorized legacy source-prefix bookmark to its opaque physical building ID. |
| `POST /bff/portal/building-details` | Client or admin | Update name, address, and comma-separated engineer names using the current revision. This metadata change does not stale reports. |
| `GET /bff/portal/inspection-candidates` | Admin | Discover source uploads for a linked client. Completed sections are eligible; partial or interrupted sections cannot be attached. |
| `POST /bff/portal/inspection-attach` | Admin | Atomically claim a source, attach the chosen completed sections as one inspection, update the building revision, and write an audit event. |
| `POST /bff/portal/inspection-status` | Admin | Classify unavailable report rows as In preparation or Not included with optimistic concurrency. Available artifacts remain derived from approved source state. |
| `POST /bff/portal/as-built-upload`, `POST /bff/portal/as-built-publish` | Admin | Upload a private PDF/PNG/JPEG draft, then explicitly publish the verified object to the selected inspection. |
| `POST /bff/portal/artifact-access` | Client or admin | Resolve an available artifact from opaque building, inspection, and report type values, then return a short-lived View or Download URL. Raw S3 keys are not accepted. |
| `GET /bff/portal/file` | Admin | Legacy short-lived read URL for an allowed raw key under an owned source prefix. Client report access uses opaque IDs through `/bff/portal/artifact-access`. |
| `GET`, `POST /bff/portal/building` | Admin | Legacy raw building-status and operational actions. Client sessions are rejected; client pages use the physical-building routes above. |
| `POST /bff/portal/admins` | Admin | Body `{ "email" }`. Creates the person in the admin pool when needed, adds them to `bdr-admins`, and Cognito emails a temporary password. |
| `GET /bff/portal/clients` and the `client-*` routes | Admin | Link a folder, rename a client, invite, list, revoke, resend, or replace a user. |
| `GET` and `POST /bff/portal/how-to-read` | Admin | Read or replace the organization How to Read file stored for a client prefix. |

Catalog mutations use a revision condition and write the tenant record and audit event in one DynamoDB transaction. Source claims use conditional puts so one uploaded source cannot be attached to two physical buildings. A stale revision or competing source claim returns `409`; callers must reload before retrying.

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
