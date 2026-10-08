#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { AwsSampleDashboard, discoverSampleConfiguration } from "../../../apps/services/src/operations/sample-dashboard-aws";
import { setupSampleDashboard } from "../../../apps/services/src/operations/sample-dashboard";

async function main() {
  const { values } = parseArgs({ options: {
    environment: { type: "string" }, region: { type: "string", default: "us-east-1" },
    "reports-dir": { type: "string", default: fileURLToPath(new URL("../../../sample-reports", import.meta.url)) },
    "client-email": { type: "string", multiple: true },
    apply: { type: "boolean", default: false }, "reset-existing-clients": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    process.stdout.write("Usage: npm run sample-dashboard:setup -- --environment development|production --client-email EMAIL [--client-email EMAIL] [--reports-dir PATH] [--region REGION] [--apply --reset-existing-clients]\nDefault: read-only preview. Apply sends Cognito invitations; reset replaces only the explicitly listed client accounts.\n");
    return;
  }
  if (values.environment !== "production" && values.environment !== "development") throw new Error("Provide --environment development|production");
  if (!values["client-email"]?.length) throw new Error("Provide at least one --client-email; no emails are embedded in the script");
  const config = discoverSampleConfiguration(values.environment, values.region ?? "us-east-1");
  const port = new AwsSampleDashboard(config);
  await port.verifyInvitationTemplate();
  await setupSampleDashboard(port, {
    apply: values.apply ?? false, resetExistingClients: values["reset-existing-clients"] ?? false,
    emails: values["client-email"], reportsDirectory: resolve(values["reports-dir"] ?? fileURLToPath(new URL("../../../sample-reports", import.meta.url))),
  });
}

main().catch((error: unknown) => {
  // AWS creation responses can contain a password. Never dump errors, arguments, or response objects.
  process.stderr.write(`Sample dashboard setup stopped: ${error instanceof Error ? error.message : "Unknown error"}\nReview the preview/checkpoint before retrying. No automatic rollback or invitation resend is performed.\n`);
  process.exitCode = 1;
});
