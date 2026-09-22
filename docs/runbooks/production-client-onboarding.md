# Production Client Onboarding

Use this runbook only with production stack outputs. Development users, data, and buckets are isolated from production.

## Configure the CLI

Complete [first administrator bootstrap](./bootstrap-first-admin.md) once for the environment. Then set the CLI values from CloudFormation instead of copying endpoint values into shell history or documentation:

```bash
export AWS_REGION="us-east-1"
export PORTAL_STACK="BdrClientPortal-production"

export PORTAL_ADMIN_API_URL="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminApiUrl'].OutputValue | [0]" --output text)"
export PORTAL_ADMIN_AUTH_DOMAIN="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminAuthDomain'].OutputValue | [0]" --output text)"
export PORTAL_ADMIN_CLIENT_ID="$(aws cloudformation describe-stacks \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminCliClientId'].OutputValue | [0]" --output text)"
export PORTAL_ADMIN_CALLBACK_URL="http://127.0.0.1:8765/callback"
```

Each CLI command opens the administrator login and requires TOTP.

## Create an organization and invite a user

```bash
npm run cli --workspace @bdr/portal-admin -- organizations create \
  --name "Example Client"
```

Copy the returned ID as `org_x`, then invite the client:

```bash
npm run cli --workspace @bdr/portal-admin -- users invite \
  --organization org_x \
  --email client-contact@example.com
```

The recipient sets a permanent password from the Cognito invitation and signs in at the production dashboard URL. Do not use an administrator account as a client test account.

## Create a project and inspection

```bash
npm run cli --workspace @bdr/portal-admin -- projects create \
  --organization org_x \
  --name "Example Building" \
  --address "1 Main St, City, ST 12345" \
  --timezone "America/New_York"
```

Copy the returned ID as `project_x`.

```bash
npm run cli --workspace @bdr/portal-admin -- inspections create \
  --organization org_x \
  --project project_x \
  --scanned-at "2026-09-22T14:00:00-04:00"
```

Copy the returned ID as `inspection_x`. Use the building's local timezone and offset in `--scanned-at`.

## Upload and publish the first inspection

Run one upload command per PDF. The command returns only after the session is `READY`.

```bash
npm run cli --workspace @bdr/portal-admin -- uploads put \
  --organization org_x \
  --project project_x \
  --inspection inspection_x \
  --type ASSESSMENT \
  --file "/absolute/path/to/assessment.pdf"
```

Copy the returned upload session ID as `upload_assessment`. Create a classifications file that includes all four report types:

```json
[
  { "reportType": "ASSESSMENT", "deliveryStatus": "PUBLISHED", "uploadSessionId": "upload_assessment" },
  { "reportType": "EVIDENCE", "deliveryStatus": "EXPECTED", "uploadSessionId": null },
  { "reportType": "ROOF_TAKEOFF", "deliveryStatus": "NOT_INCLUDED", "uploadSessionId": null },
  { "reportType": "CAPITAL_PLANNING", "deliveryStatus": "NOT_APPLICABLE", "uploadSessionId": null }
]
```

Save it as `/absolute/path/to/classifications.json`, then publish:

```bash
npm run cli --workspace @bdr/portal-admin -- inspections publish \
  --organization org_x \
  --project project_x \
  --inspection inspection_x \
  --classifications "/absolute/path/to/classifications.json"
```

Confirm the exact project ID and type `APPROVED` when prompted. The inspection becomes client-visible only after this command succeeds.

## Publish or replace one report

Upload the new PDF with its report type, then publish it:

```bash
npm run cli --workspace @bdr/portal-admin -- uploads put \
  --organization org_x \
  --project project_x \
  --inspection inspection_x \
  --type EVIDENCE \
  --file "/absolute/path/to/evidence.pdf"

npm run cli --workspace @bdr/portal-admin -- reports publish \
  --organization org_x \
  --project project_x \
  --inspection inspection_x \
  --type EVIDENCE \
  --upload-session upload_evidence
```

Use the upload ID returned by the first command. If that report type already has a current version, this creates a replacement; it never overwrites the old PDF.

## Publish How to Read

```bash
npm run cli --workspace @bdr/portal-admin -- how-to-read init \
  --organization org_x

npm run cli --workspace @bdr/portal-admin -- uploads put \
  --organization org_x \
  --document how-to-read \
  --file "/absolute/path/to/how-to-read.pdf"

npm run cli --workspace @bdr/portal-admin -- how-to-read publish \
  --organization org_x \
  --upload-session upload_how_to_read
```

Use the upload ID returned by the second command. Use `how-to-read replace` after a subsequent upload when a published guide already exists.

## Archive and restore

Archive and restore require the revision returned by the preview and an exact resource-ID confirmation.

```bash
npm run cli --workspace @bdr/portal-admin -- inspections archive-preview \
  --organization org_x --project project_x --inspection inspection_x

npm run cli --workspace @bdr/portal-admin -- inspections archive \
  --organization org_x --project project_x --inspection inspection_x \
  --revision rev_x --reason "Superseded scan" --confirm inspection_x
```

Project archive/restore uses the equivalent `projects archive-preview`, `projects archive`, `projects restore-preview`, and `projects restore` commands. Archived content disappears from every client route but remains internally recoverable.
