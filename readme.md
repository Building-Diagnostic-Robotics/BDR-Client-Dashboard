# BDR Inspections Dashboard

BDR Inspections Dashboard is the secure client portal for Building Diagnostic Robotics. Clients can view their buildings, published inspection history, the organization-level How to Read guide, and current report PDFs.

V1 is complete. BDR staff currently use the TOTP-protected `portal-admin` CLI for organizations, users, projects, inspections, uploads, publication, replacement, and archive/restore. The next phase is an admin UI in the separate ReportGen application, using the existing Portal Admin API.

## Handoff documentation

- [Architecture](./docs/architecture.md)
- [API contracts](./docs/api-contracts.md)
- [Project layout](./docs/project_layout.md)
- [Current plan and roadmap](./plan.md)
- [Runbooks](./docs/runbooks/)

## Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

Live browser tests use dedicated test accounts in the Git-ignored `.env.e2e.local`; see [authentication testing](./docs/runbooks/authentication-testing.md).

## Administration CLI

Configure the CLI from the CloudFormation outputs of the matching environment:

```bash
export PORTAL_ADMIN_API_URL="https://example.execute-api.us-east-1.amazonaws.com"
export PORTAL_ADMIN_AUTH_DOMAIN="https://example.auth.us-east-1.amazoncognito.com"
export PORTAL_ADMIN_CLIENT_ID="..."
export PORTAL_ADMIN_CALLBACK_URL="http://127.0.0.1:8765/callback"
```

The CLI opens Portal Admin Cognito Managed Login and requires TOTP. It never stores credentials or tokens on disk. See the [production onboarding runbook](./docs/runbooks/production-client-onboarding.md) for the supported workflow.
