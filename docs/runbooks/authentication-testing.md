# Automated Authentication Tests

## Backend regression tests

```bash
npm run test --workspace @bdr/services -- src/auth/client.test.ts src/auth/primitives.test.ts src/client-bff.test.ts
npm run test --workspace @bdr/domain -- src/sessions.test.ts src/visibility.test.ts
```

These cover rejected callbacks, independent session verification, cookie preservation/rotation, explicit retry without loops, one-use state, expiration, revocation, CSRF, and tenant authorization.

## Local browser regression tests

```bash
npx playwright install chromium webkit
npm run test:e2e
```

This starts the real Next.js frontend on `http://localhost:4300` and intercepts its BFF requests with controlled fixtures. It checks the session revalidation handler for history restoration, logout, and account changes in Chromium and WebKit. A synthetic `pageshow` event makes restoration deterministic. This does not verify AWS, Cognito, or Netlify cookie delivery. WebKit is not an exact substitute for installed Safari.

## Configure live development browser tests

Deploy the updated development AWS stack. For a local dashboard, set `CLIENT_BFF_API_URL` in `apps/web/.env.local` to the development stack's `ClientBffApiUrl` and run `npm run dev`. Deploy development with `portalOrigin=http://localhost:3000` so Cognito uses the matching callback. Alternatively deploy the updated frontend to the dedicated development site.

Create two dedicated client accounts in different development organizations with distinct display names and at least one active building each. Complete their initial password changes before automated testing. Do not use production clients or administrator accounts.

```bash
cp .env.e2e.example .env.e2e.local
```

Edit `.env.e2e.local`:

```dotenv
PORTAL_E2E_ENVIRONMENT=development
PORTAL_E2E_BASE_URL=http://localhost:3000
PORTAL_E2E_AUTH_ORIGIN=https://YOUR-DEV-CLIENT-DOMAIN.auth.us-east-1.amazoncognito.com
PORTAL_E2E_CLIENT_EMAIL=first-test-client@example.com
PORTAL_E2E_CLIENT_PASSWORD=REPLACE_LOCALLY
PORTAL_E2E_OTHER_EMAIL=second-test-client@example.com
PORTAL_E2E_OTHER_PASSWORD=REPLACE_LOCALLY
```

Use the dashboard base origin, not a Cognito login link. Use the exact development client Cognito origin for `PORTAL_E2E_AUTH_ORIGIN`; credentials are entered only after that origin is checked. The credentials file is Git-ignored. Do not send passwords in chat or commit them.

## Run live development browser tests

```bash
npm run test:e2e:live
```

Tests require all configuration instead of silently skipping. They use isolated browser contexts, one worker, no retries, and no saved login state, screenshots, videos, or traces. They exercise fresh/remembered login, stale Cognito navigation, retry without a session, logout and old-cookie replay, two tabs, and account isolation against real Cognito/BFF/frontend services. They create and revoke development sessions; they do not invite users, publish reports, or modify clients/projects.

Run backend regressions on PRs and live browser tests after a development deployment. Keep browser artifacts private even though artifact directories are Git-ignored; any failure output containing browser URLs or request data must be treated as sensitive.

## Configure production smoke tests

Deploy the callback fixes to the production AWS stack and the updated frontend to Netlify first. Use two dedicated production client test accounts with permanent passwords, different organizations with distinct display names, and at least one active building each. Do not use administrator accounts or real customer accounts.

If `.env.e2e.local` already exists, edit it instead of overwriting credentials you want to keep. Otherwise:

```bash
cp .env.e2e.production.example .env.e2e.local
```

Fill the six blank account fields in `.env.e2e.local`: both emails, passwords, and the exact organization display names shown by the dashboard. The template already sets the production dashboard and client Cognito origins, `PORTAL_E2E_ENVIRONMENT=production`, and explicit `PORTAL_E2E_ALLOW_PRODUCTION=true`.

Production configuration only accepts the configured production portal/client Cognito origins. Each login checks the expected organization before subsequent logout/account tests. These checks confirm the configured target and organization; operators remain responsible for supplying only dedicated test accounts.

## Run production smoke tests

```bash
npx playwright install chromium webkit
npm run test:e2e:production
```

The same narrow authentication suite runs in isolated Chromium/WebKit contexts with one worker, zero retries, no saved sessions, and no screenshots, traces, or videos. It creates and revokes sessions for the configured test clients only. It does not modify organizations, users, projects, or reports. Configuration changes for these tests are local and do not themselves require an AWS or Netlify deployment.
