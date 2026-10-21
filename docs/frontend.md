# Frontend

The client dashboard is `apps/web` (`@bdr/web`), a Next.js App Router application. Commit history: [CHANGELOG.md](../CHANGELOG.md). Audit status: [audit-findings.md](../audit-findings.md). Plan: [plan.md](../plan.md). Netlify hosts the production build. The app has no AWS credentials and does not call Cognito, DynamoDB, or S3 directly. It calls same-origin `/bff/*` routes. In local and Netlify builds, `next.config.ts` rewrites those paths to `CLIENT_BFF_API_URL`.

## Run

From the repository root, `npm run dev` starts this app. The web workspace scripts are `dev`, `build`, `start`, and `typecheck`.

Set `CLIENT_BFF_API_URL` to the Client BFF origin when the API is not already being proxied by the host. Without it, `/bff/*` stays on the Next.js server and the dashboard cannot reach the API.

## Shell and Sessions

`src/components/portal-shell.tsx` wraps authenticated pages. On load it calls `GET /bff/auth/session`, then `GET /bff/me`. A `401` sends the browser to `/sign-in` and keeps the current path as `returnTo`. Sign-out calls `POST /bff/logout` and follows the returned Cognito logout URL to `/logged-out`.

`src/lib/client-api.ts` is the browser API helper. `getClient` and `postClient` send credentials, refuse cached responses, and parse the body with the schema passed by the caller. Posts read the CSRF cookie (`__Host-bdr_csrf`, or `bdr_csrf` outside that host-only form) and send it as `x-bdr-csrf`. `loginPath` only accepts a same-site relative return path.

The shell shows a different nav for portal administrators (`me.admin`): Clients, Review, Organization tools, and How to use. Clients see Projects and How to use. Exactly one item receives `aria-current="page"` and the active underline based on the current route.

## Routes

| Route | File | What it shows |
| --- | --- | --- |
| `/` | `src/app/page.tsx` | Redirects to `/projects`. |
| `/sign-in` | `src/app/sign-in/page.tsx` | Unified sign-in card. Supports credentials, temporary password change, authenticator code (MFA), and password reset request/confirmation. |
| `/logged-out` | `src/app/logged-out/page.tsx` | Signed-out confirmation and sign-in entry. |
| `/projects` | `src/app/projects/page.tsx` | Building list from `GET /bff/portal/buildings`. Clients search by building name or address; building cards load with report timestamps, and the organization How to Read guide banner is displayed beneath the grid. Administrators load linked-client cards independently of asynchronous counts, then fetch only the selected client’s buildings and retain operational filters. |
| `/projects/[projectId]` | `src/app/projects/[projectId]/` | Published inspection history from the registry APIs, including per-report view/download and download-all. |
| `/buildings` | `src/app/buildings/page.tsx` | Redirects to `/projects`. |
| `/buildings/view` | `src/app/buildings/view/page.tsx` and `catalog-building-view.tsx` | One physical building selected with opaque `?buildingId=`. Shows latest inspection, collapsed previous inspections, and five fixed report rows (`ASSESSMENT`, `EVIDENCE`, `ROOF_TAKEOFF`, `AS_BUILT`, `CAPITAL_PLANNING`). Includes a loading skeleton, sanitized filenames, and rate-limited Download all (max 2 concurrent fetches). Legacy `?prefix=` bookmarks resolve server-side and redirect here. |
| `/map` | `src/app/map/page.tsx` | Legacy administrator operational view for a raw source prefix. Not linked from client experience. |
| `/review` | `src/app/review/page.tsx` | Administrator queue of reports awaiting review. Each row can view the PDF, approve it, or send notes. Uses a shared validated all-inspection response and explicit complete, incomplete, and error states. |
| `/admin-tools` | `src/app/admin-tools/page.tsx` | Link a client folder, rename clients, invite/resend/revoke/replace users, and invite administrators by email. |
| `/how-to` | `src/app/how-to/page.tsx` | Client instructions. |
| `/how-to/admin` | `src/app/how-to/admin/page.tsx` | Administrator instructions. |

## Report Actions and Contract Validation

- Client report actions call `POST /bff/portal/artifact-access` with opaque building, inspection, and report-type identifiers. The BFF resolves the approved S3 key server-side and returns a short-lived URL with sanitized `Building Name - Report Type.pdf` filenames. Raw S3 keys are rejected, and legacy `GET /bff/portal/file` returns `403` for client sessions.
- Download all fetches available reports with a maximum of 2 concurrent downloads, showing progress and building the ZIP in the browser with `jszip`.
- How to Read guide access uses `GET /bff/portal/how-to-read/current` and `POST /bff/portal/how-to-read/current/access`, resolving the organization guide strictly server-side.
- Client catalog routes (`/projects`, `/buildings/view`) validate API responses using shared Zod schemas from `@bdr/contracts` (`portalBuildingListResponseSchema`, `portalBuildingDetailSchema`, `portalBuildingIdResponseSchema`). Administrator directory, counts, selected buildings, Review, and Review action responses also use shared contracts.

## Shared UI and Styling

- `src/app/tokens.css` defines core design tokens (spacing, typography, radii, borders, semantic colors).
- `src/app/globals.css` holds shared dashboard styles; `src/app/buildings/view/building-detail.module.css` scopes physical-building detail layout.
- `src/components/` includes standardized UI primitives (`PageHeader`, `SectionHeader`, `SearchBar`, `EmptyState`, `ContentState`, `BuildingCard`, `HowToReadBanner`, `CountBadge`).
- Remaining visual polish (fine typography, spacing adjustments) is deliberately deferred.

Security headers in `next.config.ts` enforce Content Security Policy (CSP), `nosniff`, `DENY` framing, and locked-down permissions policies.

## Administrator loading behavior

Client cards include linked active organizations with zero buildings. Counts load in a separate queue of at most two requests, with an unavailable state and retry for failures. Opening a client cancels background count requests and prioritizes the selected catalog read. Existing `?client=` links resolve through the directory's linked prefixes; search, filters and building navigation remain available. Read cancellation and organization-tagged state prevent stale selection responses from rendering another client's buildings.

Review checks all inspections, including older ones awaiting approval. Successful rows remain usable if some sources fail; an incomplete banner offers retry. Only a fully successful empty response displays “Nothing waiting.” View requests a fresh URL; approval and notes retain CSRF and conditional-write handling. Both pages reuse shared loading, error, empty, heading and card components. See [operator validation commands](runbooks/admin-performance.md).
