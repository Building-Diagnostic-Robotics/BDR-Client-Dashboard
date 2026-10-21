# Administrator Clients and Review rollout

This change separates the administrator directory from building discovery and makes Review completeness explicit. Implementation does not execute checks, deploy either application, or modify AWS records. The commands below are for the operator.

## Local validation

From the repository root:

```bash
npm run typecheck
npm run typecheck:e2e
npm run test --workspace @bdr/contracts
npm run test --workspace @bdr/services
npm run build
npm run test:e2e -- e2e/admin-performance.ui.spec.ts e2e/admin-review.ui.spec.ts e2e/projects-landing.ui.spec.ts --project=chromium --project=webkit
npm run test:e2e -- --project=chromium --project=webkit
```

The local browser tests mock BFF and artifact responses. They do not require a deployed backend, production credentials, or live reports. Coverage includes a directory that renders before counts finish, the two-request count limit, selected-client navigation, stale response cancellation, zero versus unavailable counts, partial Review results, retries, legacy report keys, conditional conflicts, notes, and report viewing. Service coverage exercises active organization ownership, physical-building counts, older pending inspections, bounded reads, and pagination failures.

## Rollout order

1. Deploy the development backend with the same CDK context and domain values used for its current stack. No infrastructure resource, IAM, environment variable, or data migration is added, but the Client BFF Lambda code must be deployed.
2. Deploy the development frontend against that backend. The new frontend requires the four `/bff/portal/admin/*` endpoints, so deploy backend first. Existing client and Organization tools routes retain their response formats.
3. Verify the administrator scenarios below. Development and production still share operational S3 data: use dedicated sample reports for approval or notes actions.
4. Deploy production backend first, then frontend, using the existing environment-specific deployment commands. Verify administrator and client access again.
5. Run the existing production client authentication suite after deployment:

```bash
npm run test:e2e:production -- --project=chromium --project=webkit
```

That suite establishes client authentication behavior; it does not cover live administrator Clients or Review. Perform the administrator checks separately.

## Administrator acceptance checks

- Clients cards list only explicitly linked ACTIVE organizations, including an organization with no buildings. Cards appear before building counts finish. Unknown counts say loading; failures say unavailable; only successful empty results say zero.
- Browser Network shows no global `/bff/portal/buildings` request from the administrator Clients page and at most two concurrent building-count requests. Opening a client cancels outstanding browser count requests and loads only that client's buildings. Cancellation does not guarantee cancellation of Lambda work already executing.
- Verify existing `?client=<linked-prefix>` bookmarks, client/building search, operational filters, and building navigation. Switch clients rapidly and confirm an earlier response cannot replace the selected client's buildings.
- A physical building with multiple attached inspections counts once. The directory count agrees with that client's unfiltered building list.
- Review includes a pending report on an older inspection, as well as the latest inspection, without duplicates. It excludes stale, client-visible, and non-awaiting reports.
- Check the local mocked failure cases before deployment: a failed queue read is an error, partial reads show an incomplete banner with successful rows retained, and only a complete successful empty result shows “Nothing waiting.”
- On dedicated sample data, View opens a fresh private access URL, Approve retains existing publication behavior, notes still work, and a conditional conflict keeps the row visible for refresh. Existing CSRF and authorization remain required.
- Confirm ordinary client sessions cannot call the new administrator routes, and client project loading and report delivery remain unchanged.

## Performance evidence

Compare directory time-to-cards and selected-client time-to-buildings before and after deployment using browser Network timings. Collect several cold and warm requests against the same clients; local mocks cannot establish production latency.

Client BFF logs emit `portal_admin_read` with `operation` (`clients`, `client_buildings`, `client_building_count`, `review`), `requestId`, `outcome` (`success`, `partial`, `error`), `durationMs`, `s3GetObjectCount`, `s3ListObjectCount`, `dynamoReadCount`, and `failedReadCount`. These counters are request-local and include retries. The directory should perform no S3 LIST requests or building-status reads. Review reads current status only, rather than full building enrichment. Its shared IO cap is four per request, not a global limit across all users or Lambda invocations.

Counts still compute the physical catalog in the background; this change reduces blocking work and limits concurrency, rather than introducing a persistent cache. Organization tools continues using its compatible legacy endpoint and may still be slower. ReportGen concurrency, writer-owned documents, bucket separation, notification email setup, and the rest of the deferred backlog are unaffected.
