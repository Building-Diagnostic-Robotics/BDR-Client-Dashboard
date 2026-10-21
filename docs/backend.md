# Backend

Commit history: [CHANGELOG.md](../CHANGELOG.md). Audit status: [audit-findings.md](../audit-findings.md). Plan: [plan.md](../plan.md).

The backend lives in `apps/services` (`@bdr/services`). It is a set of Node.js 22 Lambda handlers deployed by AWS CDK in `packages/infrastructure`. Shared request and entity schemas live in `packages/contracts`. Tenant keys, session rules, and publication state rules live in `packages/domain`.

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

## Two Data Paths

The Client BFF serves two data paths. Both require a live dashboard session. A caller’s organization comes from that session, not from an ID in the request.

**Published inspection registry.** DynamoDB holds organizations, projects, inspections, report classifications, and current version pointers. PDFs live in the private published bucket. `src/client/resources.ts` applies the client visibility rules: the organization, project, and inspection must be active, the inspection must be published, and the report must be a verified current version. Collection routes and direct report access use the same rules. Missing and invisible resources both return `404`.

**Shared building portal.** Report status and source metadata remain in the data bucket named by `DATA_BUCKET_NAME` (`bdr-roofus-uploads`). `src/portal/buildings.ts` discovers those sources and manages organization links and Cognito users. `src/portal/catalog.ts` adds the client-facing physical-building model in the tenant DynamoDB table: one building can own multiple inspections, and a source can be claimed by only one building. Existing visible sources receive deterministic provisional building and inspection IDs until the first catalog mutation materializes them. Portal administrators are users whose token issuer is the Portal Admin Cognito pool and whose organization is recorded as a portal admin.

> [!WARNING]
> The operational data bucket `DATA_BUCKET_NAME` (`bdr-roofus-uploads`) is shared across development and production stacks. Development mutations affect production shared-building files. Parameterization of `DATA_BUCKET_NAME` is deliberately deferred pending coordination with ReportGen.

## Authentication and Sessions

`src/auth/client.ts` owns dashboard sessions. `src/auth/password-login.ts` resolves sign-in requests, checking client pool accounts first with administrative pool fallback, enforcing one-email-one-pool boundaries. `src/auth/admin-oauth.ts` verifies tokens from the admin pool when an administrator signs in through Cognito Hosted UI.

Sign-in paths on the Client BFF:

| Route | Purpose |
| --- | --- |
| `POST /bff/auth/password` | Email and password. Returns session cookie or authentication challenges (`mfa`, `newPassword`). |
| `POST /bff/auth/password/reset/request` | Requests password reset code from Cognito without disclosing account existence. |
| `POST /bff/auth/password/reset/confirm` | Confirms password reset with code and new password. |
| `GET /bff/auth/start` | Hosted login entry. Resolves pool based on email address. |
| `GET /bff/auth/login`, `GET /bff/auth/callback` | Client Cognito authorization-code callback. |
| `GET /bff/auth/admin/login`, `GET /bff/auth/admin/callback` | Administrator Cognito authorization-code callback. |
| `GET /bff/auth/session` | Confirms the opaque session and refreshes the CSRF cookie. |
| `POST /bff/logout` | Revokes the session and returns the Cognito logout URL. |

The browser receives a host-only `HttpOnly` session cookie and a CSRF cookie. Mutations must send `x-bdr-csrf` and match the configured portal origin. Cognito refresh tokens stay encrypted in DynamoDB under the application KMS key.

A session lasts at most 8 hours (`SESSION_LIFETIME_MS` in `src/auth/client.ts`) with a 30-minute inactivity timeout (`CLIENT_INACTIVITY_TIMEOUT_MS` in `packages/domain/src/sessions.ts`). A successful request more than 5 minutes after the last activity extends the idle deadline without extending the 8-hour maximum.

### Completed Security Hardening

Implemented in `74d363e`; compatibility records have been reconciled in both environments and the operator reported successful production authentication checks.

1. **Client revocation:** Identity and membership denial precede paginated session cleanup and Cognito revocation, with retryable cleanup and audit records.
2. **Canonical administrators:** Portal invitations and activation use immutable administrator mappings, active `BDR_ADMIN` profiles, verified TOTP/group membership, conditional guard updates, and audit events. Existing administrator IDs are preserved.
3. **MFA onboarding:** New administrators use the trusted Cognito hosted setup route for temporary-password replacement and TOTP enrollment. Regular sign-in checks completed enrollment and canonical authorization.

## Building Portal Routes

These routes live on the Client BFF. Reads return `404` when the session’s organization does not own the building prefix. Administrator-only routes return `403` for client sessions. Mutations require valid CSRF headers.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /bff/portal/buildings` | Client or admin | Physical-building summaries for the caller. Client ownership is session-derived. |
| `GET /bff/portal/building-detail` | Client or admin | One authorized physical building with ordered inspections and five fixed report rows (`ASSESSMENT`, `EVIDENCE`, `ROOF_TAKEOFF`, `AS_BUILT`, `CAPITAL_PLANNING`). |
| `GET /bff/portal/building-id` | Client or admin | Resolves an authorized legacy source prefix to its opaque physical building ID. |
| `POST /bff/portal/building-details` | Client or admin | Update name, address, and engineer names with revision check. Does not stale reports. |
| `POST /bff/portal/artifact-access` | Client or admin | Resolve an available artifact from opaque building, inspection, and report type; returns 5-minute View or Download URL with sanitized filename. Raw S3 keys are rejected. |
| `GET /bff/portal/how-to-read/current` | Client or admin | Fetch organization How to Read document metadata for the session's organization. |
| `POST /bff/portal/how-to-read/current/access` | Client or admin | Generate a 5-minute presigned View or Download URL for the organization How to Read PDF. |
| `GET /bff/portal/inspection-candidates` | Admin | Discover source uploads for a linked client. Completed sections are eligible. |
| `POST /bff/portal/inspection-attach` | Admin | Claim a source and attach chosen completed sections as one inspection with revision check and audit record. |
| `POST /bff/portal/inspection-status` | Admin | Classify unavailable report rows as In preparation or Not included with optimistic concurrency. |
| `POST /bff/portal/as-built-upload`, `POST /bff/portal/as-built-publish` | Admin | Upload a private PDF/PNG/JPEG draft, then explicitly publish the verified object to an inspection. |
| `GET /bff/portal/file` | Admin only | Legacy short-lived read URL for an allowed raw key. Client sessions return `403`. |
| `GET`, `POST /bff/portal/building` | Admin only | Legacy raw building-status and operational actions. Client sessions return `403`. |
| `POST /bff/portal/admins` | Admin only | Creates user in admin pool and adds them to `bdr-admins`. |
| `GET /bff/portal/clients` and `client-*` | Admin only | Link a folder, rename client, invite, list, revoke, resend, or replace users. |
| `GET`, `POST /bff/portal/how-to-read` | Admin only | Read or replace the organization How to Read file stored for a client prefix. |

## Concurrency and Writer State

- **S3 Read Resilience:** `readJson` and `readJsonVersion` in `src/portal/json-state.ts` fail closed on all non-404 S3 errors (throttling, 5xx, network drops, malformed JSON), preventing accidental state erasure.
- **Conditional Writes:** Dashboard writes to `org_links.json` and `status.json` enforce S3 ETags (`If-Match` / `If-None-Match: *`) and return HTTP 409 conflicts.
- **Cross-Writer Split Deferred:** Splitting shared S3 state into writer-owned `reportgen_status.json` (ReportGen) and `portal_state.json` (Dashboard) remains deliberately deferred.

Outbound portal email is not sent. `src/portal/email.ts` records the SES identity blocker, and notices stay on `pendingAdminEmail` in the building status until a sending domain is verified.

## Local Checks

From the repository root:

```bash
npm run typecheck --workspace @bdr/services
npm run test --workspace @bdr/services
```

Handler tests sit next to the modules (`client-bff.test.ts`, `admin-api.test.ts`, `publisher.test.ts`, `src/portal/catalog.test.ts`, `src/portal/buildings.test.ts`, and suites under `src/auth`). Contract changes belong in `packages/contracts` and should be updated in the same change as the handler.

### Administrator read performance

The administrator Clients page uses `src/portal/admin-reads.ts`: directory reads load organization links and verify active tenant records without building discovery. Counts and selected-client buildings use the same per-organization physical catalog rules. These reads are separate from the existing `/bff/portal/clients` Organization tools endpoint, whose wire format is unchanged.

Review reads lean current `status.json` objects for all stored/discovered inspections under linked active organizations, deduplicates sources, checks source claims, and returns explicit completeness/failure information. It does not load full building details, image metadata, report history, or presigned URLs. Eligible rows remain awaiting approval, non-stale, and not client-visible. Failures are never treated as an empty queue.

Administrator workers and shared IO are capped at four per request. S3 prefix discovery follows continuation tokens; stored catalog queries follow DynamoDB continuation keys. `portal_admin_read` logs operation, request ID, outcome (`success`, `partial`, `error`), duration, S3 GET/LIST counts, DynamoDB reads, and failed reads. There is no persistent cache or new infrastructure. See [rollout and validation](runbooks/admin-performance.md).

