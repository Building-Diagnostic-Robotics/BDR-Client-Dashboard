# Manually publish Durafoam reports

Use this operator workflow for externally prepared Assessment/Evidence PDFs and As-built PDFs, PNGs, or JPEGs. Formatting does not need to match ReportGen. It publishes to the existing shared-building dashboard; no ReportGen run, new admin UI, AWS deployment, or Netlify deployment is required. It does not send invitations or notification emails.

The template selects **Durafoam Roofing**, **October 15 Gibraltar combined**, and **October 14 Ansys Zanker**. It does not combine other Gibraltar folders into another inspection. Building records and exclusive source claims are registered from actual source metadata when missing. No scan completion markers are fabricated. Existing catalog names, addresses, engineers, inspection groupings, and unrelated report classifications are preserved. New buildings use the names in the manifest, with Roof Takeoff and Capital Planning defaulting to Not included.

## Prepare six local files

Run from the repository root:

```bash
export PORTAL_MANUAL_DIR="$(pwd)/tmp/manual-reports"
mkdir -p "$PORTAL_MANUAL_DIR"
cp docs/examples/durafoam-manual-reports.json "$PORTAL_MANUAL_DIR/durafoam.json"
```

Edit `tmp/manual-reports/durafoam.json`: replace all six `/absolute/path/to/...` placeholders with your actual files. Paths may contain spaces. Relative file paths resolve against the manifest's directory. Use original local filenames freely; the stored Assessment and Evidence filenames are normalized for dashboard classification, and downloads retain the dashboard's friendly names. Assessment and Evidence are limited to 100 MiB each; As-built uses the existing 50 MiB limit. The script checks format signatures/end markers and hashes the bytes.

Confirm AWS operator access in the intended account; use `aws login` if the session expired:

```bash
aws sts get-caller-identity
```

The template pins account `767397717805`. The script discovers production resources from CloudFormation and the deployed Client BFF configuration, checks the manifest account against that discovery, and verifies active organization ownership and source claims. It consumes AWS CLI credentials in memory; credentials and presigned URLs are never written to the snapshot. Normal S3/DynamoDB operator permissions are required, including checksum-enabled HEAD and any applicable KMS decrypt permissions.

## Preview: read-only AWS operations

```bash
npm run publish-manual-reports --workspace @bdr/infrastructure -- \
  --manifest "$PORTAL_MANUAL_DIR/durafoam.json" \
  --snapshot "$PORTAL_MANUAL_DIR/durafoam.snapshot.json" \
  --region us-east-1
```

Review the printed organization, source prefixes, physical building/inspection IDs, existing-report replacements, local filenames, sizes, checksums, and destination keys. Preview creates a private local snapshot with exclusive creation and performs no AWS mutations. It will not replace an earlier snapshot. Keep snapshots under ignored `tmp/`; they contain operational identifiers, original publication state, and local paths. Do not commit them.

To change the reviewed input before applying, edit the manifest and use a NEW snapshot filename. Do not hand-edit snapshot contents.

## Apply: upload and publish

**This command makes reports visible to Durafoam users.** There is no additional approval click in ReportGen or the admin UI.

```bash
npm run publish-manual-reports --workspace @bdr/infrastructure -- \
  --snapshot "$PORTAL_MANUAL_DIR/durafoam.snapshot.json" \
  --apply
```

The script rechecks the operator, resources, ownership, current records, and all local file hashes. All six files are uploaded to unique private keys with `If-None-Match: *`, and their S3 SHA-256 checksums, content types, sizes, and operation ownership are verified before publication. No existing PDF is overwritten. Existing Assessment/Evidence references are retained in history, and the previous As-built reference is retained in the audit record and reviewed snapshot.

Publication uses conditional source claims/catalog revisions and S3 ETags. Missing portal status is initialized as unpublished. Catalog/As-built pointers are committed first, followed by Assessment/Evidence publication. These cross-service steps are **not atomic**: a later failure can leave As-built available before the other two reports, or one building complete before the other. No automatic rollback or deletion occurs.

The final `complete: true` means both selected inspections expose all three reports through the existing client catalog and artifact resolver, and both buildings appear in the client project list. It does not prove a browser downloaded the files. As a Durafoam client, check both buildings' View, Download, and Download all actions. If the selected inspection is older than another attached inspection, expand Previous inspections to find it.

## Resume and conflicts

If apply fails, keep the SAME snapshot and all six local files. Review its `catalogCommitted`, `statusCommitted`, and `verified` checkpoints and the reported error, then rerun the SAME apply command after resolving a transient failure. Exact planned writes and immutable objects are recognized even if a previous API response or local checkpoint was lost; the script does not create another building/version or duplicate the deterministic stage/publication audit events on that retry.

Changed files, source metadata, organization links, claims, or external catalog/status changes stop execution. A new AWS principal also requires a fresh reviewed preview. Do not generate a new snapshot blindly after a partially completed publication: inspect the affected records first to avoid unintentional report replacements. The output can understate a step whose response was lost; the next guarded run reconciles exact planned effects rather than assuming rollback.

A local `<snapshot>.lock` prevents simultaneous apply processes using the same file. Normal completion/failure releases it. After a process crash, confirm no process is still using that snapshot before removing only its `.lock` file. Do not copy snapshots to run concurrent publishers. New operations create new immutable keys; old files and unrelated reports are never automatically removed.

## Checks for the operator

Implementation does not execute these commands:

```bash
npm run typecheck --workspace @bdr/services
npm run typecheck --workspace @bdr/infrastructure
npm run test --workspace @bdr/services -- \
  src/operations/manual-report-publication.test.ts \
  src/operations/manual-report-publication-aws.test.ts \
  src/portal/catalog.test.ts
npm run test --workspace @bdr/services
npm run test --workspace @bdr/infrastructure
npm run build --workspace @bdr/services
npm run build --workspace @bdr/infrastructure
```

The focused suites mock AWS; they do not upload or publish real reports. Production execution remains an explicit operator action. The shared operational bucket is unchanged, and ReportGen's companion conditional-write contract remains a separate concern: avoid concurrent ReportGen publication while applying this manual delivery.
