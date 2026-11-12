import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { opaqueIdSchema, organizationSchema } from "@bdr/contracts";
import { z } from "zod";

export const MANUAL_REPORT_TYPES = ["ASSESSMENT", "EVIDENCE", "AS_BUILT"] as const;
export type ManualReportType = typeof MANUAL_REPORT_TYPES[number];
export type JsonRecord = Record<string, unknown>;
const jsonRecord = z.record(z.string(), z.unknown());
const reportPaths = z.object({ ASSESSMENT: z.string().min(1), EVIDENCE: z.string().min(1), AS_BUILT: z.string().min(1) }).strict();
export const manualReportManifestSchema = z.object({
  version: z.literal(1), environment: z.literal("production"), accountId: z.string().regex(/^\d{12}$/),
  organization: z.string().trim().min(1).max(200),
  buildings: z.array(z.object({ name: z.string().trim().min(1).max(200), sourceUri: z.string().min(1), reports: reportPaths }).strict()).min(1).max(2),
}).strict().refine((value) => new Set(value.buildings.map((building) => building.sourceUri.replace(/\/+$/, ""))).size === value.buildings.length, "Duplicate source URI");
export type ManualReportManifest = z.infer<typeof manualReportManifestSchema>;

const contextSchema = z.object({ environment: z.literal("production"), accountId: z.string().regex(/^\d{12}$/), region: z.string().min(1),
  bucket: z.string().min(1), tenantTable: z.string().min(1), auditTable: z.string().min(1), operatorArn: z.string().min(1) }).strict();
export type ManualReportContext = z.infer<typeof contextSchema>;
const fileSchema = z.object({ path: z.string().min(1), filename: z.string().min(1).max(240), sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  key: z.string().min(1), uploadId: z.string().nullable() }).strict();
export type ManualReportFile = z.infer<typeof fileSchema>;
const observationSchema = z.object({ organization: organizationSchema, linksETag: z.string().min(1), sourceFingerprint: z.string().min(1),
  status: z.object({ value: jsonRecord, eTag: z.string().nullable() }).strict(),
  catalog: jsonRecord.nullable(), claim: jsonRecord.nullable(), candidate: jsonRecord, inspectionId: opaqueIdSchema,
}).strict();
export type ManualReportObservation = z.infer<typeof observationSchema>;
const preparedSchema = z.object({ catalog: jsonRecord, status: jsonRecord, publishedAt: z.iso.datetime({ offset: true }) }).strict();
export type PreparedManualReports = z.infer<typeof preparedSchema>;
const targetSchema = z.object({ name: z.string().min(1), sourcePrefix: z.string().min(1), before: observationSchema,
  files: z.object({ ASSESSMENT: fileSchema, EVIDENCE: fileSchema, AS_BUILT: fileSchema }).strict(),
  prepared: preparedSchema.nullable(), catalogCommitted: z.boolean(), statusCommitted: z.boolean(), verified: z.boolean(),
}).strict();
export type ManualReportTarget = z.infer<typeof targetSchema>;
export const manualReportSnapshotSchema = z.object({
  version: z.literal(1), operationId: z.string().regex(/^manual_[a-f0-9]{32}$/), createdAt: z.iso.datetime({ offset: true }),
  context: contextSchema, manifest: manualReportManifestSchema, targets: z.array(targetSchema).min(1).max(2), complete: z.boolean(),
}).strict();
export type ManualReportSnapshot = z.infer<typeof manualReportSnapshotSchema>;

export function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
  return value;
}
export function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right)); }
export function jsonDigest(value: unknown): string {
  const json = JSON.stringify(ordered(value));
  if (typeof json !== "string") throw new Error("Cannot fingerprint a non-JSON value");
  return digest(json);
}

export function manualSourcePrefix(uri: string, bucket: string): string {
  // Do not parse '#' as a URL fragment: it is part of real Roofus object keys.
  const root = `s3://${bucket}/`;
  if (!uri.startsWith(root)) throw new Error("Source URI does not belong to the deployed operational bucket");
  const prefix = uri.slice(root.length).replace(/\/+$/, "");
  const parts = prefix.split("/");
  if (parts.length !== 4 || parts.some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f]/.test(part))) throw new Error("Expected a four-level source prefix");
  return `${prefix}/`;
}

export async function inspectManualReportFile(path: string, type: ManualReportType): Promise<Omit<ManualReportFile, "key" | "uploadId">> {
  const absolute = resolve(path); const info = await stat(absolute);
  const limit = (type === "AS_BUILT" ? 50 : 100) * 1024 * 1024;
  if (!info.isFile() || !info.size || info.size > limit) throw new Error(`Invalid file or size for ${type}: ${absolute}`);
  const bytes = await readFile(absolute);
  const pdf = bytes.subarray(0, 5).toString("ascii") === "%PDF-" && bytes.subarray(-4096).includes(Buffer.from("%%EOF"));
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  const contentType = pdf ? "application/pdf" : type === "AS_BUILT" && png ? "image/png" : type === "AS_BUILT" && jpeg ? "image/jpeg" : null;
  if (!contentType || bytes.length !== info.size) throw new Error(`Not a supported complete report file: ${absolute}`);
  return { path: absolute, filename: basename(absolute), sizeBytes: bytes.length, sha256: digest(bytes), contentType };
}

export interface ManualReportPort {
  context: ManualReportContext;
  observe(organizationName: string, prefix: string, name: string): Promise<ManualReportObservation>;
  assertCurrent(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void>;
  upload(snapshot: ManualReportSnapshot, file: ManualReportFile): Promise<void>;
  prepare(target: ManualReportTarget, operationId: string, publishedAt: string): Promise<PreparedManualReports>;
  commitCatalog(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void>;
  publishStatus(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void>;
  verify(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void>;
}

export async function previewManualReports(port: ManualReportPort, input: unknown, directory: string): Promise<ManualReportSnapshot> {
  const manifest = manualReportManifestSchema.parse(input);
  if (manifest.accountId !== port.context.accountId || manifest.environment !== port.context.environment) throw new Error("Manifest does not match the selected AWS account/environment");
  const operationId = `manual_${randomUUID().replaceAll("-", "")}`;
  const targets: ManualReportTarget[] = [];
  for (const building of manifest.buildings) {
    const sourcePrefix = manualSourcePrefix(building.sourceUri, port.context.bucket);
    const before = observationSchema.parse(await port.observe(manifest.organization, sourcePrefix, building.name));
    const buildingId = opaqueIdSchema.parse(before.candidate.buildingId);
    const files = {} as ManualReportTarget["files"];
    for (const type of MANUAL_REPORT_TYPES) {
      const file = await inspectManualReportFile(resolve(directory, building.reports[type]), type);
      const uploadId = type === "AS_BUILT" ? `upl_${randomUUID().replaceAll("-", "")}` : null;
      const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/png" ? "png" : "jpg";
      const key = type === "AS_BUILT"
        ? `reportgen_portal/as-built/${before.organization.organizationId}/${buildingId}/${before.inspectionId}/drafts/${uploadId}/as-built.${extension}`
        : `${sourcePrefix}reportgen/client_portal/versions/${operationId}/${type.toLowerCase()}.pdf`;
      files[type] = { ...file, key, uploadId };
    }
    targets.push({ name: building.name, sourcePrefix, before, files, prepared: null, catalogCommitted: false, statusCommitted: false, verified: false });
  }
  if (new Set(targets.map((target) => target.before.candidate.buildingId)).size !== targets.length) throw new Error("Two targets resolve to the same physical building; review the manifest");
  return manualReportSnapshotSchema.parse({ version: 1, operationId, createdAt: new Date().toISOString(), context: port.context, manifest, targets, complete: false });
}

/** No automatic rollback. Exact planned effects are recognized after a response/checkpoint failure. */
export async function applyManualReports(port: ManualReportPort, snapshot: ManualReportSnapshot, checkpoint: () => Promise<void>): Promise<void> {
  if (!sameJson(snapshot.context, port.context)) throw new Error("Snapshot resources/operator do not match the selected AWS context");
  if (snapshot.targets.length !== snapshot.manifest.buildings.length) throw new Error("Snapshot target count changed");
  for (const [index, target] of snapshot.targets.entries()) {
    const definition = snapshot.manifest.buildings[index]!;
    if (target.sourcePrefix !== manualSourcePrefix(definition.sourceUri, port.context.bucket) || target.name !== definition.name
      || target.before.organization.displayName !== snapshot.manifest.organization) throw new Error("Snapshot target does not match its reviewed manifest");
    for (const type of MANUAL_REPORT_TYPES) {
      const current = await inspectManualReportFile(target.files[type].path, type);
      const { key: _key, uploadId: _uploadId, ...reviewed } = target.files[type];
      if (!sameJson(current, reviewed)) throw new Error(`Report changed since preview: ${current.path}`);
      const file = target.files[type];
      const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/png" ? "png" : "jpg";
      const expectedKey = type === "AS_BUILT"
        ? `reportgen_portal/as-built/${target.before.organization.organizationId}/${opaqueIdSchema.parse(target.before.candidate.buildingId)}/${target.before.inspectionId}/drafts/${file.uploadId}/as-built.${extension}`
        : `${target.sourcePrefix}reportgen/client_portal/versions/${snapshot.operationId}/${type.toLowerCase()}.pdf`;
      if (file.key !== expectedKey || type === "AS_BUILT" && !/^upl_[a-f0-9]{32}$/.test(file.uploadId ?? "")
        || type !== "AS_BUILT" && file.uploadId !== null) throw new Error("Snapshot upload key was changed");
    }
    if (target.prepared && !sameJson(target.prepared, await port.prepare(target, snapshot.operationId, target.prepared.publishedAt))) throw new Error("Checkpoint publication candidate was changed");
    await port.assertCurrent(snapshot, target);
  }
  // Stage and verify ALL files before committing any client-visible pointers.
  for (const target of snapshot.targets) for (const type of MANUAL_REPORT_TYPES) await port.upload(snapshot, target.files[type]);
  for (const target of snapshot.targets) {
    if (!target.prepared) {
      target.prepared = await port.prepare(target, snapshot.operationId, new Date().toISOString());
      await checkpoint(); // Persist exact candidates before the first publication mutation.
    }
    await port.assertCurrent(snapshot, target);
    await port.commitCatalog(snapshot, target);
    target.catalogCommitted = true; await checkpoint();
    await port.publishStatus(snapshot, target);
    target.statusCommitted = true; await checkpoint();
    await port.verify(snapshot, target);
    target.verified = true; await checkpoint();
  }
  snapshot.complete = true; await checkpoint();
}

export function manualReportSummary(snapshot: ManualReportSnapshot) {
  return { operationId: snapshot.operationId, context: snapshot.context, organization: snapshot.manifest.organization, complete: snapshot.complete,
    buildings: snapshot.targets.map((target) => {
      const reports = jsonRecord.parse(target.before.status.value.reports ?? {});
      const inspections = z.array(z.object({ inspectionId: z.string(), asBuilt: z.unknown() })).parse(target.before.candidate.inspections);
      return { name: target.name, sourcePrefix: target.sourcePrefix,
        organizationId: target.before.organization.organizationId, buildingId: target.before.candidate.buildingId, inspectionId: target.before.inspectionId,
        existingBuilding: target.before.catalog !== null, replacesReports: MANUAL_REPORT_TYPES.filter((type) => type === "AS_BUILT"
          ? inspections.some((inspection) => inspection.inspectionId === target.before.inspectionId && Boolean(inspection.asBuilt))
          : Boolean(reports[type])),
        files: MANUAL_REPORT_TYPES.map((type) => ({ reportType: type, ...target.files[type] })),
        catalogCommitted: target.catalogCommitted, statusCommitted: target.statusCommitted, verified: target.verified };
    }) };
}
