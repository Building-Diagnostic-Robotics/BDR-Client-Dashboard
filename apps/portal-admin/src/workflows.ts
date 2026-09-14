import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";

import { publishInspectionRequestSchema, reportTypeSchema, uploadSessionResponseSchema, uploadSessionSchema, type UploadSession, type UploadTarget } from "@bdr/contracts";

import { PortalAdminClient } from "./client";

export function parseOptions(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Expected --name value, received ${key ?? "end of input"}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function pdfIdentity(path: string, maxBytes: number) {
  const details = await stat(path);
  if (!details.isFile() || details.size <= 0 || details.size > maxBytes) throw new Error(`PDF must be between 1 and ${maxBytes} bytes`);
  const handle = await open(path, "r");
  const header = Buffer.alloc(5);
  try { await handle.read(header, 0, 5, 0); } finally { await handle.close(); }
  if (header.toString("ascii") !== "%PDF-") throw new Error("File does not begin with %PDF-");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sizeBytes: details.size, sha256: hash.digest("hex"), originalFilename: basename(path) };
}

function uploadTarget(values: Record<string, string>): UploadTarget {
  const organizationId = required(values, "organization");
  if (values.document === "how-to-read") return { kind: "ORGANIZATION_DOCUMENT", organizationId, documentType: "HOW_TO_READ" };
  return {
    kind: "INSPECTION_REPORT",
    organizationId,
    projectId: required(values, "project"),
    inspectionId: required(values, "inspection"),
    reportType: reportTypeSchema.parse(required(values, "type")),
  };
}

export async function uploadPdf(client: PortalAdminClient, args: string[]) {
  const values = parseOptions(args);
  const path = required(values, "file");
  const target = uploadTarget(values);
  const identity = await pdfIdentity(path, Number(process.env.PORTAL_MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024));
  const idempotencyKey = values["idempotency-key"] ?? `upload_${randomUUID()}`;
  process.stderr.write(`Upload idempotency key: ${idempotencyKey}\n`);
  const created = uploadSessionResponseSchema.parse(await client.execute({
    method: "POST",
    path: `/admin/organizations/${target.organizationId}/upload-sessions`,
    idempotent: true,
    idempotencyKey,
    body: { target, ...identity, contentType: "application/pdf" },
  }));
  let upload = created;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (upload.uploadSession.state !== "UPLOADING") return upload.uploadSession;
    if (!upload.uploadUrl) throw new Error("Upload session returned no upload URL");
    try {
      const response = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.requiredHeaders, body: await readFile(path) });
      if (!response.ok) throw new Error(`S3 upload failed with ${response.status}`);
      return uploadSessionSchema.parse(await client.execute({ method: "POST", path: `/admin/organizations/${target.organizationId}/upload-sessions/${upload.uploadSession.uploadSessionId}/complete`, body: { target } }));
    } catch (error) {
      if (attempt === 1) throw error;
      upload = uploadSessionResponseSchema.parse(await client.execute({ method: "POST", path: `/admin/organizations/${target.organizationId}/upload-sessions/${upload.uploadSession.uploadSessionId}/upload-url`, body: { target } }));
    }
  }
  throw new Error("Upload failed");
}

async function confirmPublication(projectId: string | null): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (projectId) {
      const entered = await terminal.question(`Enter the exact project ID (${projectId}): `);
      if (entered !== projectId) throw new Error("Project confirmation did not match");
    }
    const approved = await terminal.question("Confirm normal BDR approval occurred by typing APPROVED: ");
    if (approved !== "APPROVED") throw new Error("BDR approval was not affirmed");
  } finally { terminal.close(); }
}

async function uploadStatus(client: PortalAdminClient, target: UploadTarget, uploadSessionId: string): Promise<UploadSession> {
  return uploadSessionSchema.parse(await client.execute({
    method: "POST",
    path: `/admin/organizations/${target.organizationId}/upload-sessions/${uploadSessionId}/status`,
    body: { target },
  }));
}

export async function publishInspection(client: PortalAdminClient, args: string[]) {
  const values = parseOptions(args);
  const organizationId = required(values, "organization");
  const projectId = required(values, "project");
  const inspectionId = required(values, "inspection");
  const [organization, project, inspection, reports] = await Promise.all([
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}` }),
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}/projects/${projectId}` }),
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}/projects/${projectId}/inspections/${inspectionId}` }),
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}/projects/${projectId}/inspections/${inspectionId}/reports` }),
  ]);
  const revision = (inspection as { revision?: unknown }).revision;
  const classifications: unknown = JSON.parse(await readFile(required(values, "classifications"), "utf8"));
  const request = publishInspectionRequestSchema.parse({ expectedRevision: revision, approvalConfirmed: true, approvalStatementVersion: "bdr-approval-v1", confirmedProjectId: projectId, classifications });
  const reportItems = (reports as { items?: Array<{ reportType: string; currentVersionId?: string | null }> }).items ?? [];
  const classified = await Promise.all(request.classifications.map(async (item) => {
    if (!item.uploadSessionId) return { ...item, sourceFilename: null, uploadState: null, replacement: false };
    const target: UploadTarget = { kind: "INSPECTION_REPORT", organizationId, projectId, inspectionId, reportType: item.reportType };
    const upload = await uploadStatus(client, target, item.uploadSessionId);
    return { ...item, sourceFilename: upload.originalFilename, uploadState: upload.state, replacement: Boolean(reportItems.find((report) => report.reportType === item.reportType)?.currentVersionId) };
  }));
  process.stderr.write(`${JSON.stringify({ organization, project, inspection, classifications: classified }, null, 2)}\n`);
  await confirmPublication(projectId);
  return client.execute({ method: "POST", path: `/admin/organizations/${organizationId}/projects/${projectId}/inspections/${inspectionId}/publish`, body: request });
}

export async function publishReport(client: PortalAdminClient, args: string[]) {
  const values = parseOptions(args);
  const organizationId = required(values, "organization");
  const projectId = required(values, "project");
  const inspectionId = required(values, "inspection");
  const reportType = required(values, "type");
  const [organization, project, inspection, reports] = await Promise.all([
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}` }),
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}/projects/${projectId}` }),
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}/projects/${projectId}/inspections/${inspectionId}` }),
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}/projects/${projectId}/inspections/${inspectionId}/reports` }),
  ]);
  const reportList = reports as { items?: Array<{ reportType: string; revision: string; currentVersionId?: string | null }> };
  const report = reportList.items?.find((item) => item.reportType === reportType);
  if (!report) throw new Error("Report category was not found");
  const uploadSessionId = required(values, "upload-session");
  const target: UploadTarget = { kind: "INSPECTION_REPORT", organizationId, projectId, inspectionId, reportType: reportTypeSchema.parse(reportType) };
  const upload = await uploadStatus(client, target, uploadSessionId);
  process.stderr.write(`${JSON.stringify({ organization, project, inspection, report, sourceFilename: upload.originalFilename, uploadState: upload.state, operation: report.currentVersionId ? "replacement" : "first publication" }, null, 2)}\n`);
  await confirmPublication(projectId);
  return client.execute({ method: "POST", path: `/admin/organizations/${organizationId}/projects/${projectId}/inspections/${inspectionId}/reports/${reportType}/publish`, body: { uploadSessionId, expectedRevision: report.revision, confirmedProjectId: projectId, approvalConfirmed: true, approvalStatementVersion: "bdr-approval-v1" } });
}

export async function publishHowToRead(client: PortalAdminClient, args: string[], replace: boolean) {
  const values = parseOptions(args);
  const organizationId = required(values, "organization");
  const [organization, document] = await Promise.all([
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}` }),
    client.execute({ method: "GET", path: `/admin/organizations/${organizationId}/documents/how-to-read` }),
  ]);
  const uploadSessionId = required(values, "upload-session");
  const target: UploadTarget = { kind: "ORGANIZATION_DOCUMENT", organizationId, documentType: "HOW_TO_READ" };
  const upload = await uploadStatus(client, target, uploadSessionId);
  process.stderr.write(`${JSON.stringify({ organization, document, sourceFilename: upload.originalFilename, uploadState: upload.state, operation: replace ? "replacement" : "first publication" }, null, 2)}\n`);
  await confirmPublication(null);
  return client.execute({ method: "POST", path: `/admin/organizations/${organizationId}/documents/how-to-read/${replace ? "replace" : "publish"}`, body: { uploadSessionId, expectedRevision: (document as { revision?: string }).revision, approvalConfirmed: true, approvalStatementVersion: "bdr-approval-v1" } });
}
