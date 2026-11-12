#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import { AwsManualReportPublication } from "../../../apps/services/src/operations/manual-report-publication-aws";
import { applyManualReports, manualReportManifestSchema, manualReportSnapshotSchema, manualReportSummary, previewManualReports } from "../../../apps/services/src/operations/manual-report-publication";
import { discoverSampleConfiguration } from "../../../apps/services/src/operations/sample-dashboard-aws";

function configureOperatorCredentials(): void {
  // AWS CLI login credentials are consumed in memory; never print/export them to a file.
  const raw: unknown = JSON.parse(execFileSync("aws", ["configure", "export-credentials", "--format", "process"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AWS_PAGER: "" },
  }));
  const credentials = z.object({ AccessKeyId: z.string().min(1), SecretAccessKey: z.string().min(1), SessionToken: z.string().optional() }).parse(raw);
  process.env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
  if (credentials.SessionToken) process.env.AWS_SESSION_TOKEN = credentials.SessionToken;
  else delete process.env.AWS_SESSION_TOKEN;
  // Use that exact exported identity for both SDK helpers and CLI discovery, even
  // when the installed SDK cannot read the operator's newer AWS login profile.
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_DEFAULT_PROFILE;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, snapshot: { type: "string" },
    region: { type: "string" }, apply: { type: "boolean", default: false }, help: { type: "boolean", default: false } }, strict: true, allowPositionals: false });
  if (values.help) {
    process.stdout.write("Preview: npm run publish-manual-reports --workspace @bdr/infrastructure -- --manifest PATH --snapshot PATH [--region us-east-1]\nApply/resume: npm run publish-manual-reports --workspace @bdr/infrastructure -- --snapshot PATH --apply\nPreview writes a private local snapshot only. Apply uploads and PUBLISHES reports to clients; it never sends invitations.\n");
    return;
  }
  if (!values.snapshot || values.apply && values.manifest || !values.apply && !values.manifest) throw new Error("Preview requires --manifest and --snapshot; apply accepts only the reviewed --snapshot and --apply");
  const snapshotPath = resolve(values.snapshot);
  if (!values.apply) {
    const manifestPath = resolve(values.manifest!);
    const manifest = manualReportManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    configureOperatorCredentials();
    const config = discoverSampleConfiguration("production", values.region ?? "us-east-1");
    const port = new AwsManualReportPublication(config);
    const snapshot = await previewManualReports(port, manifest, dirname(manifestPath));
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ readOnly: true, snapshot: snapshotPath, ...manualReportSummary(snapshot) }, null, 2)}\n`);
    return;
  }

  const lockPath = `${snapshotPath}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const snapshot = manualReportSnapshotSchema.parse(JSON.parse(await readFile(snapshotPath, "utf8")));
    if (values.region && values.region !== snapshot.context.region) throw new Error("Region differs from the reviewed snapshot");
    configureOperatorCredentials();
    const config = discoverSampleConfiguration("production", snapshot.context.region);
    const port = new AwsManualReportPublication(config);
    const checkpoint = async () => {
      const temporary = `${snapshotPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(manualReportSnapshotSchema.parse(snapshot), null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, snapshotPath);
    };
    process.stdout.write(`${JSON.stringify({ applying: true, ...manualReportSummary(snapshot) }, null, 2)}\n`);
    try {
      await applyManualReports(port, snapshot, checkpoint);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ ...manualReportSummary(snapshot), complete: false, snapshot: snapshotPath }, null, 2)}\n`);
      throw error;
    }
    process.stdout.write(`${JSON.stringify({ ...manualReportSummary(snapshot), complete: true, snapshot: snapshotPath }, null, 2)}\n`);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Manual publication stopped: ${error instanceof Error ? error.message : "Unknown failure"}\nIf apply started, reports may be partially published. Keep the SAME snapshot and inspect its checkpoints before retrying. Nothing is automatically deleted, rolled back, or emailed.\n`);
  process.exitCode = 1;
});
