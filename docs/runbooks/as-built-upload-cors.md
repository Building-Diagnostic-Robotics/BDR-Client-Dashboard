# As-Built Upload S3 CORS Configuration

## Overview
Portal administrators upload As-built drawings (PDF, PNG, JPEG up to 50 MB) directly from the dashboard to the operational S3 data bucket (`bdr-roofus-uploads`).

Because the browser directly issues an HTTP `PUT` request with custom headers to a cross-origin S3 presigned URL, the S3 data bucket must allow:
- **Methods**: `GET`, `HEAD`, `PUT`
- **Headers**: `*` (or `Range`, `Content-Type`, `x-amz-*`)
- **Origins**: `https://bdrdashboard.netlify.app`, `http://localhost:3000`, `http://127.0.0.1:3000`

The script `packages/infrastructure/bin/update-data-bucket-cors.ts` inspects the existing bucket CORS, preserves existing rules (such as ReportGen's CloudFront/localhost rules), updates or creates the dashboard rule (`BDRDashboardReportReads`), and applies it cleanly.

---

## 1. Preview (Dry Run)

Run the script without `--apply` to inspect the current rules and preview proposed changes:

```bash
npm run update-data-bucket-cors --workspace @bdr/infrastructure
```

Verify that:
1. Existing ReportGen rules for `https://d33mjy96xin247.cloudfront.net` are preserved intact.
2. The rule with ID `BDRDashboardReportReads` contains `PUT` in `AllowedMethods` and `*` in `AllowedHeaders`.
3. Expected dashboard origins (`https://bdrdashboard.netlify.app`, `http://localhost:3000`) are included in `AllowedOrigins`.

---

## 2. Apply CORS Configuration

To apply the changes to the S3 bucket:

```bash
npm run update-data-bucket-cors --workspace @bdr/infrastructure -- --apply
```

If you need to add custom deploy preview origins (e.g. Netlify preview URLs):

```bash
npm run update-data-bucket-cors --workspace @bdr/infrastructure -- --apply --origin "https://deploy-preview-123.netlify.app"
```

---

## 3. Verification

### Check via AWS CLI

```bash
aws s3api get-bucket-cors --bucket bdr-roofus-uploads --region us-east-1
```

Confirm `BDRDashboardReportReads` reflects:
```json
{
  "ID": "BDRDashboardReportReads",
  "AllowedHeaders": [
    "*"
  ],
  "AllowedMethods": [
    "GET",
    "HEAD",
    "PUT"
  ],
  "AllowedOrigins": [
    "https://bdrdashboard.netlify.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ],
  "ExposeHeaders": [
    "Content-Length",
    "Content-Type",
    "Content-Disposition",
    "ETag"
  ],
  "MaxAgeSeconds": 3600
}
```

### Preflight Test via curl

Test CORS preflight directly from terminal:

```bash
curl -X OPTIONS \
  -H "Origin: https://bdrdashboard.netlify.app" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type" \
  -I "https://bdr-roofus-uploads.s3.us-east-1.amazonaws.com"
```

Expected response headers:
```http
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://bdrdashboard.netlify.app
Access-Control-Allow-Methods: GET, HEAD, PUT
Access-Control-Allow-Headers: *
```
