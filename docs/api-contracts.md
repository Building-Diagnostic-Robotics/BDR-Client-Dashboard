# API Contracts

Commit history: [CHANGELOG.md](../CHANGELOG.md). Audit status: [audit-findings.md](../audit-findings.md). Plan: [plan.md](../plan.md).

## Canonical Sources

The canonical runtime schemas are in `packages/contracts/src/`:

- `admin.ts`: Administration requests, revisions, pagination, and archive actions for the Admin API.
- `publication.ts`: Upload targets, upload sessions, report classifications, and publication requests.
- `client.ts`: Client BFF responses, session account payloads, and artifact access requests.
- `models.ts`: Core domain entities, opaque ID schemas, and allowed states.
- `portal.ts`: Shared-portal physical building summaries and details, five report types (`ASSESSMENT`, `EVIDENCE`, `ROOF_TAKEOFF`, `AS_BUILT`, `CAPITAL_PLANNING`), three delivery states (`AVAILABLE`, `IN_PREPARATION`, `NOT_INCLUDED`), inspection candidates, scan attachment, classification updates, building metadata updates, and As-built upload/publication payloads.
- `auth.ts`: Authentication challenge contracts and password reset request/confirm schemas.

## Client BFF

The dashboard uses relative same-origin `/bff/*` routes proxied by Netlify. Browser JavaScript never receives Cognito tokens.

### Authentication & Account Routes

| Route | Purpose |
| --- | --- |
| `GET /bff/auth/session`, `GET /bff/me` | Validates opaque session; returns user identity and organization name. `admin: true` is present only for Portal Admin pool sessions. |
| `POST /bff/auth/password` | Email and password sign-in. May return `newPassword` or `mfa` challenge sessions before issuing a session cookie. (Multi-step MFA challenge transitions are under planned remediation). |
| `POST /bff/auth/password/reset/request` | Requests a password reset verification code from Cognito with uniform non-disclosure responses. |
| `POST /bff/auth/password/reset/confirm` | Submits the reset verification code and sets a new account password. |
| `POST /bff/logout` | Revokes the active session in DynamoDB and returns the Cognito logout redirect URL. |

### Shared Building Catalog Routes (Client & Admin)

| Route | Method | Payload / Params | Return Value | Notes |
| --- | --- | --- | --- | --- |
| `/bff/portal/buildings` | GET | None | `portalBuildingListResponseSchema` | Organization-scoped building summaries. |
| `/bff/portal/building-detail` | GET | `?buildingId={id}` | `portalBuildingDetailSchema` | Full physical building detail with 5 report rows per inspection. |
| `/bff/portal/building-id` | GET | `?prefix={prefix}` | `portalBuildingIdResponseSchema` | Resolves legacy source prefix bookmark to opaque building ID. |
| `/bff/portal/artifact-access` | POST | `{ buildingId, inspectionId, reportType, disposition }` | `{ url, filename }` | 5-minute View/Download URL with sanitized filename. Raw S3 keys rejected. |
| `/bff/portal/how-to-read/current` | GET | None | `{ updatedAt }` | Metadata for the organization's published How to Read guide. |
| `/bff/portal/how-to-read/current/access` | POST | `{ disposition }` | `{ url }` | 5-minute View/Download URL for the organization How to Read PDF. |
| `/bff/portal/building-details` | POST | `{ displayName, address, engineerNames, expectedRevision }` | `portalBuildingDetailSchema` | Updates physical building metadata using optimistic revisions. |

### Administrator-Only Routes

Non-admin client sessions invoking these endpoints are rejected with HTTP 403 `forbidden`:

| Route | Method | Purpose |
| --- | --- | --- |
| `/bff/portal/file` | GET | Legacy short-lived URL for raw S3 keys under an owned prefix. (Admin only). |
| `/bff/portal/building` | GET, POST | Legacy raw status and operational actions (`approve`, `stale`, `hide-history-item`). (Admin only). |
| `/bff/portal/inspection-candidates` | GET | Discovers available source uploads for scan attachment. |
| `/bff/portal/inspection-attach` | POST | Claims an upload source and attaches completed sections to a building. |
| `/bff/portal/inspection-status` | POST | Classifies unavailable reports as `IN_PREPARATION` or `NOT_INCLUDED`. |
| `/bff/portal/as-built-upload` | POST | Initiates private upload target for As-built draft. |
| `/bff/portal/as-built-publish` | POST | Publishes verified As-built draft to an inspection. |
| `/bff/portal/clients` | GET, POST | Lists linked clients/unlinked folders, or links a new client folder. |
| `/bff/portal/admins` | POST | Creates administrator in Cognito `bdr-admins`. (Domain synchronization in progress). |
| `/bff/portal/client-rename` | POST | Updates display name for a client folder. |
| `/bff/portal/client-account` | POST | Invites client user and creates Cognito/DynamoDB identity records. |
| `/bff/portal/client-revoke` | POST | Disables client user. (Session invalidation in progress). |
| `/bff/portal/client-resend` | POST | Resends invitation code to client user. |
| `/bff/portal/client-replace` | POST | Replaces client user with a new email address. |

### Registry Client Routes

Registry routes authorize strictly against the published inspection registry:
- `GET /bff/me/projects`
- `GET /bff/projects/{projectId}`
- `GET /bff/projects/{projectId}/inspections`
- `GET /bff/projects/{projectId}/inspections/{inspectionId}/reports`
- `POST .../reports/{reportType}/access`
- `GET /bff/me/documents/how-to-read`, `POST .../access`

## Portal Admin API

The Portal Admin API (`/admin/*`) is consumed by the `portal-admin` CLI. Callers authenticate via Cognito Bearer tokens and must have the `bdr-admins` group, active `AdminProfile`, and verified TOTP enrollment.

| Route Group | Operations |
| --- | --- |
| `/admin/organizations` | List, create, get, and update organizations. |
| `/admin/organizations/{organizationId}/users` | List users, revoke a user, or invite a replacement identity. |
| `/admin/organizations/{organizationId}/invitations` | List, create, resend, and cancel invitations. |
| `/admin/organizations/{organizationId}/projects` | List, create, get, update, archive-preview, archive, restore-preview, and restore projects. |
| `/admin/organizations/{organizationId}/projects/{projectId}/inspections` | List, create, get, update, archive-preview, archive, restore-preview, restore, and publish inspections. |
| `.../inspections/{inspectionId}/reports` | List or update classifications; publish, replace, withdraw, and list retained versions. |
| `/admin/organizations/{organizationId}/documents/how-to-read` | Initialize, inspect, publish, replace, and list retained How to Read versions. |
| `/admin/organizations/{organizationId}/upload-sessions` | Create, inspect, complete, or recover an immutable upload session. |

## Mutation Rules

- Creation endpoints require an `Idempotency-Key` header.
- State mutation endpoints require `expectedRevision`. Conflicts return HTTP 409; callers must reload current data before retrying.
- Client-visible report versions are immutable. Replacement creates a new version; published objects are never overwritten.
- S3 conditional writes on shared JSON files use `If-Match: <etag>` and `If-None-Match: *`.

## Administrator directory and review reads

All routes below require an authenticated canonical portal administrator; client sessions receive `403`. The server resolves active organizations and linked prefixes independently of browser input. Existing client and Organization tools routes retain their response shapes.

| Route | Response |
| --- | --- |
| `GET /bff/portal/admin/clients` | `{ items }`: one entry per active linked organization with `organizationId`, `displayName`, and `clientPrefixes`. No building discovery or counts. |
| `GET /bff/portal/admin/clients/:organizationId/buildings` | `{ items, admin: true }`: existing administrator building summaries for that organization only. |
| `GET /bff/portal/admin/clients/:organizationId/building-count` | `{ count }`: the same catalog’s physical-building count, including grouped inspections and source claims. |
| `GET /bff/portal/admin/review` | `{ items, complete, failures }`: pending reports across all linked inspections; failures identify `organizationId`, `clientName`, and nullable source `prefix`. |

Review rows include `organizationId`, `clientName`, `prefix`, building `name`, canonical `reportType`, original `reportKey`, nullable `artifactKey`, and nullable `generatedAt`. `CAPITAL_PLAN` remains the mutation key when present in source state, while its display type is `CAPITAL_PLANNING`. The shared schema requires those two representations to agree. View signs the selected artifact on demand through the existing administrator file endpoint. Approve/notes use the existing CSRF-protected mutation endpoint and original report key.

A complete review response must have no failures. Incomplete responses retain safely loaded rows and require explicit warning/retry; an initial directory/configuration error fails the request. Unknown, inactive or unlinked organization selectors cannot select another catalog. Schemas and inferred types live in `packages/contracts/src/portal.ts`.
