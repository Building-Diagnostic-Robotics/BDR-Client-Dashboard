import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commitPreparedPortalBuilding, portalBuildingWithAsBuilt, type StoredBuilding } from "../portal/catalog";
import type { SetupConfiguration } from "./sample-dashboard-aws";
import { AwsManualReportPublication } from "./manual-report-publication-aws";
import { digest, type ManualReportSnapshot, type ManualReportTarget } from "./manual-report-publication";

const org = "org_0123456789abcdef";
const prefix = "client/Roofus#0003/date/tower/";
const operationId = `manual_${"1".repeat(32)}`;
const uploadId = `upl_${"2".repeat(32)}`;
const buildingId = "pbl_0123456789abcdef01234567";
const inspectionId = "pin_0123456789abcdef01234567";
const now = "2026-11-12T12:00:00.000Z";
const bytes = Buffer.from("%PDF-1.7\nreport\n%%EOF\n");
const config: SetupConfiguration = { identityTable: "identity", sessionTable: "sessions", adminControlTable: "control", auditTable: "audit", adminPool: "admin", issuer: "https://issuer.example/client", context: {
  environment: "production", accountId: "123456789012", region: "us-east-1", bucket: "reports", tenantTable: "tenant", clientPool: "pool", clientPrefix: "client", organizationId: org,
  portalOrigin: "https://portal.example.com", operatorArn: "arn:aws:iam::123456789012:user/operator" } };
const record: StoredBuilding = { PK: `ORG#${org}`, SK: `PORTAL_BUILDING#${buildingId}`, entityType: "PORTAL_BUILDING", organizationId: org, buildingId,
  displayName: "Existing name", address: "100 Main St", engineerNames: "Engineer", clientVisible: true, revision: "rev_0123456789abcdef", createdAt: now, updatedAt: now,
  inspections: [{ inspectionId, sourceId: "src_0123456789abcdef01234567", sourcePrefix: prefix, includedSectionIds: [], scannedAt: null, uploadCompletedAt: null, timeZone: null,
    sourceFingerprint: "real-source", reportStatuses: { ASSESSMENT: "IN_PREPARATION", EVIDENCE: "IN_PREPARATION", AS_BUILT: "NOT_INCLUDED", ROOF_TAKEOFF: "NOT_INCLUDED", CAPITAL_PLANNING: "NOT_INCLUDED" }, asBuilt: null }] };
const temporary: string[] = [];
beforeEach(() => {
  for (const key of ["AWS_REGION", "AWS_DEFAULT_REGION", "DATA_BUCKET_NAME", "TENANT_DATA_TABLE_NAME", "AUDIT_TABLE_NAME"]) vi.stubEnv(key, process.env[key] ?? "");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))); temporary.length = 0; });

function fixture() {
  const port = new AwsManualReportPublication(config);
  const files = Object.fromEntries((["ASSESSMENT", "EVIDENCE", "AS_BUILT"] as const).map((type) => [type, {
    path: "/operator/report.pdf", filename: `${type}.pdf`, sizeBytes: bytes.length, sha256: digest(bytes), contentType: "application/pdf",
    uploadId: type === "AS_BUILT" ? uploadId : null,
    key: type === "AS_BUILT" ? `reportgen_portal/as-built/${org}/${buildingId}/${inspectionId}/drafts/${uploadId}/as-built.pdf`
      : `${prefix}reportgen/client_portal/versions/${operationId}/${type.toLowerCase()}.pdf`,
  }])) as ManualReportTarget["files"];
  const status = { released: true, mapReady: false, customMetadata: "retain", reports: {
    ASSESSMENT: { approvedKey: `${prefix}reportgen/client_portal/old-assessment.pdf`, reportgenApprovedAt: "2026-01-01T00:00:00Z", clientVisible: true },
    CAPITAL_PLAN: { stale: false, clientVisible: false },
  }, history: [{ key: "previous-file", reportType: "EVIDENCE" }] };
  const target: ManualReportTarget = { name: "New input name", sourcePrefix: prefix, before: {
    organization: { organizationId: org, displayName: "Client", status: "ACTIVE" }, linksETag: "links", sourceFingerprint: "fingerprint", inspectionId,
    status: { value: status, eTag: '"before"' }, catalog: structuredClone(record), candidate: structuredClone(record), claim: null,
  }, files, prepared: null, catalogCommitted: false, statusCommitted: false, verified: false };
  const snapshot: ManualReportSnapshot = { version: 1, operationId, createdAt: now, context: port.context,
    manifest: { version: 1, accountId: port.context.accountId, environment: "production", organization: "Client", buildings: [{ name: target.name, sourceUri: `s3://reports/${prefix}`,
      reports: { ASSESSMENT: "a.pdf", EVIDENCE: "e.pdf", AS_BUILT: "b.pdf" } }] }, targets: [target], complete: false };
  return { port, snapshot, target };
}

it("prepares only the chosen inspection and report types, retaining other metadata and old immutable references", async () => {
  const { port, target } = fixture();
  const prepared = await port.prepare(target, operationId, now);
  expect(prepared.catalog).toMatchObject({ displayName: record.displayName, address: record.address, engineerNames: record.engineerNames });
  expect(prepared.status).toMatchObject({ customMetadata: "retain", mapReady: false, reports: { CAPITAL_PLAN: { stale: false, clientVisible: false }, ASSESSMENT: { generatedAt: now, stale: false, clientVisible: true, awaitingClientAdmin: false } } });
  const assessment = (prepared.status.reports as Record<string, Record<string, unknown>>).ASSESSMENT!;
  expect(assessment.reportgenApprovedAt).toBeUndefined();
  expect(prepared.status.history).toEqual(expect.arrayContaining([expect.objectContaining({ key: "previous-file" }), expect.objectContaining({ key: `${prefix}reportgen/client_portal/old-assessment.pdf` })]));
  expect(prepared.catalog.inspections).toEqual([expect.objectContaining({ sourceFingerprint: "real-source", asBuilt: expect.objectContaining({ key: target.files.AS_BUILT.key, publishedAt: now }) })]);
  expect(await port.prepare(target, operationId, now)).toEqual(prepared);
});

it("uses conditional immutable uploads with a server-verified checksum and resumes a lost PUT response", async () => {
  const { port, target, snapshot } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "manual-upload-")); temporary.push(directory);
  const file = { ...target.files.ASSESSMENT, path: join(directory, "report.pdf") }; await writeFile(file.path, bytes);
  let exists = false;
  const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof HeadObjectCommand) {
      if (!exists) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return { ContentLength: file.sizeBytes, ContentType: file.contentType, ChecksumSHA256: Buffer.from(file.sha256, "hex").toString("base64"), Metadata: { "manual-publication-id": operationId } } as never;
    }
    if (command instanceof PutObjectCommand) {
      expect(command.input.IfNoneMatch).toBe("*");
      expect(command.input.ChecksumSHA256).toBe(Buffer.from(file.sha256, "hex").toString("base64"));
      exists = true; throw new Error("PUT response lost");
    }
    throw new Error("Unexpected operation");
  });
  await expect(port.upload(snapshot, file)).rejects.toThrow("PUT response lost");
  await expect(port.upload(snapshot, file)).resolves.toBeUndefined();
  expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
});

it.each(["wrong-checksum", "missing-checksum", "wrong-owner"])("refuses an existing object with %s rather than overwriting it", async (fault) => {
  const { port, snapshot, target } = fixture(); const file = target.files.ASSESSMENT;
  const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ ContentLength: file.sizeBytes, ContentType: file.contentType,
    ...(fault !== "missing-checksum" ? { ChecksumSHA256: fault === "wrong-checksum" ? "wrong" : Buffer.from(file.sha256, "hex").toString("base64") } : {}),
    Metadata: { "manual-publication-id": fault === "wrong-owner" ? "another-run" : operationId } } as never);
  await expect(port.upload(snapshot, file)).rejects.toThrow("differs");
  expect(send.mock.calls.every(([command]) => command instanceof HeadObjectCommand)).toBe(true);
});

it("fails closed on ambiguous organization links before reading or changing tenant records", async () => {
  const { port } = fixture();
  const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected operation");
    return { ETag: "links", Body: { transformToString: async () => JSON.stringify({ organizations: [
      { organizationId: org, displayName: "Client", clientPrefixes: ["client"] },
      { organizationId: "org_other_0123456789", displayName: "Another client", clientPrefixes: ["client"] },
    ] }) } } as never;
  });
  const dynamo = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockRejectedValue(new Error("Unexpected DynamoDB request"));
  await expect(port.observe("Client", prefix, "Tower")).rejects.toThrow("ambiguous");
  expect(send).toHaveBeenCalledTimes(1); expect(dynamo).not.toHaveBeenCalled();
});

it("keeps ETag protection on status publication and does not duplicate its audit event on retry", async () => {
  const { port, snapshot, target } = fixture(); target.prepared = await port.prepare(target, operationId, now);
  vi.spyOn(port, "assertCurrent").mockResolvedValue(undefined);
  let status = structuredClone(target.before.status.value); let eTag = target.before.status.eTag;
  const s3 = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof GetObjectCommand) return { ETag: eTag, Body: { transformToString: async () => JSON.stringify(status) } } as never;
    if (command instanceof PutObjectCommand) {
      expect(command.input.IfMatch).toBe('"before"'); status = JSON.parse(String(command.input.Body)) as Record<string, unknown>; eTag = '"after"'; return {} as never;
    }
    throw new Error("Unexpected operation");
  });
  let audit: Record<string, unknown> | undefined;
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof PutCommand) {
      if (audit) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      audit = command.input.Item; return {} as never;
    }
    if (command instanceof GetCommand) return { Item: audit } as never;
    throw new Error("Unexpected operation");
  });
  await port.publishStatus(snapshot, target); await port.publishStatus(snapshot, target);
  expect(s3.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
  expect(audit).toMatchObject({ action: "MANUAL_REPORTS_PUBLISHED", actorId: config.context.operatorArn, requestId: operationId });
});

it("rejects a changed status ETag and invalid As-built ownership before publication", async () => {
  const { port, snapshot, target } = fixture(); target.prepared = await port.prepare(target, operationId, now);
  vi.spyOn(port, "assertCurrent").mockResolvedValue(undefined);
  const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ ETag: '"external"', Body: { transformToString: async () => JSON.stringify(target.before.status.value) } } as never);
  await expect(port.publishStatus(snapshot, target)).rejects.toThrow("Status changed");
  expect(send.mock.calls.every(([command]) => command instanceof GetObjectCommand)).toBe(true);
  expect(() => portalBuildingWithAsBuilt(record, inspectionId, { ...target.files.AS_BUILT, uploadId, key: "other-organization/as-built.pdf" }, now)).toThrow("invalid_request");
});

it("recognizes exact committed effects after a lost checkpoint but rejects external catalog or claim changes", async () => {
  const { port, snapshot, target } = fixture();
  target.before.catalog = null;
  target.prepared = await port.prepare(target, operationId, now);
  const claim = { PK: `PORTAL_SOURCE#${digest(prefix.replace(/\/$/, ""))}`, SK: "CLAIM", entityType: "PORTAL_SOURCE",
    organizationId: org, buildingId, inspectionId, sourceId: record.inspections[0]!.sourceId, sourcePrefix: prefix };
  const current = { ...structuredClone(target.before), catalog: target.prepared.catalog, candidate: target.prepared.catalog, claim,
    status: { value: target.prepared.status, eTag: '"published"' } };
  vi.spyOn(port, "observe").mockResolvedValue(current);
  await expect(port.assertCurrent(snapshot, target)).resolves.toBeUndefined();
  expect(target.catalogCommitted).toBe(true); expect(target.statusCommitted).toBe(true);
  current.claim = { ...claim, organizationId: "org_other_0123456789" };
  await expect(port.assertCurrent(snapshot, target)).rejects.toThrow("Source claim changed");
  current.claim = claim; current.catalog = { ...target.prepared.catalog, address: "External change" };
  await expect(port.assertCurrent(snapshot, target)).rejects.toThrow("Catalog changed outside");
});

it("does not recreate a removed published file or adopt a reverted catalog", async () => {
  const { port, target, snapshot } = fixture(); target.prepared = await port.prepare(target, operationId, now);
  target.catalogCommitted = true;
  const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValue(Object.assign(new Error("missing"), { name: "NotFound" }));
  await expect(port.upload(snapshot, target.files.ASSESSMENT)).rejects.toThrow("published object was removed");
  expect(send.mock.calls.every(([command]) => command instanceof HeadObjectCommand)).toBe(true);
  target.catalogCommitted = false;
  vi.spyOn(port, "observe").mockResolvedValue({ ...target.before, status: { value: target.prepared.status, eTag: '"after"' } });
  await expect(port.assertCurrent(snapshot, target)).rejects.toThrow("no matching catalog checkpoint");
});

it("registers a new building, exclusive source claim and audit atomically; existing updates retain revision checks", async () => {
  fixture(); // Configure the same tenant/audit tables as the operator workflow.
  const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
  const actor = { actorId: config.context.operatorArn, actorSub: config.context.operatorArn, requestId: operationId, action: "MANUAL_REPORT_CATALOG_PUBLISHED" };
  await commitPreparedPortalBuilding(record, null, actor, { buildingId, inspectionId });
  const first = send.mock.calls[0]![0];
  expect(first).toBeInstanceOf(TransactWriteCommand);
  if (!(first instanceof TransactWriteCommand)) throw new Error("Expected an atomic catalog transaction");
  expect(first.input.TransactItems).toHaveLength(3);
  expect(first.input.TransactItems?.every((item) => item.Put?.ConditionExpression === "attribute_not_exists(PK) AND attribute_not_exists(SK)")).toBe(true);
  expect(first.input.TransactItems?.[1]?.Put?.Item).toMatchObject({ organizationId: org, buildingId, inspectionId, sourcePrefix: prefix });
  await commitPreparedPortalBuilding({ ...record, revision: "rev_new_0123456789abcdef" }, record.revision, actor, { buildingId });
  const second = send.mock.calls[1]![0];
  if (!(second instanceof TransactWriteCommand)) throw new Error("Expected a conditional update transaction");
  expect(second.input.TransactItems?.[0]?.Put).toMatchObject({ ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": record.revision } });
  send.mockRejectedValueOnce(Object.assign(new Error("conditional conflict"), { name: "TransactionCanceledException" }));
  await expect(commitPreparedPortalBuilding(record, null, actor, { buildingId })).rejects.toMatchObject({ code: "CONFLICT" });
});
