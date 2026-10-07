# Frontend

The client dashboard is `apps/web` (`@bdr/web`), a Next.js App Router application. Commit history: [CHANGELOG.md](../CHANGELOG.md). Netlify hosts the production build. The app has no AWS credentials and does not call Cognito, DynamoDB, or S3 itself. It calls same-origin `/bff/*` routes. In local and Netlify builds, `next.config.ts` rewrites those paths to `CLIENT_BFF_API_URL`.

## Run

From the repository root, `npm run dev` starts this app. The web workspace scripts are `dev`, `build`, `start`, and `typecheck`.

Set `CLIENT_BFF_API_URL` to the Client BFF origin when the API is not already being proxied by the host. Without it, `/bff/*` stays on the Next.js server and the dashboard cannot reach the API.

## Shell and sessions

`src/components/portal-shell.tsx` wraps authenticated pages. On load it calls `GET /bff/auth/session`, then `GET /bff/me`. A `401` sends the browser to `/sign-in` and keeps the current path as `returnTo`. Sign-out calls `POST /bff/logout` and follows the returned Cognito logout URL to `/logged-out`.

`src/lib/client-api.ts` is the only browser API helper. `getClient` and `postClient` send credentials, refuse cached responses, and parse the body with the schema passed by the caller. Posts read the CSRF cookie (`__Host-bdr_csrf`, or `bdr_csrf` outside that host-only form) and send it as `x-bdr-csrf`. `loginPath` only accepts a same-site relative return path.

The shell shows a different nav for portal administrators (`me.admin`): Clients, Review, Organization tools, and How to use. Clients see Projects and How to use. Exactly one item receives `aria-current="page"` and the active underline based on the current route.

## Routes

| Route | File | What it shows |
| --- | --- | --- |
| `/` | `src/app/page.tsx` | Redirects to `/projects`. |
| `/sign-in` | `src/app/sign-in/page.tsx` | Email and password form. Posts to `/bff/auth/password` and stays on the page for an authenticator code or a new password. |
| `/logged-out` | `src/app/logged-out/page.tsx` | Signed-out confirmation. |
| `/projects` | `src/app/projects/page.tsx` | Building list from `GET /bff/portal/buildings`. Clients search by building name or address; building cards load independently from the How to Read guide. Administrators pick a client first and retain the robot, report type, and scan-date filters. |
| `/projects/[projectId]` | `src/app/projects/[projectId]/` | Published inspection history from the registry APIs, including per-report view/download and download-all. |
| `/buildings` | `src/app/buildings/page.tsx` | Redirects to `/projects`. |
| `/buildings/view` | `src/app/buildings/view/page.tsx` and `catalog-building-view.tsx` | One physical building selected with opaque `?buildingId=`. It shows the latest inspection, collapsed previous inspections, and five fixed report rows with secure View, Download, and Download all actions. A loading skeleton remains until the complete detail response arrives. Authorized client bookmarks that still use `?prefix=` resolve server-side and redirect here. |
| `/map` | `src/app/map/page.tsx` | Legacy administrator operational view for a raw source prefix. It is not linked from the client building experience. |
| `/review` | `src/app/review/page.tsx` | Administrator queue of reports with `awaitingClientAdmin`, not stale, and not yet client-visible. Each row can view the PDF, approve it, or send notes. |
| `/admin-tools` | `src/app/admin-tools/page.tsx` | Create a client beside Add admin. Link a folder, rename it, and invite, resend, revoke, or replace client users. Add admin invites an administrator by email. |
| `/how-to` | `src/app/how-to/page.tsx` | Client instructions. |
| `/how-to/admin` | `src/app/how-to/admin/page.tsx` | Administrator instructions. |

`/projects` and `/buildings` get `PortalShell` from their layouts. `/map`, `/review`, `/admin-tools`, and `/how-to` render the shell inside the page.

Catalog report actions call `POST /bff/portal/artifact-access` with opaque building, inspection, and report-type identifiers. The BFF resolves the current approved S3 key and returns a short-lived URL; the browser never supplies an S3 key. Download all repeats that authorization for each currently available report and builds the ZIP in the browser. The legacy administrator screens still use `GET /bff/portal/file`.

## Shared UI

- `src/app/globals.css` holds shared dashboard styles; `src/app/buildings/view/building-detail.module.css` scopes the physical-building detail layout.
- `src/app/layout.tsx` sets the document title, the Inter font, and `no-referrer`.
- `src/components/artifact-actions.tsx` requests a five-minute view or download URL for registry or catalog reports and supports server-resolved request metadata.
- `src/components/icons.tsx` and `src/lib/format.ts` are presentational helpers.
- `src/app/projects/[projectId]/project-detail.tsx` builds the ZIP for download-all in the browser with `jszip` after each report access call succeeds.

Security headers are set in `next.config.ts`: a content security policy that allows the app and the private S3 hosts used by presigned URLs, `nosniff`, `DENY` framing, and a locked-down permissions policy. `connect-src` includes the S3 hosts because the browser downloads PDFs and map files from those URLs.

## What belongs in this app

Pages should render session-scoped data and send the CSRF header on writes. Authorization stays in the Client BFF. A new client-visible field needs a schema in `packages/contracts` when the registry API returns it. Building portal pages currently parse the JSON they need locally; prefer a shared contract when that response becomes stable.

Do not add Cognito client secrets, AWS keys, or direct use of portal table names to this workspace.
