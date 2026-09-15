# BDR Client Dashboard Plan

## Purpose

Build a secure client dashboard where BDR customers can sign in, view their buildings and published scan history, and preview or download published reports. The latest published scan is emphasized while all earlier published scans and reports remain accessible.

Keep the dashboard client-only. For the first release, BDR staff manage organizations, client users, projects, inspections, report publication, and the organization-level How to Read document through a local administration CLI backed by the Portal Admin API. The administration UI inside the internal BDR ReportGen platform is deferred until after the client dashboard is operating.

## Core Domain Model

```text
Organization
  |-- Users
  |-- How to Read
  |     `-- Document Versions
  `-- Projects / Buildings
        `-- Inspections / Scans
              `-- Reports
                    `-- Report Versions
```

Every entity uses an opaque unique ID that is not derived from an email address, name, street address, filename, or S3 path:

- `organizationId`: client/company identity.
- `userId`: portal user identity, mapped separately to the Cognito `sub`.
- `projectId`: persistent building/property identity.
- `inspectionId`: one physical scan event.
- `reportId`: one report category within an inspection.
- `reportVersionId`: an immutable published PDF version.
- `organizationDocumentId`: the organization's logical How to Read document.
- `documentVersionId`: an immutable published How to Read PDF version.
- `uploadSessionId`: one idempotent manual-upload attempt.
- `sourceScanId`: future ReportGen idempotency identity for a scan.

Each client user belongs to exactly one organization, and an organization can have multiple active client users. A client `UserProfile` maps the client Cognito issuer and `sub` to an organization. A global `AdminProfile` has its own opaque `adminId`, role, and status and is not assigned to a client organization. An `AdminIdentity` maps an authentication issuer and `sub` to that profile, allowing the first-release CLI identity to be replaced later by an internal ReportGen identity without changing audit ownership.

## Scan, Report, and Organization Document Behavior

- Organizations use authorization status `ACTIVE` or `SUSPENDED`. Projects and inspections use lifecycle status `ACTIVE` or `ARCHIVED`. Reports are not individually archived in v1.
- A project represents one building or property and can contain any number of inspections.
- Reports belong to an inspection, never directly to a project.
- A project stores a required IANA `timeZone` for the building location. Store `scannedAt` as a UTC instant and copy the project's timezone into an immutable inspection-time `scanTimeZone` snapshot. Display scan dates in that timezone with daylight-saving rules; do not reinterpret them in the viewer's timezone.
- Store the inspection publication state separately as `DRAFT` or `PUBLISHED`. Importing or manually creating an inspection creates it with `lifecycleStatus=ACTIVE` and `publicationStatus=DRAFT`; creation alone never makes it client-visible.
- Only active inspections with `publicationStatus=PUBLISHED` and active ancestors appear in client responses, project counts, and scan history. Draft and archived records remain available to authorized BDR administrators.
- Client-visible scans are ordered by the actual `scannedAt` timestamp, newest first. The latest published scan is visually dominant and earlier published scans remain easy to access.
- Multiple scans on the same day are distinguished by timestamp and `inspectionId`.
- The project card shows the latest published scan date, report availability, and published scan count. A newer draft does not change the client project card.
- Before publishing an inspection, the administrator must explicitly classify all four inspection report categories and have at least one category ready to publish.
- Store each category's client delivery status as `NOT_INCLUDED`, `NOT_APPLICABLE`, `EXPECTED`, or `PUBLISHED`:
    - `NOT_INCLUDED` displays **Not included**.
    - `NOT_APPLICABLE` displays **Not applicable**.
    - `EXPECTED` displays **In preparation**. Do not expose `IN_PROGRESS`, because it would claim active work rather than an expected deliverable.
    - `PUBLISHED` displays **Available** and requires a valid `currentVersionId`.
- A published inspection shows all four categories with their explicit client labels, so an unavailable artifact is never presented as an unexplained missing report.
- While an inspection is published, all four Report category records remain present. Withdrawing a published PDF transactionally changes its delivery status to `EXPECTED`, `NOT_INCLUDED`, or `NOT_APPLICABLE`, clears `currentVersionId`, preserves every immutable ReportVersion for administrators, and records `REPORT_WITHDRAWN`. Republishing after withdrawal creates a new immutable ReportVersion.
- After an inspection is published, publishing an `EXPECTED` category makes that report available without republishing the entire inspection.
- Each inspection has at most one logical `Report` per report category. Its `currentVersionId` identifies the version clients can access.
- Publishing a replacement creates a new immutable `ReportVersion` and changes the current-version pointer. It never overwrites the existing PDF.
- New client authorizations resolve only the current report version; BDR administrators can view previous versions and their audit history. A previously issued URL may remain usable until its five-minute expiration, and downloaded files cannot be revoked.
- A failed replacement leaves the existing version current and client-visible.
- Updating one report category does not affect the other report categories for that inspection.
- Store publication timestamps in UTC. Show `Published <local date and time>` for a first version and `Updated <local date and time>` after a replacement, including the viewer's timezone abbreviation.
- Keep the report publication time separate from the inspection's `scannedAt` timestamp.
- Client pages show human report names, scan dates, availability labels, updated times, and Preview/Download actions. They do not render `ReportVersion`, ETag, checksum, source path, S3 key, or version IDs; the direct-download boundary below documents the identifiers visible in browser network tools.
- Archiving a project or inspection records `archivedAt`, `archivedBy`, and a required reason and hides its complete subtree without rewriting descendant publication, delivery, or version state. Archived parents reject new children, publication, replacement, and metadata mutations other than restoration.
- Restoration records an audit event and returns only the selected project or inspection to `ACTIVE`. Before restoring a project, the CLI displays the number of descendants that would immediately become client-visible and requires explicit confirmation. Descendants retain their stored state, so content reappears only when every ancestor is active and its own publication rules pass.
- Legal transitions are explicit: project and inspection lifecycle can move `ACTIVE <-> ARCHIVED`; inspection publication can move only `DRAFT -> PUBLISHED`; and restoring an inspection never changes its stored publication state. Under a published inspection, `EXPECTED`, `NOT_INCLUDED`, or `NOT_APPLICABLE` can move to `PUBLISHED` through publication, and `PUBLISHED` can move back to one of those three states only through withdrawal with a required reason.
- Expose explicit Admin API actions for project and inspection archive/restore and report withdrawal. Restore requests include the revision returned by the preview so a concurrent visibility change fails and requires a new preview. Clients never receive archive controls.
- Archiving and withdrawal never delete metadata, report versions, or published files. Superseded versions remain internal and inaccessible to clients; v1 has no automatic deletion policy for them.

The four inspection report categories are:

1. Assessment
2. Evidence
3. Roof Takeoff
4. Capital Planning

An inspection can be published with only some reports available, but every other category must be deliberately labeled as not included, not applicable, or expected.

Each organization also has at most one logical `OrganizationDocument` of type `HOW_TO_READ`. It is independent of inspections, has `DRAFT` or `PUBLISHED` status, and points to an immutable `DocumentVersion` through `currentVersionId`. Its absence or draft state does not block inspection publication and does not create an inspection report card. When published, it appears once at the organization/dashboard level with View and Download actions. Replacement creates a new immutable version and retains prior versions for internal audit and recovery.

## Application Architecture

```text
Client dashboard on Netlify             Local portal-admin CLI
  -> same-origin /bff/* proxy              -> Portal Admin Cognito + TOTP
  -> Client BFF Lambda                     -> Portal Admin API
             \                               /
              -> shared domain services
              -> Portal DynamoDB registry and audit records
              -> Private portal upload S3 bucket
              -> Private portal published-report S3 bucket
              -> Future ReportGen Import Worker
```

- Use the dashboard TypeScript monorepo for the client-only Next.js application, Client BFF Lambda, Portal Admin API, the `portal-admin` CLI, shared domain services/contracts, and portal AWS CDK infrastructure.
- The Client BFF owns all client HTTP endpoints and calls shared domain services directly. Do not deploy a separate public Client API in v1. The shared services preserve a clean boundary for a future mobile or third-party API without adding a second client authentication surface now.
- Treat the Portal Admin API as the permanent administration backend. Defer the ReportGen administration UI and ReportGen BFF; the future UI will call the same Admin API contracts and will not directly modify portal DynamoDB tables, client Cognito users, or published-report storage.
- Deploy isolated development and production environments in `us-east-1`.
- Each environment has separate Cognito, API, DynamoDB, upload S3, published-report S3, encryption, and monitoring resources.
- Use one invite-only client Cognito pool per portal environment. Client self-signup is disabled; BDR staff invite and revoke client users through the CLI and Portal Admin API.
- Use a separate, invite-only Portal Admin Cognito pool per environment as a temporary first-release identity provider for the CLI. Require authenticator-app TOTP for every administrator; disable email/SMS MFA and trusted-device bypass. This avoids changing or breaking the current ReportGen login while its integration is deferred.
- Give the CLI a dedicated public Cognito app client using authorization-code flow with PKCE and a loopback callback. The CLI opens Cognito Managed Login, holds tokens only in process memory, and never stores passwords, access tokens, or refresh tokens on disk.
- Put administrators in `bdr-admins` and map their Cognito identity to an active `AdminProfile`. When another active administrator exists, that administrator performs an MFA reset; the reset revokes the affected CLI sessions/tokens, blocks privileged access until TOTP is re-enrolled, and creates an audit event.
- Bootstrap the first administrator once per environment through the documented, MFA-protected AWS administrative runbook after Cognito TOTP enrollment. Create the immutable subject mapping, active `AdminProfile`, `ADMIN_GUARD` count, and audit event in one conditional transaction. Do not expose an unauthenticated bootstrap API.
- Set client and admin Cognito access-token lifetimes to 15 minutes. The Client BFF refreshes client tokens server-side; the CLI refreshes its token only for the lifetime of the running command/session.
- Authorization is enforced by the API on every request; UI visibility, route parameters, and Cognito authentication alone are not authorization controls.
- Client-facing project metadata is stored in the portal registry. Clients cannot edit it in the first release.
- Expose stable resource-oriented Portal Admin API routes under `/admin/*`. Use collection/resource operations for organizations, client users, projects, inspections, reports, the organization-level How to Read document, upload sessions, and version history; use explicit action endpoints only for operations such as publish, replace, withdraw, and archive.
- Define `POST /admin/organizations/{organizationId}/documents/how-to-read/publish` for the first publication and `POST /admin/organizations/{organizationId}/documents/how-to-read/replace` for replacement. Both consume a `READY` organization-document upload session and an expected current revision; history is available only to authorized administrators.
- Define `POST /admin/organizations/{organizationId}/upload-sessions` to create the immutable upload target and initial URL. Its `target` is a discriminated union of `INSPECTION_REPORT` with the authoritative project, inspection, and report type, or `ORGANIZATION_DOCUMENT` with type `HOW_TO_READ`. Define organization-scoped `POST .../upload-sessions/{uploadSessionId}/status` to read the session for recovery and publication summaries, `POST .../complete` to verify the resulting S3 object and move it to `READY`, and `POST .../upload-url` to perform the existing-object recovery check and, only when no object exists, issue a replacement URL. Status, complete, and recovery requests repeat the immutable target locator so the service can perform an exact tenant-partition base-table lookup without a GSI or scan. These operations preserve one logical upload session across connection failures without supporting partial resume.
- Define the Admin API request/response schemas in the shared contract package and publish an OpenAPI contract. The CLI and future ReportGen UI/BFF use typed clients generated from or checked against the same contract; no endpoint is shaped around terminal prompts, CLI output, or ReportGen presentation state.
- The CLI is the first Admin API client and remains an operational fallback after the ReportGen UI launches. It never receives AWS data-plane credentials or independently mutates Cognito, DynamoDB, or S3; PDF bytes are sent only through upload requests presigned by the Admin API.
- Use separate Lambda execution roles for the Client BFF, upload URL issuance, validation/publication, audit export, and client artifact signing. Do not give a shared role the union of upload-bucket and published-bucket permissions.
- No existing API, environment variable, or secret is required from the ReportGen developer for the first release. Never request AWS keys, passwords, or TOTP seeds.

## Client Browser Sessions and BFF

- Use Cognito Managed Login with authorization-code flow and PKCE. Cognito returns the authorization callback to the Client BFF; Cognito tokens are never returned to frontend JavaScript. Use a dedicated confidential Cognito app client and keep its secret in AWS Secrets Manager.
- Deploy the Client BFF as Lambda endpoints in the portal AWS stack. The Netlify project proxies same-origin `/bff/*` requests to those endpoints.
- Store client access and refresh tokens in a DynamoDB session table isolated by environment. Encrypt token fields with the environment KMS key and store only a hash of a cryptographically random session identifier.
- Give the browser a host-only `__Host-bdr_client_session` cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. Do not set `Domain`, and do not put Cognito tokens in local storage, session storage, JavaScript-readable cookies, or frontend state.
- Use a seven-day absolute client session and 15-minute Cognito access tokens. Store immutable `absoluteExpiresAt` and a separate numeric `ttlExpiresAt` on both the session and subject pointer. Rotate the session identifier on login and token refresh.
- Every authenticated BFF request performs a strongly consistent session read and compares `absoluteExpiresAt` with current server UTC time before using or refreshing tokens. Reject an expired, revoked, missing, or mismatched session with `401` even if DynamoDB has not deleted its TTL-expired records. DynamoDB TTL is cleanup only because [expired items can remain for several days](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).
- `POST /bff/logout` validates CSRF, invalidates the server session and subject pointer, attempts Cognito refresh-token revocation, clears the portal cookie, and returns a browser redirect through [Cognito's `/logout` endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html) using `client_id` and an exact environment-specific allowed `logout_uri`. This browser redirect is required because [Managed Login maintains its own one-hour browser cookie](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html). Local invalidation still succeeds and emits an alert if Cognito revocation fails.
- Mutating BFF routes require the exact expected `Origin` and a custom CSRF header. Strip browser-supplied `Authorization`, identity, forwarding, and internal request-context headers before proxying.
- Generate a request ID at the BFF, propagate it through shared domain services and audit events, and do not cache authenticated responses.
- Keep report bytes out of the BFF. After authorization, the BFF returns a five-minute S3 presigned URL for direct preview or download.
- Apply a restrictive Content Security Policy and standard security headers to the dashboard, including `Referrer-Policy: no-referrer` and only the origins required for Cognito login, the BFF, and report preview.

## Dashboard Deployment

- Create two permanent Netlify projects connected to this repository and keep both independent from the existing ReportGen deployment. The development site deploys `develop` and is permanently mapped to development AWS resources; the production site deploys `main` and is permanently mapped to production AWS resources.
- Netlify hosts the frontend and proxies `/bff/*`; AWS CDK independently deploys Cognito, the Client BFF, Admin API, DynamoDB, S3, KMS, and monitoring for each environment. Promote validated changes from `develop` to `main`; never retarget either Netlify site to another environment.
- Configure distinct site URLs, Cognito callback/logout URLs, cookie origins, BFF destinations, and CORS allowlists for development and production. Development identities and records are never migrated into production.
- Do not expose AWS credentials, Cognito client secrets, or API tokens through Netlify environment variables. The frontend uses the relative `/bff` path and non-secret public configuration only.
- Disable authenticated backend access from ephemeral deploy previews unless an exact preview origin and Cognito callback have been deliberately configured.
- Verify that the Netlify proxy preserves OAuth callbacks, host-only secure cookies, `Set-Cookie`, request origins, and logout behavior before treating the deployment as production-ready.

## Authentication and Authorization

- Client routes use the BFF's opaque server session cookie rather than a public Cognito JWT authorizer. The OAuth callback validates token type, issuer, app-client ID, expiration, state, nonce, PKCE, and expected scope before creating the session; Cognito tokens never become browser credentials.
- First-release `/admin/*` routes trust only the temporary Portal Admin Cognito issuer/audience. Replace that admin authorizer with the ReportGen Cognito issuer/audience during the future controlled cutover; do not add it as a simultaneous second production issuer.
- Enable Cognito token revocation, but never treat `RevokeToken`, `GlobalSignOut`, or local JWT signature-and-expiration verification as immediate application authorization. [Cognito documents](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html) that a revoked self-contained JWT can still pass an ordinary local verifier.
- Every client request resolves the strongly consistent BFF session, then converts its verified `{issuer, sub}` into the base-table identity key `SUBJECT#{issuerHash}#{sub}`, verifies the stored full issuer, and requires `UserProfile.status === ACTIVE`.
- Client collection routes are user-relative, such as `GET /bff/me/projects`; they do not accept an organization ID from the browser.
- The organization-document routes are `GET /bff/me/documents/how-to-read` and `POST /bff/me/documents/how-to-read/access`. They derive the organization only from the authenticated client context and never accept an organization or document-version ID from the browser.
- For a resource route such as `GET /bff/projects/{projectId}`, the BFF derives `PK=ORG#{organizationId}` exclusively from the authenticated `UserProfile` and loads the project from that partition. The same tenant-partition rule applies through the project, inspection, report, organization-document, upload-session, and immutable-version hierarchies.
- A missing resource and a resource owned by another organization both return `404` to client users.
- Project, inspection, report, organization-document, immutable-version, organization, and S3 identifiers received from the browser identify requested data but never prove authorization.
- The report-access route is `POST /bff/projects/{projectId}/inspections/{inspectionId}/reports/{reportType}/access` and accepts only a `VIEW` or `DOWNLOAD` disposition. It must call the centralized `authorizeCurrentReportAccess` policy and can sign only the exact object locator returned by that policy.
- After CLI login, `POST /admin/auth/sessions` validates the access token locally and calls Cognito `GetUser` with that token so a token already revoked by Cognito cannot bootstrap a new application session. It then conditionally creates an eight-hour AdminSession keyed by a hash of `origin_jti`; an existing revoked session key is a tombstone and cannot be reactivated. Every other privileged request requires that session in addition to JWT validation. `DELETE /admin/auth/session` marks it revoked, revokes the in-memory refresh token, and opens Cognito `/logout` in the same system browser used for login.
- Admin middleware validates `token_use === access`, issuer, app-client ID, expiration, expected scope, and `bdr-admins` membership, then strongly consistently resolves the active AdminSession, `AdminIdentity`, and `AdminProfile`. It requires an unexpired and unrevoked session, `AdminProfile.status === ACTIVE`, `AdminProfile.role === BDR_ADMIN`, and current verified TOTP enrollment. Any mismatch fails closed and records a security audit event.
- Disabling an administrator, resetting MFA, or performing global revocation invalidates every AdminSession for that administrator before relying on Cognito revocation. V1 may launch with one administrator, and ordinary APIs reject disabling, demoting, or revoking the last active administrator. If the sole administrator loses TOTP access, use a documented runbook and a strongly protected, named AWS administrative identity to recover Cognito access. Keep the affected portal administrator blocked during recovery, invalidate the old TOTP association and every session, require new TOTP enrollment, and record an incident plus `BREAK_GLASS_ADMIN_RECOVERY`. Never use a shared administrator account or store a TOTP seed as the recovery mechanism.
- Role, status, organization membership, and MFA-enrollment security fields cannot be edited through client self-service APIs. Portal DynamoDB or either Cognito lookup failing denies access.
- Do not cache authorization decisions when doing so would delay an administrator's role, status, session, or MFA revocation.
- A future ReportGen identity must be explicitly linked to an existing `AdminProfile`; matching by email address or display name is forbidden.

## Invitations and Account Recovery

- Use invitation states `PENDING`, `ACCEPTED`, `EXPIRED`, `CANCELLED`, and `DELIVERY_FAILED`. Store an application-enforced `absoluteExpiresAt` seven days after issuance; DynamoDB TTL may clean up terminal operational records later but never determines whether an invitation is valid.
- Normalize an invitation email by trimming surrounding whitespace, applying Unicode normalization, and lowercasing it for comparison. Reserve `EMAIL#{sha256(normalizedEmail)}` through a strongly consistent base-table item so case variants cannot create duplicate identities. The original address is retained only for delivery and display.
- Expose `POST /admin/organizations/{organizationId}/invitations`, `POST /admin/organizations/{organizationId}/invitations/{invitationId}/resend`, `POST /admin/organizations/{organizationId}/invitations/{invitationId}/cancel`, `POST /admin/organizations/{organizationId}/users/{userId}/revoke`, and `POST /admin/organizations/{organizationId}/users/{userId}/replace-identity` through the Admin API and CLI. Keeping every child route organization-scoped permits a direct base-table lookup and avoids a GSI or cross-tenant scan.
- Invitation creation is an idempotent operation: reserve the normalized email and create the pending intent, call Cognito `AdminCreateUser`, then transactionally create the subject identity, `INVITED` UserProfile, organization user record, and final invitation metadata. If Cognito creation succeeds but the transaction fails, disable and delete the incomplete Cognito user before releasing the reservation; if compensation fails, keep the reservation, alert an administrator, and deny that Cognito identity through the missing/inactive profile check.
- The first successful Cognito callback for an unexpired invitation transactionally changes the invitation to `ACCEPTED` and the UserProfile from `INVITED` to `ACTIVE`. Client authorization never accepts an `INVITED`, expired, cancelled, or revoked profile.
- Resend is allowed only for a pending, unaccepted invitation. It uses Cognito's resend action, replaces the temporary credential, resets the seven-day application expiry, and records an audit event. An expired invitation must pass the same email reservation and organization checks before resend. Accepted and cancelled invitations cannot be resent.
- If Cognito reports a delivery failure, mark the invitation `DELIVERY_FAILED`. For an asynchronous bounce or reported nonreceipt, the administrator checks Cognito/SES delivery information, cancels the pending invitation, corrects the address, and creates a replacement. Never silently change the email attached to an accepted identity.
- Active users use Cognito Managed Login's forgot-password flow. A compromised account is handled through the Admin API: mark the profile revoked, invalidate all server sessions, invoke Cognito `AdminUserGlobalSignOut`, disable the old Cognito identity, and explicitly attach a newly verified Cognito identity to the same immutable `userId` and `organizationId`. Email matching alone never links the replacement.

## Centralized Client Visibility Policy

Implement these rules once in a shared client policy/repository module called directly by the Client BFF. Route handlers may supply validated route parameters and serialize returned data, but they cannot reproduce, weaken, or bypass the policy checks.

`loadActiveClientContext(issuer, sub)` requires:

- A valid, unexpired BFF session whose stored issuer and subject came from the validated OAuth callback.
- A strongly consistent Identity-table record with matching full issuer and `UserProfile.status === ACTIVE`.
- A strongly consistent organization `META` item under the identity's `organizationId` with `status === ACTIVE`.

`loadVisibleProject(context, projectId)` additionally requires:

- The project exists under `PK=ORG#{context.organizationId}`.
- `Project.lifecycleStatus === ACTIVE`.

`loadVisibleInspection(context, projectId, inspectionId)` additionally requires:

- The project passes `loadVisibleProject`.
- The inspection exists at the exact project/inspection sort key.
- `Inspection.lifecycleStatus === ACTIVE` and `Inspection.publicationStatus === PUBLISHED`.

`authorizeCurrentReportAccess(context, projectId, inspectionId, reportType)` additionally requires:

- The inspection passes `loadVisibleInspection`.
- The Report exists at the exact project/inspection/report-type sort key.
- `Report.deliveryStatus === PUBLISHED`.
- `Report.currentVersionId` is present.
- The referenced ReportVersion exists at the exact organization/project/inspection/report-type/version sort key and has `integrityStatus === VERIFIED`.
- The ReportVersion contains a non-empty server-generated S3 key and S3 `versionId`, and its key is exactly `versions/{reportVersionId}.pdf` for the version resolved through the authorized tenant hierarchy.

`authorizeCurrentOrganizationDocumentAccess(context, HOW_TO_READ)` requires:

- The active client context supplies the organization; no route value can replace it.
- The `OrganizationDocument` exists at the organization's exact `DOCUMENT#HOW_TO_READ` key and has `status === PUBLISHED`.
- `OrganizationDocument.currentVersionId` is present.
- The referenced `DocumentVersion` exists at the exact organization/document/version key and has `integrityStatus === VERIFIED`.
- The version contains a non-empty server-generated S3 key and S3 `versionId`, and its key is exactly `versions/{documentVersionId}.pdf`.

The policy returns only `{key, versionId, disposition, filename}` to the signing service. The signing service injects the published bucket name from server configuration. Browser-supplied organization IDs, report-version IDs, document-version IDs, S3 keys, bucket names, and S3 version IDs are never accepted.

Use the same layered functions for direct and collection routes:

- Project collections require an active client context and return only active projects from its organization partition.
- Inspection collections require a visible project and return only `PUBLISHED` inspections.
- Report metadata collections require a visible inspection and return all four category records, allowing the UI to show Available, In preparation, Not included, and Not applicable.
- Preview and download require the complete `authorizeCurrentReportAccess` predicate; metadata visibility alone never authorizes a PDF.
- How to Read metadata and access use only the organization-document predicate. A draft or absent document returns the same client-visible `404` and has no effect on project or inspection visibility.

Map invalid or expired authentication to `401` and an authenticated but inactive user to `403`. Return the same `404` for missing, foreign, draft, archived, unpublished, mismatched, or otherwise client-invisible resources. Do not disclose which predicate failed. Emit a presigned URL and the applicable `REPORT_DOWNLOAD_LINK_ISSUED` or `ORGANIZATION_DOCUMENT_LINK_ISSUED` audit event only after the complete predicate succeeds.

Direct presigned URLs intentionally expose the S3 hostname, opaque object key, and S3 `versionId` in browser network tools and to anyone who receives the URL. These identifiers are not authorization evidence and contain no organization, project, inspection, address, or report-type hierarchy. Do not render them in the product UI or write them to application logs.

## Initial Report Publication

The first release uses manual uploads initiated by the authenticated `portal-admin` CLI and enforced by the Portal Admin API. No portal service receives access to the operational ReportGen bucket.

```text
BDR admin uses portal-admin CLI to create an inspection as DRAFT
  -> classifies all four inspection report categories
  -> Admin API creates upload sessions for available PDFs
  -> CLI uploads PDFs to the private upload bucket
  -> Admin API verifies the exact uploaded S3 version's size, PDF header, content type, and checksum
  -> CLI displays the complete client-facing publication summary and revision
  -> admin affirms BDR approval and confirms the exact projectId
  -> admin runs the explicit publish command with that revision
  -> Publisher copies each exact ready source version to an immutable key in the published bucket
  -> Publisher verifies each destination checksum, size, and S3 versionId
  -> one DynamoDB transaction registers copied versions and publishes inspection
  -> inspection and published reports become visible to the client
```

- Manual upload supports all four inspection report categories and the organization-level How to Read document.
- Upload through a single presigned `PutObject` request to the private upload bucket with a configurable limit that defaults to 100 MB. Multipart upload and byte-range resume are deliberately deferred; an interrupted upload restarts from the beginning.
- Give each upload URL a 15-minute start window. The CLI requests the URL only after calculating the file's size and checksum and begins the PUT immediately. An upload that began before URL expiry may finish, but any request or retry made after expiry must use a newly issued URL.
- Before requesting an upload, the CLI rejects empty or oversized files, verifies the `%PDF-` header, and calculates SHA-256.
- Generate the upload key server-side as `uploads/{uploadSessionId}/source.pdf`; never put tenant-visible or published objects under this prefix.
- The Admin API accepts the declared size and checksum only as upload inputs. After upload, it records the exact upload-bucket S3 `versionId` and uses object metadata plus a small range read to verify that version exists, is non-empty and no larger than the configured 100 MB default, has `application/pdf` metadata, begins with `%PDF-`, and has the expected SHA-256 checksum.
- Do not add malware scanning, full PDF parsing, password/encryption detection, or a PDF page-count limit in the first release. Reconsider content scanning only if external users or systems can supply files or a contractual requirement demands it.
- Never use a client-provided filename as an S3 key. Preserve a sanitized original filename only as private metadata when useful for administration.
- Use the upload states `UPLOADING`, `READY`, `PUBLISHING`, `PUBLISHED`, and `FAILED`.
- The UploadSession stores its immutable discriminated target, exact upload-bucket key, declared size and SHA-256 checksum, source `versionId` after verification, verified size/checksum/content type, state, allocated artifact version ID and published key, destination `versionId` after copying, timestamps, and actor. Non-published sessions expire from DynamoDB after the upload bucket's seven-day retention; publishing removes that TTL.
- Allow an active administrator to request a replacement upload URL only while the session is `UPLOADING`, unexpired, and still refers to the same declared size and checksum. Reauthorization never changes the upload key, declared file identity, artifact target, or tenant hierarchy.
- Before issuing a replacement URL, the Admin API checks the server-generated upload key. If no object exists, it returns a fresh presigned PUT URL and the CLI restarts the complete upload. If the expected complete object already exists, such as when S3 accepted the PUT but the CLI missed the response, the API verifies its exact size, checksum, content type, PDF header, and S3 `versionId` and advances the session to `READY` without uploading again. If an unexpected or mismatched object exists, mark the session `FAILED`; `If-None-Match: *` prevents overwriting it, so the administrator must create a new upload session and key.
- A failed single PUT does not produce a partial S3 object. Network errors, request timeouts, expired URLs, and ambiguous client responses therefore recover through the same status-check and URL-refresh operation rather than multipart state, S3 event processing, or a background queue.
- Only an upload that passes the post-upload S3 integrity checks can become `READY` and be published.
- For a new draft inspection, the CLI's explicit publish command is the client-release step. It requires all four category statuses to be explicit and at least one ready PDF selected as `PUBLISHED`.
- Before that command, the CLI displays the organization name and ID, building name, address and project ID, scan date and building timezone, inspection ID, all four category classifications, source filenames, and whether each PDF is a first publication or replacement. It requires the operator to enter the exact `projectId` and affirm that the normal BDR approval occurred.
- The publish request includes `expectedRevision`, `approvalConfirmed=true`, and a versioned approval-statement identifier. The server reloads the complete target state, recomputes the revision, and rejects stale or mismatched requests. The publication audit event records the operator, timestamp, statement version, and summary digest. This is a single-operator attestation, not proof of independent approval; v1 does not enforce a two-person report-approval workflow.
- Begin publication with a conditional `READY -> PUBLISHING` update that allocates the appropriate `reportVersionId` or `documentVersionId` once and persists the destination key before copying. Competing or repeated requests reuse the same operation rather than allocating another version. Generate the immutable published-bucket key server-side only after validating the complete target hierarchy:

  ```text
  versions/{artifactVersionId}.pdf
  ```

- Never create or overwrite a mutable alias such as `current.pdf`. A replacement receives a new immutable report or document version ID, while DynamoDB changes only the logical artifact's `currentVersionId`.
- Require `If-None-Match: *` on the presigned upload-bucket `PutObject` request. An existing upload-session key returns `412 Precondition Failed` and is never overwritten.
- The dedicated Publisher role reads the exact recorded upload-bucket key and source `versionId` and streams it into a conditional `PutObject` for the allocated published-bucket key using `If-None-Match: *`. It sets `Content-Type: application/pdf`, `Cache-Control: private, no-store`, and a safe inline `Content-Disposition`, then reads destination metadata and requires the expected size and SHA-256 checksum before retaining the destination S3 `versionId`. The conditional write prevents a retry or race from creating another object version at the same immutable key.
- Publication retries reuse the upload session's allocated destination key. If a matching destination already exists from an earlier attempt with an uncertain response, reuse its exact S3 `versionId`; a checksum or size mismatch fails closed and must never be overwritten.
- Use `uploadSessionId` as the durable idempotency key. Repeating Publish for the same upload returns the existing result and cannot create another version.
- Create a `ReportVersion` only after a `READY` upload has been copied and the published destination has been verified. The immutable version stores `integrityStatus=VERIFIED`, the exact published-bucket S3 key, S3 `versionId`, SHA-256 checksum, file size, content type, publication timestamp, and publishing actor.
- Publish a new inspection with one DynamoDB transaction that creates all selected `ReportVersion` records, sets their `Report.currentVersionId` and `deliveryStatus`, marks their upload sessions `PUBLISHED`, changes the inspection from `DRAFT` to `PUBLISHED`, and records the audit event.
- For an already-published inspection, publishing an expected report or replacement uses a smaller DynamoDB transaction that creates the new `ReportVersion`, updates `Report.currentVersionId` and `deliveryStatus`, marks the upload session `PUBLISHED`, and records the audit event. The update becomes immediately visible to clients.
- Publishing or replacing How to Read uses a DynamoDB transaction that creates the immutable `DocumentVersion`, updates the organization's logical `OrganizationDocument.currentVersionId` and `status`, marks the upload session `PUBLISHED`, and records `ORGANIZATION_DOCUMENT_PUBLISHED` or `ORGANIZATION_DOCUMENT_REPLACED`. It does not create or update an inspection.
- Protect the report update with an expected revision/current-version condition so concurrent replacements cannot silently overwrite each other.
- Client BFF domain services resolve files only through the authorized report or organization document's `currentVersionId` and request the exact stored published-bucket S3 `versionId`. Objects in the upload bucket and published objects without a committed registry reference are never client-visible.
- A failed copy or destination verification does not run the DynamoDB publication transaction. A failed initial publication leaves the inspection or organization document `DRAFT`; a failed replacement leaves the previous version current. If the copy succeeds but the transaction fails, the verified published object is an unreferenced orphan that remains invisible and can be removed only by a separately authorized reconciliation operation after confirming that no ReportVersion or DocumentVersion references it.
- Provide separate View PDF and Download PDF actions for published reports and How to Read. Generate their five-minute presigned URLs only after authorization, and do not cache authenticated artifact responses.
- Sign `response-content-type=application/pdf`, `response-cache-control=private, no-store`, and a server-generated `response-content-disposition` into each URL. Use `inline` for View and `attachment` for Download.
- For an inspection report, build the human filename from the project display name, report name, and inspection date. For How to Read, use the organization display name and document name. Normalize the result to ASCII letters, numbers, periods, underscores, and hyphens, cap it at 120 characters including `.pdf`, and fall back to `report.pdf`. Browser input never supplies the signed filename.
- Support normal S3 `Range` requests so browser PDF viewers can receive `206 Partial Content`. The published object's base metadata supplies the PDF type and no-store policy for range responses; signed overrides define the full-response View/Download disposition. The published-bucket CORS policy permits `GET` and `HEAD` only from the exact development and production portal origins and exposes `Accept-Ranges`, `Content-Length`, `Content-Range`, `Content-Type`, and `ETag`. S3 [supports signed response-header overrides and byte ranges](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
- Treat presigned URLs as temporary bearer credentials: anyone who receives one can use it until expiration. Never store or emit complete presigned URLs in application logs. Expiration cannot prevent a user from retaining or sharing a PDF after download.
- Use separate private upload and published-report buckets and separate customer-managed KMS keys per environment. Enable S3 Versioning, all four S3 Block Public Access settings, and `BucketOwnerEnforced` Object Ownership on both buckets.
- The upload-presigner role can authorize `PutObject` only to server-generated keys in the upload bucket and can use only the upload-bucket KMS key for encryption. It cannot read either bucket or use the published-bucket key.
- The validation/Publisher role can read and decrypt exact upload-bucket versions and copy verified files to server-generated published-bucket keys using the published-bucket KMS key. It cannot generate client download URLs or delete published object versions.
- The client report-access signer role can perform `GetObject` and use `kms:Decrypt` only for the published-report bucket and its KMS key. It has no permissions on the upload bucket or upload-bucket KMS key and cannot write or delete objects or versions.
- Apply a seven-day lifecycle expiration to upload-bucket objects and versions. Published objects have no automatic expiry.
- Add a published-bucket policy deny for presigned `s3:GetObject` requests when `s3:signatureAge` exceeds `300000` milliseconds.
- Do not enable S3 Object Lock on the upload or published-report buckets in the first release. Unique version keys, conditional manual writes, exact S3-version references, bucket versioning, and restricted IAM protect report objects without permanent WORM retention. The separate audit-archive bucket uses governance retention as defined in the auditing section.
- Do not add malware scanning, CDR, Step Functions, or SQS to the initial workflow. The storage boundary requires only the upload bucket, published bucket, synchronous copy/verification path, and DynamoDB publication transaction.
- Do not add multipart upload in the first release. Accept that a failed upload restarts from byte zero; revisit multipart only if actual operational failures make that tradeoff unacceptable.
- Do not send report-ready email notifications in v1.

### Watermark Boundary

- A static BDR watermark may be added upstream when ReportGen generates a PDF.
- Personalized client, user, or download-time watermarks are deferred. A direct S3 presigned download cannot modify an existing PDF; that feature would require generating and probably caching a derived PDF by artifact version and organization or user.
- Preserve the distinct access operation and link-issuance audit data so a later derived-PDF service can be introduced without changing the client route contract.

## Future ReportGen Integration

### Administration UI and Authentication Cutover

The Portal Admin API, DynamoDB model, publication workflow, and S3 roles remain unchanged when administration moves into ReportGen. Only the administration client and accepted identity provider change.

1. Add the ReportGen BFF and administration screens using the existing Admin API OpenAPI contract. The browser communicates with the same-origin ReportGen BFF and never receives ReportGen Cognito tokens.
2. Add dedicated ReportGen Cognito app clients for the BFF and CLI, configure authorization-code flow with PKCE, and require authenticator-app TOTP for administrators before enabling portal administration.
3. While authenticated through the temporary Portal Admin system, explicitly link each verified ReportGen `{issuer, sub}` to the administrator's existing `adminId`. Never infer this link from email address, name, Cognito username, or group membership. Record `ADMIN_IDENTITY_LINKED`.
4. Deploy a temporary non-production or parallel test stage whose `/admin/*` routes use the ReportGen Cognito JWT authorizer and the unchanged Admin API handlers. Complete authorization, TOTP, CLI, BFF, publication, and audit tests there.
5. Update the `portal-admin` CLI to use its dedicated ReportGen Cognito public app client, keeping tokens in process memory as before.
6. Cut the production `/admin/*` routes to the ReportGen Cognito authorizer in one controlled release. After cutover, the routes accept only ReportGen Cognito access tokens; old Portal Admin Cognito tokens fail closed.
7. Revoke temporary Portal Admin identities and sessions immediately after the successful cutover. Retain the unused pool for a seven-day rollback window, then delete it after verifying that every active administrator can use ReportGen authentication. Record `ADMIN_AUTH_PROVIDER_CUTOVER` and pool retirement.

Do not add a custom multi-issuer authorizer or permanently accept both identity providers on the same production route. `AdminIdentity -> AdminProfile` preserves the same `adminId`, role, status, and audit ownership through the cutover. The CLI remains available as an operational fallback and uses ReportGen Cognito after migration.

### Export and Automatic Publication

ReportGen currently has no client-export service or isolated export bucket. This integration will be implemented later in the ReportGen repository.

```text
ReportGen operational S3
  -> ReportGen operator clicks Publish to Client Portal
  -> controlled ReportGen Export Service
  -> separate ReportGen export bucket
  -> portal Import Worker
  -> private portal published-report bucket and registry
  -> automatic client visibility
```

The future design will follow these rules:

- The ReportGen Publish screen lets the operator select the destination portal organization and project.
- ReportGen queries only a narrow, AWS IAM-protected portal endpoint for active organization and project choices.
- For an inspection publication, the operator classifies all four inspection report categories before publishing. The export manifest includes inspection lifecycle/publication state and each category's delivery status. How to Read is exported and imported as a separate organization-document operation.
- **Publish to Client Portal** in ReportGen is the final approval; no second dashboard approval is required. Generation or import alone never makes an inspection visible.
- Each scan has a stable `sourceScanId`, and every export attempt has a unique `exportId`.
- ReportGen copies only selected client-ready PDFs into an isolated export package.
- `manifest.json` is written last so its presence marks a complete package.
- The manifest declares whether the target is an inspection report package or the organization's How to Read document and contains only the destination IDs appropriate to that target, along with checksums, sizes, generation time, and source provenance.
- Raw imagery, intermediate pipeline data, prompts, logs, credentials, configuration files, and unrelated artifacts are never exported.
- Only the separate portal Import Worker can read the export bucket. The normal client and admin APIs cannot read it.
- The portal validates the manifest, destination, checksums, report types, and idempotency before publishing.
- The Import Worker reuses the copy-before-commit invariant: copy every exact export-bucket source version into a unique published-bucket key, verify its checksum, size, and destination S3 `versionId`, then commit client-visible registry state.
- The future Import Worker receives its own least-privilege read permission for the ReportGen export bucket and write permission for server-generated published-bucket keys. It receives no access to the manual upload bucket.
- An import initiated by the explicit ReportGen publish action becomes client-visible only after the Portal Import Worker has validated the complete package and atomically committed the `PUBLISHED` inspection and report state.
- Missing or invalid destination mappings fail closed; the system never guesses from names or paths.
- Export packages expire after 30 days. Portal-published copies remain retained.
- ReportGen reports `Publishing`, `Published`, or `Failed`; `Published` means the portal import completed successfully.
- The Client BFF and Portal Admin API never browse the operational ReportGen bucket. The existing ReportGen operator UI may continue its separately authorized operational browsing and displays portal import/publication history through the Portal Admin API.

## Metadata Ownership

- The portal owns the project metadata shown to clients.
- Manual setup or a future ReportGen export can propose project and inspection metadata.
- ReportGen metadata does not silently overwrite current portal project metadata.
- Administrators can review and explicitly apply proposed metadata changes.
- Each inspection preserves an inspection-time metadata snapshot so historical reports remain understandable after project information changes.
- The project metadata includes its required building-location IANA timezone. Each inspection copies that value into `scanTimeZone` when created; later project timezone corrections do not rewrite historical scan display semantics.

## Persistence and Auditing

Use five on-demand DynamoDB tables per environment. Do not define a GSI or LSI in the first release.

### Identity Table

Use composite base keys and strongly consistent base-table reads:

```text
Client identity:  PK=SUBJECT#{issuerHash}#{sub}  SK=PROFILE
Admin identity:   PK=SUBJECT#{issuerHash}#{sub}  SK=PROFILE
Admin profile:    PK=ADMIN#{adminId}             SK=PROFILE
Admin guard:      PK=ADMIN_GUARD                 SK=ACTIVE_COUNT
Email reservation: PK=EMAIL#{sha256(normalizedEmail)} SK=RESERVATION
```

- Store the full issuer on every identity item and compare it after lookup; `issuerHash` is only a deterministic key-safe representation.
- A client identity contains immutable `userId` and `organizationId` plus `INVITED`, `ACTIVE`, or `REVOKED` status. An admin identity contains immutable `adminId`; the admin profile contains role, status, and MFA control state.
- Client authorization uses one strongly consistent `GetItem`. Admin authorization uses strongly consistent base-table reads for both the identity and admin profile.
- Maintain the authoritative active-administrator count in the fixed `ADMIN_GUARD` item. Administrator creation, activation, disablement, and demotion update the profile and guard in one transaction. Disablement and demotion condition the decrement on the expected count being greater than one, preventing concurrent requests from removing every active administrator.
- Do not create an organization-reassignment endpoint. Moving a person to another client organization revokes the old identity and creates a new `userId` and identity under the destination organization; it never mutates `organizationId` on an existing identity.

### Tenant Data Table

Place every client-owned item in its organization's base-table partition:

```text
PK=ORG#{organizationId}  SK=META
PK=ORG#{organizationId}  SK=USER#{userId}
PK=ORG#{organizationId}  SK=PROJECT#{projectId}
PK=ORG#{organizationId}  SK=INSPECTION#{projectId}#{inspectionId}
PK=ORG#{organizationId}  SK=REPORT#{projectId}#{inspectionId}#{reportType}
PK=ORG#{organizationId}  SK=VERSION#{projectId}#{inspectionId}#{reportType}#{reportVersionId}
PK=ORG#{organizationId}  SK=REPORT_UPLOAD#{projectId}#{inspectionId}#{uploadSessionId}
PK=ORG#{organizationId}  SK=DOCUMENT#HOW_TO_READ
PK=ORG#{organizationId}  SK=DOCUMENT_VERSION#HOW_TO_READ#{documentVersionId}
PK=ORG#{organizationId}  SK=DOCUMENT_UPLOAD#HOW_TO_READ#{uploadSessionId}
```

- Treat the partition and sort keys as the authoritative ownership and parentage. Any duplicated IDs in attributes are response metadata and cannot be updated independently.
- Query client collections only with the authenticated organization partition and an entity prefix. Sort the small inspection collection by its immutable `scannedAt` attribute in application code.
- Create child records with `TransactWriteItems`: condition-check the authoritative parent keys, derive all child keys from those loaded parents, and conditionally create the new item so a duplicate or mismatched parent fails closed.
- Publishing and replacement transactions condition-check the inspection, report, upload-session state, expected current version/revision, and active administrator profile before changing client-visible pointers.
- Normal application roles cannot call `DeleteItem` for tenant records. Archiving changes project or inspection status without changing keys. Organization, project, inspection, report, and organization-document parentage cannot be reassigned through normal APIs.
- Published projects cannot be re-parented through CRUD, direct table updates by application roles, or metadata refresh. A future project migration is a dedicated operation that validates active source and destination organizations, freezes source mutations, revokes both organizations' client sessions, requires approval from two distinct active BDR administrators within 24 hours, creates destination-owned records with new IDs, archives the source project, and records the complete mapping and before/after ownership in immutable audit events. No such migration endpoint or role is deployed in v1.

### Admin Control Table

Use base-table partitions for administrative collections and global idempotency that clients must never read:

```text
PK=DIRECTORY#ORGANIZATIONS      SK=ORG#{organizationId}
PK=IDEMPOTENCY#{operationType}  SK={idempotencyKey}
PK=ORG#{organizationId}         SK=INVITATION#{invitationId}
PK=MIGRATION#{migrationId}      SK=APPROVAL#{adminId}        # future only
PK=SOURCE#REPORTGEN             SK=SCAN#{sourceScanId}       # future integration
```

- The Admin API queries the fixed organization-directory partition and sorts its small result set in application code.
- Create, rename, suspend, or reactivate an organization by transactionally updating its tenant `META` item, its directory projection, and its audit event. The directory is an administrative projection and is never authorization evidence.
- The Client BFF role has no permissions on this table. No tenant collection or authorization decision uses this directory.

### Session Table

Support both direct session lookup and strongly consistent subject-wide revocation without a GSI:

```text
PK=SESSION#{sha256(sessionId)}       SK=SESSION
PK=SUBJECT#{issuerHash}#{sub}        SK=SESSION#{sha256(sessionId)}
PK=LOGIN#{sha256(oauthState)}        SK=TRANSACTION
PK=ADMIN_SESSION#{sha256(originJti)} SK=SESSION
PK=ADMIN#{adminId}                   SK=SESSION#{sha256(originJti)}
```

- Write each client or admin session and its subject/admin pointer transactionally. Store immutable `absoluteExpiresAt`, mutable `revokedAt`, and a numeric `ttlExpiresAt` used only for asynchronous cleanup.
- Store each client OAuth state, nonce, encrypted PKCE verifier, safe return path, absolute expiry, and consumption marker as a ten-minute login transaction. Bind the state to a temporary host-only HttpOnly cookie and consume it conditionally in the same transaction that creates the client session, so callbacks cannot be replayed or initiated from a different browser.
- Session lookup uses the hashed base key and a strongly consistent read. Every authenticated request requires `revokedAt` to be absent and `absoluteExpiresAt` to be later than current server UTC time; the presence of an item awaiting DynamoDB TTL deletion never authorizes access.
- Client logout and subject revocation query the subject partition and invalidate every referenced session. Admin logout invalidates the `origin_jti` session; admin disablement, MFA reset, or global revocation queries the admin partition and invalidates every AdminSession. Revoked AdminSession tombstones remain until their TTL cleanup so the same locally valid JWT cannot register the revoked `origin_jti` again.

### Audit Table

Store append-only events under strongly queryable base partitions:

```text
PK=ORG#{organizationId}  SK=EVENT#{occurredAt}#{eventId}
PK=SYSTEM                SK=EVENT#{occurredAt}#{eventId}
```

- Dedicated audit-writer roles can only append events with a conditional `PutItem` using `attribute_not_exists(PK) AND attribute_not_exists(SK)`. They cannot call `UpdateItem`, `DeleteItem`, or `BatchWriteItem`. Client and publication mutations that fit in DynamoDB transactions commit their audit event in the same transaction and fail if the audit write fails.
- Only the Admin API's audit-reader role can query audit history. The Client BFF, upload presigner, Publisher, signer, and future importer cannot read audit records; normal application and deployment roles cannot alter or delete them.
- Organization-scoped operations write to the organization partition; authentication, infrastructure, and other global security events use `SYSTEM`.

Audit security and publication actions with the action, actor `adminId` or `userId`, actor `sub` where applicable, target, UTC timestamp, request ID, and relevant before/after values. Record source IP and user agent as operational context where available, while treating both as potentially spoofable metadata rather than authorization evidence. Never store passwords, tokens, TOTP seeds, complete presigned URLs, or PDF contents in audit records.

Use explicit audit actions including `CLIENT_LOGIN`, `CLIENT_LOGOUT`, `ADMIN_LOGIN`, `SESSION_REVOKED`, `ADMIN_SESSION_REVOKED`, `ADMIN_MFA_RESET`, `BREAK_GLASS_ADMIN_RECOVERY`, `USER_INVITED`, `INVITATION_RESENT`, `INVITATION_EXPIRED`, `INVITATION_CANCELLED`, `INVITATION_DELIVERY_FAILED`, `USER_REVOKED`, `USER_IDENTITY_REPLACED`, `ORGANIZATION_SUSPENDED`, `ORGANIZATION_REACTIVATED`, `PROJECT_ARCHIVED`, `PROJECT_RESTORED`, `INSPECTION_PUBLISHED`, `INSPECTION_ARCHIVED`, `INSPECTION_RESTORED`, `REPORT_PUBLISHED`, `REPORT_REPLACED`, `REPORT_WITHDRAWN`, `ORGANIZATION_DOCUMENT_PUBLISHED`, `ORGANIZATION_DOCUMENT_REPLACED`, `ORG_MAPPING_CHANGED`, `ADMIN_IDENTITY_LINKED`, `ADMIN_AUTH_PROVIDER_CUTOVER`, and `METADATA_REFRESH_ACCEPTED`. Publication events include the approval-attestation statement version and summary digest. Record `REPORT_DOWNLOAD_LINK_ISSUED` or `ORGANIZATION_DOCUMENT_LINK_ISSUED` when an authorized URL is generated; it proves authorization and issuance, not that S3 delivered the object.

- Retain Audit-table records for six calendar months from `occurredAt`; a retention TTL may remove them only after that period and is not used for authorization. Enable deletion protection, point-in-time recovery, KMS encryption, and CloudTrail data events for Audit-table writes, updates, and deletes.
- Export the Audit table monthly to a dedicated private audit-archive S3 bucket with a separate KMS key, versioning, Block Public Access, and default 184-day S3 Object Lock governance retention. S3 Object Lock accepts whole-day retention, so 184 days ensures an export is not released before six calendar months. Only a separately controlled audit-reader role can read exports; application roles have no archive access.
- Alert on failed audit writes, failed monthly exports, and any attempted Audit-table `UpdateItem`, `DeleteItem`, or `BatchWriteItem`. Audit-export jobs use their own least-privilege role.

Enable CloudTrail S3 data events for writes and deletes on the published-report bucket. Client `GetObject` data events are deferred unless a contractual audit requirement justifies their additional cost.

## Recovery Objectives

- V1 has no contractual availability SLA and no multi-region architecture.
- Set the operational recovery-time objective to one business day.
- Set the recovery-point objective to one hour for the DynamoDB registry and audit data and for portal-published S3 artifacts.
- Enable DynamoDB point-in-time recovery, S3 versioning, retained production resources, and reproducible infrastructure as code. Maintain a restoration runbook covering registry, audit, published artifacts, configuration, and validation before traffic is restored.
- Restore into isolated resources and exercise the runbook before launch and every six months. Record the observed recovery point, elapsed recovery time, validation results, and corrective work.
- Cognito passwords, active sessions, and TOTP enrollments are outside the one-hour data RPO. A severe identity-system recovery may require administrators or clients to be reinvited, reset credentials, or reenroll TOTP; the runbook must state this explicitly.

## Accessibility and Browser Support

- Design desktop-first and support the latest two released versions of Chrome, Edge, Safari, and Firefox.
- Provide basic responsive behavior on mobile. PDF preview is best-effort on mobile and must fall back clearly to Download when the browser cannot render it reliably.
- Meet WCAG 2.2 AA for the core portal flows: login, project and inspection navigation, report status, How to Read access, preview, download, logout, and understandable error handling. Formal accessibility certification is outside v1.
- Verify full keyboard operation, visible focus, semantic headings and labels, sufficient contrast, status meaning that does not rely on color alone, usable 200% zoom, and screen-reader names for controls and status messages.
- Accessibility of the generated PDF contents is owned by the report-generation process and is outside the dashboard v1 commitment.

## Production Safeguards

- Enable DynamoDB point-in-time recovery, customer-managed KMS encryption, deletion protection, and retained production data resources.
- Enable S3 versioning, Block Public Access, KMS encryption, and the role, lifecycle, immutable-key, and signature-age policies defined above on the appropriate upload and published buckets.
- Configure API Gateway route/stage throttling as a best-effort protection against mistakes and basic abuse; do not treat throttling as a hard authorization or capacity boundary.
- Add structured request IDs and CloudWatch alarms for API 5xx responses, Lambda errors and throttles, DynamoDB throttles, failed publication operations, and future asynchronous import failures.
- The first-release upload and publication path is synchronous and does not use a dead-letter queue. Add a dead-letter queue or failure destination only when the future asynchronous ReportGen importer is implemented.
- Restrict CORS to exact required origins. The Client BFF is reached through the same-origin Netlify proxy; the Admin API is called by the CLI and does not require browser CORS in v1.
- Defer AWS WAF until traffic or threat evidence justifies it. Do not add VPC Lambda networking, RDS, or ECS for the portal.

## Required Verification

- Cross-organization access is denied for every client endpoint.
- Unit-test the report visibility policy as a denial matrix: inactive user, suspended organization, archived project, draft or archived inspection, missing Report, every non-`PUBLISHED` delivery status, missing `currentVersionId`, missing version record, non-verified version, mismatched hierarchy, missing object locator, and an unexpected immutable key all deny PDF access.
- Test the successful report predicate only when the user and organization are active; the project and inspection are active; the inspection publication state and report delivery status are `PUBLISHED`; and the exact current version is verified with its expected immutable S3 key and version ID.
- Unit-test the organization-document predicate independently: absent or draft How to Read, a foreign organization, stale version pointer, unverified version, or mismatched key denies access; a published current version succeeds without requiring any project or inspection.
- Verify every direct client resource route calls the appropriate centralized policy function and every collection route applies the corresponding ancestor and visibility predicate.
- Verify report metadata routes can return `EXPECTED`, `NOT_INCLUDED`, and `NOT_APPLICABLE` labels but none of those states can obtain a preview or download URL.
- Verify old report and organization-document versions cannot be selected through a client request and only the server-resolved `currentVersionId` reaches the signing service.
- Invalid or expired authentication returns `401`, an inactive authenticated user returns `403`, and every resource-visibility failure returns the same non-descriptive `404`.
- Verify no signing call or download-link audit event occurs after any failed predicate.
- CDK creates no global or local secondary indexes in the first release.
- Identity authorization uses only base-table strongly consistent reads; creating, disabling, or revoking an identity is reflected on the next authorization lookup without waiting for index propagation.
- Every client collection operation uses `Query` with `PK=ORG#{authenticatedOrganizationId}` and an entity-prefix condition. Client handlers never use `Scan`, the admin organization directory, or a browser-supplied partition key.
- Supplying a valid project, inspection, report type, document type, version, or upload-session identifier from another organization returns the same `404` as a missing resource.
- Creating a child beneath a missing, mismatched, archived, or foreign parent fails its transactional condition checks and writes no child or audit-success record.
- Attempts to update organization or parent ownership are rejected, and normal application roles cannot delete tenant records. No migration role or endpoint exists in v1. A future migration must validate both organizations, freeze mutations, revoke both organizations' sessions, obtain two distinct administrator approvals within 24 hours, create new destination IDs, archive the source, and preserve the mapping in audit history.
- The Client BFF IAM role cannot read `AdminControl` or audit history; its Session-table access is limited to its own client-session operations, and its Audit permission is append-only.
- Subject-wide session revocation uses the Session table's base subject partition and invalidates every unexpired session without relying on a GSI.
- A session item that remains in DynamoDB after `absoluteExpiresAt` is rejected on every BFF and Admin API request; TTL deletion timing never changes authorization.
- A client logout invalidates the local session even if Cognito revocation fails, clears the portal cookie, and sends the browser through Cognito `/logout` so a managed-login cookie cannot silently sign the user back in.
- A correctly signed, unexpired Cognito JWT is rejected after its AdminSession or profile is revoked. A Cognito-revoked token cannot bootstrap `POST /admin/auth/sessions`, and an `origin_jti` with a revoked tombstone cannot be registered again. Local JWT verification and Cognito revocation are never the sole immediate-revocation controls.
- No Cognito access or refresh token is readable from browser JavaScript, local storage, session storage, cookies exposed to JavaScript, application logs, or frontend network responses.
- OAuth state, PKCE, login callback, server-side refresh, session rotation, logout, expired-session, and revoked-user flows work through the Netlify `/bff/*` proxy.
- All client resource and report-access routes terminate in the Client BFF and call shared domain services directly; no separate public Client API or client JWT authorizer is deployed.
- Wrong-origin or missing-CSRF-header mutations fail, and forged browser authorization or identity headers are stripped.
- Client organization context always comes from the active `UserProfile`; changing an organization or resource identifier in a request never expands access.
- Multiple active client users can independently authenticate into the same organization, while every user remains bound to exactly one immutable organization membership.
- Missing and cross-organization resources produce the same client-visible `404` response.
- Client tokens cannot access admin routes or ReportGen operator routes.
- Portal administrator tokens cannot access portal client routes.
- Portal administrators must complete TOTP, while client-dashboard users are not required to enroll in MFA for the first release.
- Portal Admin Cognito users outside `bdr-admins` receive authorization failures from every `/admin/*` endpoint.
- The CLI and future ReportGen UI produce equivalent Admin API requests and state transitions from the shared contract; UI-specific fields are not accepted by backend domain operations.
- ReportGen identities are linked to existing administrators only through an explicit authenticated `adminId` migration; matching email addresses, names, usernames, or groups cannot link identities.
- The ReportGen authentication cutover is validated against unchanged Admin API handlers in a non-production or parallel test stage before production changes.
- After production cutover, ReportGen BFF and CLI access succeeds through ReportGen Cognito while every Portal Admin Cognito token is rejected. The temporary pool is removed only after the seven-day rollback window and successful administrator verification.
- Disabled or revoked users lose access on their next API request even when an unexpired access token exists.
- An admin request fails if the Cognito group, database role, active status, or TOTP enrollment check is absent or mismatched.
- A BDR administrator cannot receive privileged access before completing TOTP setup and cannot retain it after an MFA reset. Disabling, demoting, or revoking the last active administrator fails. Production may start with one active administrator only after the named-AWS-identity break-glass runbook is tested; recovery invalidates old sessions and TOTP, requires reenrollment, and creates the incident and audit records.
- Client access tokens expire after 15 minutes and refresh server-side without interrupting a valid seven-day BFF session. CLI tokens remain only in process memory.
- A newly created or imported inspection remains invisible while `publicationStatus=DRAFT`; an inspection with `lifecycleStatus=ARCHIVED` also remains absent from all client responses.
- Publishing an inspection is rejected until all four inspection report categories are explicitly classified and at least one report has passed the S3 integrity checks and is ready to publish.
- The CLI publication preview includes organization, building identity and address, project ID, scan date and building timezone, inspection ID, all classifications, filenames, and replacement status. Publication fails unless the operator confirms the exact project ID, affirms BDR approval, and submits the server-matching expected revision and approval-statement version; the audit stores the attestation and summary digest.
- How to Read is published once per organization through its own upload and publication transaction. Its absence does not block inspection publication, and it never appears as an inspection report category.
- Only active inspections with `publicationStatus=PUBLISHED` affect client project counts and latest-inspection ordering. A newer draft does not reveal its existence or displace the latest published inspection.
- `NOT_INCLUDED`, `NOT_APPLICABLE`, `EXPECTED`, and `PUBLISHED` render respectively as Not included, Not applicable, In preparation, and Available.
- Client views do not render report-version numbers, ETags, checksums, source paths, S3 keys, or version IDs. Direct presigned URLs are expected to expose the S3 hostname, opaque key, and S3 version in browser network tools.
- Archived projects or inspections hide their subtree without rewriting descendants. Restore preview reports how many descendants will reappear, restoration requires explicit confirmation, and only descendants whose stored publication state remains client-visible reappear. Clients have no archive actions, and individual reports are not archived in v1.
- Reports under a published inspection remain category records. Withdrawal can move `PUBLISHED` to `EXPECTED`, `NOT_INCLUDED`, or `NOT_APPLICABLE`, clears current access, and preserves version history; subsequent publication creates a new version.
- Repeated publication of the same `sourceScanId` does not create duplicate inspections.
- A replacement report or How to Read document updates the current version without removing earlier versions; superseded versions remain inaccessible to clients and retained internally.
- Publishing an expected report on an already-published inspection makes it available without republishing the inspection.
- A failed replacement keeps the earlier version current.
- Repeating Publish with the same `uploadSessionId` cannot create duplicate report versions.
- A second upload to an existing upload-session key fails with `412 Precondition Failed`; the CLI cannot upload directly to any published-bucket key.
- An expired upload URL cannot be reused. For an unexpired `UPLOADING` session with no object, the Admin API can issue a fresh URL for the same server-generated key and the CLI restarts the complete PUT.
- If the upload response is lost after S3 stored the complete object, recovery verifies the existing object's declared size and checksum, PDF metadata/header, and exact S3 `versionId`, then moves the session to `READY` without a second upload. A mismatched existing object fails the session and is never overwritten.
- Upload URL refresh is rejected for expired sessions and for sessions in `READY`, `PUBLISHING`, `PUBLISHED`, or `FAILED`; changing the declared file identity or target hierarchy requires a new upload session.
- The upload-presigner role cannot read either bucket or use the published KMS key; the Publisher role cannot generate client URLs; the client signer role cannot read the upload bucket, decrypt with its KMS key, or write either bucket.
- An object in `UPLOADING`, `READY`, `PUBLISHING`, or `FAILED` cannot be signed through any client route. Client signing is limited by IAM to the published-report bucket and by the applicable visibility predicate to a committed current ReportVersion or DocumentVersion.
- Publication copies the exact recorded upload-bucket S3 version. A changed source key or version, size mismatch, checksum mismatch, or destination-verification failure prevents the DynamoDB transaction.
- If copying succeeds but the DynamoDB transaction fails, no client record points to the destination object and the previous client-visible state remains unchanged. Reconciliation cannot remove an orphan until it proves that no ReportVersion or DocumentVersion references the exact S3 key and version.
- Upload-bucket objects and versions expire after seven days; published objects do not inherit this lifecycle.
- A non-published UploadSession whose source object has expired cannot publish and must be replaced with a new upload session; a published session retains its idempotency record.
- Concurrent replacements cannot silently overwrite one another.
- Client responses change to the new version immediately after publication, while previously issued links expire within five minutes.
- Empty files, files above the configured 100 MB default, incorrectly labeled files, non-PDF-header files, missing objects, or checksum-mismatched uploads cannot be published. Files exactly at the configured limit are accepted. Page count, PDF parsing, encryption detection, and malware scanning are intentionally absent from v1 tests.
- Failed or duplicate future export events do not expose partial packages.
- Expired preview and download links can be refreshed after reauthorization.
- Preview URLs return signed `Content-Type: application/pdf`, `Cache-Control: private, no-store`, and inline `Content-Disposition`; download URLs use the same type/cache policy with attachment disposition and a safe server-generated filename.
- Full View and Download GETs return their signed response headers. Preview `Range` GETs receive `206 Partial Content` with the stored PDF type and no-store metadata, and the site sends `Referrer-Policy: no-referrer`.
- A download URL that is accidentally generated with a longer application expiration is denied once its signature age exceeds five minutes.
- A shared presigned URL works only within its five-minute lifetime; the complete URL and its S3 identifiers never appear in application logs.
- S3 validation confirms both buckets have Block Public Access, disabled ACLs, KMS encryption, and versioning; only the upload bucket has seven-day expiry; and normal application roles cannot delete published object versions.
- Existing ReportGen operator workflows remain unchanged because its admin UI, authentication changes, and BFF are deferred. ReportGen downtime does not interrupt the client dashboard, CLI administration, or already-published report access.
- Development services have no access to production identities, data, or storage.
- The persistent development Netlify site deploys only `develop` against development AWS resources, while the production site deploys only `main` against production resources. Environment mappings, callback/logout URLs, cookies, and CORS cannot be retargeted between sites.
- Pending invitations expire after seven days based on server time. Resend rotates the temporary credential and expiry; accepted or cancelled invitations cannot be resent; case-variant duplicate emails are rejected through the normalized-email reservation.
- Cognito/Profile partial creation fails closed and is compensated, delivery failures have an explicit cancel/correct/reinvite path, password recovery uses Cognito Managed Login, and compromised accounts revoke sessions and replace identity only through an audited administrator action.
- Audit-event duplicate keys, updates, deletes, and batch overwrites are rejected. Audit writes participate in the related DynamoDB transaction where possible; records and monthly locked exports remain available for at least six months, and failed writes or exports raise alarms.
- Scan-date formatting uses the inspection's immutable building-timezone snapshot across daylight-saving boundaries and does not change with the viewer's timezone.
- The dashboard passes the supported-browser matrix and the stated WCAG 2.2 AA core-flow checks, including keyboard use, focus, 200% zoom, screen-reader labels, non-color status, and mobile download fallback.
- The isolated restoration drill meets the one-business-day RTO and validates the one-hour data RPO before launch and every six months; its record identifies Cognito recovery limitations separately.

## Implementation Order

1. Establish the dashboard TypeScript workspace, shared contracts, local tooling, and development configuration.
2. Implement the five-table DynamoDB key schema, centralized report and organization-document visibility predicates, tenant-bound access functions, invitation/email reservations, client and admin sessions, transactional parent checks, lifecycle/publication transitions, immutable timezone snapshots, and client/admin authorization rules before defining infrastructure.
3. Provision development Identity, Tenant Data, Admin Control, Session, and Audit tables without secondary indexes, plus client/admin Cognito pools, the Client BFF, Admin API, private upload and published-report buckets, and audit-archive bucket with CDK. Do not provision a separate Client API.
4. Implement Client BFF authorization-code/PKCE login, absolute-expiry enforcement, secure cookie sessions, server-side refresh, CSRF controls, local revocation, and browser Cognito logout. Implement AdminSession enforcement, last-administrator protection, and the sole-admin break-glass runbook for the CLI.
5. Implement the Portal Admin API and authenticated `portal-admin` CLI for organizations, invitation/recovery workflows, projects with required IANA timezones, inspections, four report delivery statuses, How to Read, project/inspection archive and restore previews, publication approval attestation, and the v1 prohibition on tenant reassignment.
6. Implement manual upload to the upload bucket with the configurable 100 MB default, full-file retry, lightweight PDF integrity checks, copy and destination verification, transactional publication, report and organization-document replacement, retained version history, preview, and download.
7. Build the client dashboard with organization-level How to Read, the latest published inspection dominant, previous published inspections below it, and the declared browser, responsive, and accessibility baseline.
8. Add append-only auditing, six-month retention, monthly locked audit exports, throttling, security headers, PITR, CloudTrail write/delete events, and alarms.
9. Create the development Netlify project on `develop`, bind it permanently to development AWS resources, and complete authorization and end-to-end validation.
10. Exercise isolated restore and sole-admin recovery runbooks, provision production AWS resources, create the production Netlify project on `main` with a permanent production mapping, promote the validated release, repeat acceptance checks, and onboard the first client without migrating development data.
11. Add the ReportGen administration UI and BFF against the unchanged Admin API contract, explicitly link ReportGen identities to existing `adminId` records, validate a parallel ReportGen-authorized stage, migrate the CLI, cut production to the ReportGen issuer, and retire the temporary Portal Admin Cognito pool after the rollback window.
12. Implement the ReportGen export service and automatic portal import as a later cross-repository phase.
