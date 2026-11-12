# Client project loading and CSP compatibility

## Incident and implementation boundary

Production investigation found Client BFF invocations exhausting the deployed 256 MB allocation and returning HTTP 500. The client catalog called operational enrichment, including scan manifests; one inspected manifest was 35,612,592 bytes (about 34 MiB) before JSON decoding and object overhead. The browser's CSP eval warning was a separate likely Zod capability probe, not an explanation for the server's 500 response. The optional How to Read route returning 404 means no guide is published.

The implementation uses lean publication reads for catalog summaries and details, bounds nested reads to four IO operations per request, and configures Client BFF at 512 MB with the same 30-second timeout. Published report timestamps preserve their previous priority and optional metadata-only fallback. Administrative raw operational enrichment remains separate. Browser contracts disable Zod's eval probe without adding `unsafe-eval` or weakening validation. No data migration, report republishing, or ReportGen change is required.

No tests, builds, deployments, or AWS mutations are executed by this implementation. Production recovery must be verified after operator deployment; adding regression tests does not establish a passing result or measured memory reduction.

## Operator validation

From the repository root:

```bash
npm run typecheck
npm run typecheck:e2e
npm run test --workspace @bdr/contracts
npm run test --workspace @bdr/services
npm run test --workspace @bdr/infrastructure
npm run test:e2e -- --project=chromium --project=webkit
CLIENT_BFF_API_URL="" npm run build
PORTAL_E2E_SERVER=production npm run test:e2e -- e2e/csp.production.ui.spec.ts --project=chromium --project=webkit
```

The last command rebuilds the frontend from current sources and then starts `next start` on localhost:4300, allowing up to four minutes for build and startup. A failed frontend build prevents startup rather than running an old `.next` bundle. It does not deploy or use live client credentials. The separate workspace build must also pass: local mocked browser tests do not validate the backend build. Ordinary local tests use `next dev`; the production CSP tests intentionally run only with `PORTAL_E2E_SERVER=production`, since development permits eval. Stop any separately started server on port 4300 first; Playwright does not reuse an existing server.

Relevant regression coverage:

- `apps/services/src/portal/catalog-reads.test.ts`: multiple buildings and inspections, forbidden operational/manifest reads, shared concurrency, older published inspections, timestamp priority/HEAD fallback, organization isolation, unavailable reports, and failed reads after prior success.
- `packages/contracts/src/zod.test.ts`: browser-only JIT configuration and unchanged validation/server settings.
- `e2e/csp.production.ui.spec.ts`: valid projects render with enforced production CSP and no eval violations; invalid responses remain rejected; a missing guide does not become a projects error.
- Existing catalog artifact tests, BFF tests, and infrastructure tests retain artifact authorization and cover correlation headers and Client BFF's memory allocation.

## Rollout and acceptance

1. Review the diff and preserve unrelated operator-publication and organization-transfer work. Deploy the backend with existing environment-specific CDK commands; both Lambda code and the memory setting need deployment.
2. Deploy the frontend after the backend, using the existing coordinated deployment workflow or operator process. The CSP fix requires rebuilding the frontend, even though the CSP header itself is unchanged.
3. Repeatedly load projects and building details for the affected organization and a second isolated organization. Include initial/cold requests and repeated/warm requests. Verify latest/previous inspections, report dates, View, Download, and Download all.
4. Confirm ordinary clients still cannot retrieve another organization's building or unpublished artifacts. Do not change real client publication state to perform this check; use isolated sample accounts/data.
5. Verify the production BFF allocation is 512 MB and compare Lambda duration, `Max Memory Used`, and error reports. Confirm no new `Runtime.OutOfMemory` failures during the smoke window; do not declare recovery from a single successful retry.
6. Rerun the existing production authentication suite after deployment:

```bash
npm run test:e2e:production -- --project=chromium --project=webkit
```

That suite does not establish memory headroom under actual project data; the preceding production project/detail checks and Lambda metrics are also required.

If a red Projects unavailable card remains, capture the failed `/bff/portal/buildings` HTTP status, response error, timestamp, `x-request-id` when present, and API Gateway request ID. Handled 500 responses carry the matching log ID without internal error details. Runtime-generated errors may lack the application's correlation header. Never include session cookies, authorization headers, temporary passwords, or presigned artifact URLs in tickets or shared logs. Keep genuine backend failures visible rather than treating them as an empty project list or hiding them with retries.
