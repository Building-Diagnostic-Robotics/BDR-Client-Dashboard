#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AuthenticationReconciliation, reconciliationRequestSchema, reconciliationSnapshotSchema } from "../../../apps/services/src/operations/authentication-reconciliation";
import { discoverSampleConfiguration } from "../../../apps/services/src/operations/sample-dashboard-aws";

async function main() {
  const { values } = parseArgs({ options: { environment: { type: "string" }, region: { type: "string", default: "us-east-1" }, request: { type: "string" }, snapshot: { type: "string" }, apply: { type: "boolean", default: false } }, strict: true });
  if ((values.environment !== "development" && values.environment !== "production") || !values.snapshot) throw new Error("Select --environment development|production and --snapshot PATH");
  if (values.apply && values.request || !values.apply && !values.request) throw new Error("Preview requires --request PATH; apply reads only the reviewed --snapshot PATH");
  const config = discoverSampleConfiguration(values.environment, values.region ?? "us-east-1");
  const repair = new AuthenticationReconciliation(config, DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.context.region })), new CognitoIdentityProviderClient({ region: config.context.region }));
  if (!values.apply) {
    const request = reconciliationRequestSchema.parse(JSON.parse(readFileSync(values.request!, "utf8")));
    const snapshot = await repair.preview(request);
    // Exclusive creation avoids replacing an earlier reviewed snapshot. Contains account data, never tokens/passwords.
    writeFileSync(values.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ readOnly: true, environment: request.environment, snapshot: values.snapshot, operationId: snapshot.operationId,
      preserveClient: { organizationId: request.client.keepOrganizationId, userId: request.client.keepUserId }, retireMemberships: request.client.retire,
      restoreAdministrator: request.restoreAdministrator ?? null, deletePendingAdministrators: request.deletePendingAdministrators,
      guardCountUnchanged: snapshot.data.guard.activeAdminCount, repairsApplied: false }, null, 2)}\n`);
    return;
  }
  const snapshot = reconciliationSnapshotSchema.parse(JSON.parse(readFileSync(values.snapshot, "utf8")));
  await repair.apply(snapshot);
  process.stdout.write(`${JSON.stringify({ environment: snapshot.request.environment, operationId: snapshot.operationId, repairsApplied: true, guardCountChanged: false }, null, 2)}\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`Authentication reconciliation stopped: ${error instanceof Error ? error.message : "Unknown failure"}. If apply had started, inspect audit/checkpoints and retry the SAME snapshot; do not assume rollback.\n`);
  process.exitCode = 1;
});
