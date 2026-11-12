#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { ClientOrganizationTransfer, clientTransferRequestSchema, clientTransferSnapshotSchema } from "../../../apps/services/src/operations/client-organization-transfer";
import { discoverSampleConfiguration } from "../../../apps/services/src/operations/sample-dashboard-aws";

function configureOperatorCredentials() {
  // Bridge newer AWS CLI login profiles to the SDK without writing credentials to disk.
  const credentials = z.object({ AccessKeyId: z.string().min(1), SecretAccessKey: z.string().min(1), SessionToken: z.string().optional() }).parse(JSON.parse(execFileSync("aws", ["configure", "export-credentials", "--format", "process"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AWS_PAGER: "" },
  })));
  process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
  if (credentials.SessionToken) process.env.AWS_SESSION_TOKEN = credentials.SessionToken;
  else delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_DEFAULT_PROFILE;
}

async function main() {
  const { values } = parseArgs({ options: { environment: { type: "string" }, region: { type: "string", default: "us-east-1" },
    request: { type: "string" }, snapshot: { type: "string" }, apply: { type: "boolean", default: false }, "recover-lock": { type: "string" }, help: { type: "boolean", default: false } }, strict: true });
  if (values.help) {
    process.stdout.write("Preview: npm run transfer-client-organization --workspace @bdr/infrastructure -- --environment production --request PATH --snapshot PATH\nApply/resume: same command with --snapshot PATH --apply (no --request).\nRecovery only after stopping the crashed process: add --recover-lock RUN_ID.\nPreview reads AWS and writes a private local snapshot. Apply signs out the client and changes organization without resetting their password.\n");
    return;
  }
  if ((values.environment !== "development" && values.environment !== "production") || !values.snapshot) throw new Error("Select --environment development|production and --snapshot PATH");
  if (values.apply && values.request || !values.apply && !values.request || !values.apply && values["recover-lock"]) throw new Error("Preview requires --request; apply reads only the reviewed --snapshot");
  const snapshotPath = resolve(values.snapshot);
  configureOperatorCredentials();
  const config = discoverSampleConfiguration(values.environment, values.region ?? "us-east-1");
  const tool = new ClientOrganizationTransfer(config, DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.context.region })), new CognitoIdentityProviderClient({ region: config.context.region }));
  if (!values.apply) {
    const request = clientTransferRequestSchema.parse(JSON.parse(await readFile(resolve(values.request!), "utf8")));
    const snapshot = await tool.preview(request);
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ readOnly: true, snapshot: snapshotPath, operationId: snapshot.operationId,
      environment: request.environment, email: request.client.email, source: snapshot.data.organizations[0], destination: snapshot.data.organizations[1],
      existingSessions: snapshot.sessions.length, passwordPreserved: true, repairsApplied: false }, null, 2)}\n`);
    return;
  }
  const snapshot = clientTransferSnapshotSchema.parse(JSON.parse(await readFile(snapshotPath, "utf8")));
  await tool.apply(snapshot, values["recover-lock"]);
  process.stdout.write(`${JSON.stringify({ environment: snapshot.request.environment, operationId: snapshot.operationId, transferred: true,
    email: snapshot.request.client.email, targetOrganizationId: snapshot.request.client.targetOrganizationId, passwordPreserved: true, freshLoginRequired: true }, null, 2)}\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`Client transfer stopped: ${error instanceof Error ? error.message : "Unknown failure"}\nIf apply started, access may remain revoked/disabled or the transfer may already be recorded. Inspect checkpoints and retry the SAME snapshot. Do not create a replacement invitation or assume rollback.\n`);
  process.exitCode = 1;
});
