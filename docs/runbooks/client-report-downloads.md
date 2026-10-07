# Client report downloads

Individual View and Download actions navigate to a freshly signed private S3 URL. Download all fetches those objects in the browser before creating a ZIP, so it also requires the **data bucket** to allow GET requests from the dashboard origin. The dashboard's CDK-created published bucket is a different bucket; its CORS rule does not cover shared ReportGen objects.

The diagnosed production data bucket allowed ReportGen and its local development origin, but excluded the dashboard origin. The live dashboard CSP already allowed the regional S3 host. Adding a narrow CORS rule resolves that cross-origin blocker; CORS does not grant object access, change bucket policies, or make reports public.

These are operator commands. They have not been applied by this implementation. Coordinate with the colleague who manages the shared bucket; `put-bucket-cors` replaces the whole configuration, so preserve existing rules and avoid concurrent changes. Do not add the dashboard origin to an existing PUT rule.

## 1. Resolve the deployed dashboard origin and data bucket

Use the intended AWS profile and verify the returned account before continuing. Stop if any command fails or a resolved value is empty or `None`.

```sh
export AWS_REGION="us-east-1"
export PORTAL_STACK="BdrClientPortal-production"
aws sts get-caller-identity

export PORTAL_REPORT_FUNCTION="$(aws cloudformation list-stack-resources \
  --stack-name "$PORTAL_STACK" --region "$AWS_REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId, 'ClientBffFunction')].PhysicalResourceId | [0]" \
  --output text)"

export PORTAL_REPORT_ORIGIN="$(aws lambda get-function-configuration \
  --function-name "$PORTAL_REPORT_FUNCTION" --region "$AWS_REGION" \
  --query 'Environment.Variables.PORTAL_ORIGIN' --output text)"

export PORTAL_REPORTS_BUCKET="$(aws lambda get-function-configuration \
  --function-name "$PORTAL_REPORT_FUNCTION" --region "$AWS_REGION" \
  --query 'Environment.Variables.DATA_BUCKET_NAME' --output text)"

node -e 'const origin = new URL(process.env.PORTAL_REPORT_ORIGIN); if (origin.protocol !== "https:" || origin.origin !== process.env.PORTAL_REPORT_ORIGIN || !process.env.PORTAL_REPORTS_BUCKET || process.env.PORTAL_REPORTS_BUCKET === "None") throw new Error("Invalid production origin or bucket"); console.log({origin: origin.origin, bucket: process.env.PORTAL_REPORTS_BUCKET});'
```

For development, use the development stack and its exact deployed frontend origin. The production instructions deliberately reject HTTP; approve a local-development rule separately if needed. Do not add wildcard origins or every Netlify preview host.

## 2. Back up and prepare an additive rule

```sh
export PORTAL_REPORT_CORS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bdr-report-cors.XXXXXX")"

aws s3api get-bucket-cors \
  --bucket "$PORTAL_REPORTS_BUCKET" --region "$AWS_REGION" \
  > "$PORTAL_REPORT_CORS_DIR/current.json"
```

Stop if the read fails. The diagnosed bucket already has CORS rules; do not interpret access or network errors as an empty configuration.

Prepare a candidate locally; this command does not write to AWS:

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const directory = process.env.PORTAL_REPORT_CORS_DIR;
const origin = new URL(process.env.PORTAL_REPORT_ORIGIN).origin;
const current = JSON.parse(readFileSync(`${directory}/current.json`, "utf8"));
if (!Array.isArray(current.CORSRules)) throw new Error("Missing CORSRules");
const id = "BDRDashboardReportReads";
const existing = current.CORSRules.filter(rule => rule.ID === id);
if (existing.length > 1) throw new Error("Duplicate dashboard rule IDs");
if (existing.some(rule => JSON.stringify([...rule.AllowedMethods].sort()) !== JSON.stringify(["GET", "HEAD"]))) {
  throw new Error("Existing dashboard rule needs manual review");
}
const rule = {
  ID: id,
  AllowedOrigins: [origin],
  AllowedMethods: ["GET", "HEAD"],
  AllowedHeaders: ["Range"],
  ExposeHeaders: ["Content-Length", "Content-Type", "Content-Disposition", "ETag"],
  MaxAgeSeconds: 300,
};
const CORSRules = existing.length
  ? current.CORSRules.map(previous => previous.ID === id
    ? { ...previous, AllowedOrigins: [...new Set([...previous.AllowedOrigins, origin])] }
    : previous)
  : [...current.CORSRules, rule];
if (CORSRules.length > 100) throw new Error("S3 CORS rule limit exceeded");
writeFileSync(`${directory}/proposed.json`, JSON.stringify({ ...current, CORSRules }, null, 2) + "\n");
NODE

diff -u "$PORTAL_REPORT_CORS_DIR/current.json" "$PORTAL_REPORT_CORS_DIR/proposed.json"
```

Review the diff. `diff` exits with status 1 when differences exist; that is expected. Existing ReportGen rules must be unchanged, and the dashboard addition must contain only GET/HEAD for the exact origin. Formatting-only differences are harmless. Keep the backup outside Git.

## 3. Apply the reviewed configuration

Re-read the configuration immediately before applying. If it changed, stop and regenerate the candidate from that newer configuration.

```sh
aws s3api get-bucket-cors \
  --bucket "$PORTAL_REPORTS_BUCKET" --region "$AWS_REGION" \
  > "$PORTAL_REPORT_CORS_DIR/latest.json"

node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const directory = process.env.PORTAL_REPORT_CORS_DIR;
const json = file => JSON.stringify(JSON.parse(readFileSync(`${directory}/${file}`, "utf8")));
if (json("current.json") !== json("latest.json")) throw new Error("CORS changed; stop and regenerate the candidate");
NODE
```

Only after that check succeeds and you have reviewed the candidate, apply it:

```sh
aws s3api put-bucket-cors \
  --bucket "$PORTAL_REPORTS_BUCKET" --region "$AWS_REGION" \
  --cors-configuration "file://$PORTAL_REPORT_CORS_DIR/proposed.json"

aws s3api get-bucket-cors \
  --bucket "$PORTAL_REPORTS_BUCKET" --region "$AWS_REGION"

curl -i -X OPTIONS "https://${PORTAL_REPORTS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/" \
  -H "Origin: $PORTAL_REPORT_ORIGIN" \
  -H 'Access-Control-Request-Method: GET'
```

Expect a successful preflight with `Access-Control-Allow-Origin` equal to the dashboard origin and allowed GET/HEAD methods. The private object still requires a valid signed URL. The last read/check is not an atomic lock; coordinate bucket ownership rather than allowing concurrent CORS writers.

Rollback requires reviewing the current configuration first: restore the saved `current.json` with the same `put-bucket-cors` command only if doing so will not overwrite someone else's newer rules.

## 4. Validate code, deploy, and check production

Run locally from the repository root (these commands do not apply CORS):

```sh
npm run typecheck --workspace @bdr/services
npm run test --workspace @bdr/services
npm run typecheck --workspace @bdr/web
npm run typecheck:e2e
npm run test:e2e -- e2e/catalog-download.ui.spec.ts e2e/report-format.ui.spec.ts e2e/building-detail.ui.spec.ts e2e/download-all.ui.spec.ts --project=chromium --project=webkit
npm run build
```

After validation, deploy the backend first and then the frontend through the existing deployment procedure. Apply the CORS addition separately. The production authentication suite does not exercise catalog ZIP contents; it is an additional session/tenant check, not proof that report downloads work.

Check a production client building in both browsers:

- View opens the current report in a new tab, with an opening message while authorization completes.
- Individual Download suggests `Building Name - Report Type.pdf`; an As-built image retains `.png` or `.jpg`.
- Download all includes every available report exactly once under the same filenames, without pending/not-included reports. Inspect the actual ZIP contents.
- Dates use the inspection timezone; uploads at least 48 hours old show the upload calendar date.
- If publication is removed or the report becomes stale, a new access request is denied. Previously signed URLs retain the existing maximum five-minute lifetime.
- Confirm ReportGen's existing upload/view workflow still works.

For failures, inspect the artifact-access HTTP status and the browser S3 request/CORS error separately. `portal_artifact_resolution` logs report type, outcome, source mode, and duration. Browser `portal_zip_download_failed` messages include failure stage and HTTP status where available. Do not share signed URLs, cookies, or credentials in diagnostics.
