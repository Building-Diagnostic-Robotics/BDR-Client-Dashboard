import { readFile } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { opaqueIdSchema, organizationSchema, portalAdminClientSchema, portalBuildingDetailSchema, portalPendingReportStatusSchema, portalReportTypeSchema } from "@bdr/contracts";
import { auditExpiresAt, auditKeys, tenantKeys } from "@bdr/domain";
import { z } from "zod";

import type { StoredBuilding } from "../portal/catalog";
import { isMissingS3Object, readJsonObject, writeJsonObject } from "../portal/json-state";
import type { SetupConfiguration } from "./sample-dashboard-aws";
import { digest, jsonDigest, MANUAL_REPORT_TYPES, sameJson,
  type JsonRecord, type ManualReportContext, type ManualReportFile, type ManualReportObservation,
  type ManualReportPort, type ManualReportSnapshot, type ManualReportTarget, type PreparedManualReports } from "./manual-report-publication";

const object = z.record(z.string(), z.unknown());
// Validate the stored shape at this operator boundary, while preserving additional fields.
const storedSchema = z.object({ PK: z.string(), SK: z.string(), entityType: z.literal("PORTAL_BUILDING"), organizationId: opaqueIdSchema,
  buildingId: opaqueIdSchema, displayName: z.string().min(1), address: z.string(), engineerNames: z.string(), clientVisible: z.boolean(),
  revision: opaqueIdSchema, createdAt: z.string(), updatedAt: z.string(),
  inspections: z.array(z.object({ inspectionId: opaqueIdSchema, sourceId: opaqueIdSchema, sourcePrefix: z.string().min(1),
    includedSectionIds: z.array(z.string()), scannedAt: z.string().nullable(), uploadCompletedAt: z.string().nullable(), timeZone: z.string().nullable(),
    reportStatuses: z.record(portalReportTypeSchema, portalPendingReportStatusSchema), sourceFingerprint: z.string(),
    asBuilt: z.object({ key: z.string(), filename: z.string(), contentType: z.string(), sizeBytes: z.number().int().positive(), publishedAt: z.string() }).passthrough().nullable(),
  }).passthrough()).min(1),
}).passthrough();
function stored(value: unknown): StoredBuilding { return storedSchema.parse(value); }
function conditionalFailure(error: unknown): boolean { return error instanceof Error && error.name === "ConditionalCheckFailedException"; }

export function manualStagedStatus(snapshot: ManualReportSnapshot, target: ManualReportTarget): JsonRecord {
  if (target.before.status.eTag !== null) return target.before.status.value;
  const building = stored(target.before.candidate);
  const inspection = building.inspections.find((row) => row.inspectionId === target.before.inspectionId)!;
  return { displayName: building.displayName, address: building.address, engineers: building.engineerNames ? [building.engineerNames] : [],
    scanTime: inspection.scannedAt, uploadTime: inspection.uploadCompletedAt, timeZone: inspection.timeZone,
    released: false, reports: {}, manualPublication: { operationId: snapshot.operationId, phase: "STAGED" } };
}

export class AwsManualReportPublication implements ManualReportPort {
  readonly context: ManualReportContext;
  private readonly s3: S3Client;
  private readonly document: DynamoDBDocumentClient;
  constructor(config: SetupConfiguration) {
    if (config.context.environment !== "production") throw new Error("This operator workflow is production-only");
    const { accountId, region, bucket, tenantTable, operatorArn } = config.context;
    this.context = { environment: "production", accountId, region, bucket, tenantTable, operatorArn, auditTable: config.auditTable };
    this.s3 = new S3Client({ region, maxAttempts: 1 });
    this.document = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 1 }));
    Object.assign(process.env, { AWS_REGION: region, AWS_DEFAULT_REGION: region, DATA_BUCKET_NAME: bucket,
      TENANT_DATA_TABLE_NAME: tenantTable, AUDIT_TABLE_NAME: config.auditTable });
  }
  private async get(table: string, key: { PK: string; SK: string }): Promise<JsonRecord | null> {
    return (await this.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item ?? null;
  }
  private statusKey(target: ManualReportTarget): string { return `${target.sourcePrefix}reportgen/client_portal/status.json`; }
  private claimKey(prefix: string) { return tenantKeys.portalSource(digest(prefix.replace(/\/$/, ""))); }

  async observe(organizationName: string, prefix: string, name: string): Promise<ManualReportObservation> {
    const links = await readJsonObject(this.s3, this.context.bucket, "reportgen_portal/org_links.json");
    if (!links.eTag) throw new Error("Organization links are missing");
    const organizations = z.array(object).parse(links.value.organizations).map((row) => portalAdminClientSchema.parse({
      organizationId: row.organizationId, displayName: row.displayName,
      clientPrefixes: z.array(z.string()).parse(row.clientPrefixes).map((root) => root.replace(/\/$/, "")),
    }));
    const matches = organizations.filter((row) => row.displayName === organizationName);
    const root = prefix.split("/")[0]!;
    if (matches.length !== 1 || !matches[0]!.clientPrefixes.includes(root)
      || organizations.some((row) => row.organizationId !== matches[0]!.organizationId && row.clientPrefixes.includes(root))) throw new Error("Source organization link is missing or ambiguous");
    const organizationId = matches[0]!.organizationId;
    const organization = organizationSchema.parse(await this.get(this.context.tenantTable, tenantKeys.organization(organizationId)));
    if (organization.organizationId !== organizationId || organization.status !== "ACTIVE" || organization.displayName !== organizationName) throw new Error("Organization is not active or its name changed");
    const sourceObjects = await this.s3.send(new ListObjectsV2Command({ Bucket: this.context.bucket, Prefix: prefix, MaxKeys: 1 }));
    if (!sourceObjects.Contents?.some((item) => item.Key?.startsWith(prefix))) throw new Error("The reviewed source folder does not exist");
    const status = await readJsonObject(this.s3, this.context.bucket, `${prefix}reportgen/client_portal/status.json`);
    if (status.value.buildingMark === "test_scan" || status.value.buildingMark === "no_report") throw new Error("Building is marked off; review its classification before publishing");
    const general = await readJsonObject(this.s3, this.context.bucket, `${prefix}general_data.json`);
    const claim = await this.get(this.context.tenantTable, this.claimKey(prefix));
    const catalog = await import("../portal/catalog");
    const portal = await import("../portal/buildings");
    if (claim && claim.organizationId !== organizationId) throw new Error("Source is already claimed by another organization");
    const buildingId = claim ? opaqueIdSchema.parse(claim.buildingId) : portal.provisionalPortalBuildingId(prefix);
    const current = await this.get(this.context.tenantTable, tenantKeys.portalBuilding(organizationId, buildingId));
    if (Boolean(current) !== Boolean(claim)) throw new Error("Catalog and source claim disagree; reconcile before publishing");
    const candidate = current ? stored(current) : await catalog.prepareManualPortalBuilding(organizationId, prefix, name);
    if (candidate.organizationId !== organizationId || candidate.buildingId !== buildingId
      || candidate.PK !== tenantKeys.portalBuilding(organizationId, buildingId).PK || candidate.SK !== tenantKeys.portalBuilding(organizationId, buildingId).SK) throw new Error("Stored building ownership is invalid");
    const inspections = candidate.inspections.filter((inspection) => inspection.sourcePrefix.replace(/\/$/, "") === prefix.replace(/\/$/, ""));
    if (inspections.length !== 1 || claim && (claim.inspectionId !== inspections[0]!.inspectionId || claim.sourceId !== inspections[0]!.sourceId)) throw new Error("Inspection ownership is missing or ambiguous");
    if (status.value.reports !== undefined) {
      const reports = object.parse(status.value.reports);
      for (const type of ["ASSESSMENT", "EVIDENCE"]) if (reports[type] != null) object.parse(reports[type]);
    }
    if (status.value.history !== undefined) z.array(z.unknown()).parse(status.value.history);
    const source = await portal.inspectPortalSource(prefix);
    if (inspections[0]!.sourceId !== source.sourceId) throw new Error("Stored source ID does not match its source prefix");
    return { organization, linksETag: links.eTag,
      sourceFingerprint: jsonDigest({ generalETag: general.eTag, sections: source.sections, timeZone: source.timeZone }),
      status, catalog: current, claim, candidate: object.parse(candidate), inspectionId: inspections[0]!.inspectionId };
  }

  async assertCurrent(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void> {
    const current = await this.observe(snapshot.manifest.organization, target.sourcePrefix, target.name);
    const before = target.before;
    if (current.linksETag !== before.linksETag || !sameJson(current.organization, before.organization)
      || current.sourceFingerprint !== before.sourceFingerprint || current.inspectionId !== before.inspectionId
      || current.candidate.buildingId !== before.candidate.buildingId || before.candidate.organizationId !== before.organization.organizationId) throw new Error(`Ownership or source metadata changed: ${target.name}`);
    const catalogIsBefore = sameJson(current.catalog, before.catalog);
    const catalogIsAfter = target.prepared !== null && sameJson(current.catalog, target.prepared.catalog);
    if (!catalogIsBefore && !catalogIsAfter) throw new Error(`Catalog changed outside this operation: ${target.name}`);
    if (before.catalog && !sameJson(before.catalog, before.candidate)) throw new Error("Reviewed catalog candidate was changed");
    if (!before.catalog && catalogIsBefore) {
      const stableCandidate = (value: JsonRecord) => { const { revision: _revision, createdAt: _created, updatedAt: _updated, ...stable } = value; return stable; };
      if (!sameJson(stableCandidate(before.candidate), stableCandidate(current.candidate))) throw new Error("Reviewed source candidate was changed");
    }
    const planned = target.prepared ? stored(target.prepared.catalog) : null;
    const inspection = planned?.inspections.find((row) => row.inspectionId === before.inspectionId);
    const expectedClaim = planned && inspection ? { ...this.claimKey(target.sourcePrefix), entityType: "PORTAL_SOURCE",
      organizationId: planned.organizationId, buildingId: planned.buildingId, inspectionId: inspection.inspectionId,
      sourceId: inspection.sourceId, sourcePrefix: inspection.sourcePrefix } : null;
    if (!sameJson(current.claim, before.claim) && !(catalogIsAfter && sameJson(current.claim, expectedClaim))) throw new Error(`Source claim changed: ${target.name}`);
    const statusIsBefore = current.status.eTag === before.status.eTag && sameJson(current.status.value, before.status.value);
    const statusIsStaged = before.status.eTag === null && sameJson(current.status.value, manualStagedStatus(snapshot, target));
    const statusIsAfter = target.prepared !== null && sameJson(current.status.value, target.prepared.status);
    if (!statusIsBefore && !statusIsStaged && !statusIsAfter) throw new Error(`Portal status changed outside this operation: ${target.name}`);
    if (statusIsAfter && !catalogIsAfter) throw new Error("Published status has no matching catalog checkpoint");
    if (target.catalogCommitted && !catalogIsAfter || target.statusCommitted && !statusIsAfter) throw new Error(`A committed publication was changed: ${target.name}`);
    // Reconcile exact writes whose response/checkpoint was lost, without adopting unrelated state.
    target.catalogCommitted ||= catalogIsAfter;
    target.statusCommitted ||= statusIsAfter;
  }

  private async verifyObject(snapshot: ManualReportSnapshot, file: ManualReportFile): Promise<boolean> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.context.bucket, Key: file.key, ChecksumMode: "ENABLED" }));
      if (head.ContentLength !== file.sizeBytes || head.ContentType !== file.contentType
        || head.ChecksumSHA256 !== Buffer.from(file.sha256, "hex").toString("base64")
        || head.Metadata?.["manual-publication-id"] !== snapshot.operationId) throw new Error(`Uploaded object differs from this operation: ${file.key}`);
      return true;
    } catch (error) { if (isMissingS3Object(error)) return false; throw error; }
  }
  async upload(snapshot: ManualReportSnapshot, file: ManualReportFile): Promise<void> {
    if (await this.verifyObject(snapshot, file)) return;
    if (snapshot.targets.some((target) => (target.catalogCommitted || target.statusCommitted || target.verified)
      && MANUAL_REPORT_TYPES.some((type) => target.files[type].key === file.key))) throw new Error(`A published object was removed; inspect before repairing: ${file.key}`);
    const bytes = await readFile(file.path);
    if (digest(bytes) !== file.sha256 || bytes.length !== file.sizeBytes) throw new Error(`Local file changed: ${file.path}`);
    await this.s3.send(new PutObjectCommand({ Bucket: this.context.bucket, Key: file.key, Body: bytes,
      ContentType: file.contentType, ChecksumSHA256: Buffer.from(file.sha256, "hex").toString("base64"),
      Metadata: { "manual-publication-id": snapshot.operationId, "manual-sha256": file.sha256 }, IfNoneMatch: "*" }));
    if (!await this.verifyObject(snapshot, file)) throw new Error(`Uploaded object is not readable: ${file.key}`);
  }

  async prepare(target: ManualReportTarget, operationId: string, publishedAt: string): Promise<PreparedManualReports> {
    // This pure preparation is shared with the regular As-built publication path.
    const candidate = stored(target.before.candidate);
    const asBuilt = target.files.AS_BUILT;
    const inspection = candidate.inspections.find((row) => row.inspectionId === target.before.inspectionId)!;
    const suffix = asBuilt.contentType === "application/pdf" ? "pdf" : asBuilt.contentType === "image/png" ? "png" : "jpg";
    const expectedAsBuiltKey = `reportgen_portal/as-built/${candidate.organizationId}/${candidate.buildingId}/${inspection.inspectionId}/drafts/${asBuilt.uploadId}/as-built.${suffix}`;
    if (asBuilt.key !== expectedAsBuiltKey || !/^upl_[a-f0-9]{32}$/.test(asBuilt.uploadId ?? "")) throw new Error("As-built key is not scoped to this inspection");
    const history = z.array(z.unknown()).parse(target.before.status.value.history ?? []).slice();
    const reports = { ...object.parse(target.before.status.value.reports ?? {}) };
    for (const type of ["ASSESSMENT", "EVIDENCE"] as const) {
      const file = target.files[type];
      if (file.contentType !== "application/pdf" || file.key !== `${target.sourcePrefix}reportgen/client_portal/versions/${operationId}/${type.toLowerCase()}.pdf`) throw new Error("Report key is outside its reviewed source");
      const previous = reports[type] == null ? {} : object.parse(reports[type]);
      if (typeof previous.approvedKey === "string" && previous.approvedKey !== file.key
        && !history.some((item) => item && typeof item === "object" && "key" in item && item.key === previous.approvedKey)) {
        history.push({ ...previous, reportType: type, key: previous.approvedKey, label: "Replaced", replacedAt: publishedAt });
      }
      const { reportgenApprovedAt: _oldReportGenDate, ...retained } = previous;
      reports[type] = { ...retained, sourceKey: file.key, approvedKey: file.key, generatedAt: publishedAt,
        clientApprovedAt: publishedAt, approvedAt: publishedAt, clientVisible: true, stale: false,
        awaitingClientAdmin: false, manualPublicationId: operationId };
    }
    const catalog = await import("../portal/catalog");
    const after = catalog.portalBuildingWithAsBuilt(structuredClone(candidate), inspection.inspectionId,
      { ...asBuilt, uploadId: asBuilt.uploadId! }, publishedAt);
    after.revision = `rev_${digest(`${operationId}:${target.sourcePrefix}`).slice(0, 32)}`; after.updatedAt = publishedAt;
    if (!target.before.catalog) after.createdAt = publishedAt;
    // Existing catalog metadata and classifications are deliberately retained.
    const baseStatus = target.before.status.eTag === null
      ? { displayName: candidate.displayName, address: candidate.address, engineers: candidate.engineerNames ? [candidate.engineerNames] : [],
        scanTime: inspection.scannedAt, uploadTime: inspection.uploadCompletedAt, timeZone: inspection.timeZone }
      : target.before.status.value;
    return { catalog: object.parse(after), publishedAt, status: { ...baseStatus, reports, history, released: true,
      updatedAt: publishedAt, manualPublication: { operationId, phase: "PUBLISHED", publishedAt } } };
  }

  private async audit(snapshot: ManualReportSnapshot, target: ManualReportTarget, stage: "STAGED" | "PUBLISHED"): Promise<void> {
    const occurredAt = target.prepared!.publishedAt;
    const eventId = `${snapshot.operationId}_${digest(target.sourcePrefix).slice(0, 16)}_${stage}`;
    const item = { ...auditKeys.organization(target.before.organization.organizationId, occurredAt, eventId), eventId, occurredAt,
      ttlExpiresAt: auditExpiresAt(occurredAt), action: `MANUAL_REPORTS_${stage}`, actorId: this.context.operatorArn,
      actorSub: this.context.operatorArn, requestId: snapshot.operationId,
      target: { organizationId: target.before.organization.organizationId, buildingId: target.before.candidate.buildingId, inspectionId: target.before.inspectionId, sourcePrefix: target.sourcePrefix },
      details: { environment: "production", reports: MANUAL_REPORT_TYPES.map((type) => ({ reportType: type, key: target.files[type].key, sha256: target.files[type].sha256 })),
        previousAsBuilt: stored(target.before.candidate).inspections.find((row) => row.inspectionId === target.before.inspectionId)?.asBuilt ?? null } };
    try {
      await this.document.send(new PutCommand({ TableName: this.context.auditTable, Item: item, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" }));
    } catch (error) {
      if (!conditionalFailure(error) || !sameJson(await this.get(this.context.auditTable, { PK: item.PK, SK: item.SK }), item)) throw error;
    }
  }
  async commitCatalog(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void> {
    if (!target.prepared) throw new Error("Publication candidates are not checkpointed");
    await this.assertCurrent(snapshot, target);
    for (const type of MANUAL_REPORT_TYPES) if (!await this.verifyObject(snapshot, target.files[type])) throw new Error("A staged object is missing");
    if (target.before.status.eTag === null) {
      const status = await readJsonObject(this.s3, this.context.bucket, this.statusKey(target));
      if (status.eTag === null) await writeJsonObject(this.s3, this.context.bucket, this.statusKey(target), manualStagedStatus(snapshot, target), null);
    }
    await this.audit(snapshot, target, "STAGED");
    const next = stored(target.prepared.catalog);
    const current = await this.get(this.context.tenantTable, tenantKeys.portalBuilding(next.organizationId, next.buildingId));
    if (sameJson(current, next)) return; // A prior commit succeeded but its response/checkpoint was lost.
    if (!sameJson(current, target.before.catalog)) throw new Error("Catalog changed before commit");
    const catalog = await import("../portal/catalog");
    // Apply the same key/type/size constraints as normal As-built publication.
    catalog.portalBuildingWithAsBuilt(stored(target.before.candidate), target.before.inspectionId,
      { ...target.files.AS_BUILT, uploadId: target.files.AS_BUILT.uploadId! }, target.prepared.publishedAt);
    await catalog.commitPreparedPortalBuilding(next, current ? stored(current).revision : null,
      { actorId: this.context.operatorArn, actorSub: this.context.operatorArn, requestId: snapshot.operationId, action: "MANUAL_REPORT_CATALOG_PUBLISHED" },
      { buildingId: next.buildingId, inspectionId: target.before.inspectionId });
  }
  async publishStatus(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void> {
    if (!target.prepared) throw new Error("Publication candidates are missing");
    await this.assertCurrent(snapshot, target);
    const current = await readJsonObject(this.s3, this.context.bucket, this.statusKey(target));
    if (!sameJson(current.value, target.prepared.status)) {
      const original = current.eTag === target.before.status.eTag && sameJson(current.value, target.before.status.value);
      const staged = target.before.status.eTag === null && sameJson(current.value, manualStagedStatus(snapshot, target));
      if (!original && !staged) throw new Error("Status changed before publication");
      await writeJsonObject(this.s3, this.context.bucket, this.statusKey(target), target.prepared.status, current.eTag);
    }
    await this.audit(snapshot, target, "PUBLISHED");
  }
  async verify(snapshot: ManualReportSnapshot, target: ManualReportTarget): Promise<void> {
    await this.assertCurrent(snapshot, target);
    const catalog = await import("../portal/catalog");
    const building = stored(target.prepared!.catalog);
    const detail = portalBuildingDetailSchema.parse(await catalog.getPortalCatalogBuilding(building.organizationId, building.buildingId));
    const inspection = detail.inspections.find((row) => row.inspectionId === target.before.inspectionId);
    for (const type of MANUAL_REPORT_TYPES) {
      if (inspection?.reports.find((report) => report.reportType === type)?.deliveryStatus !== "AVAILABLE") throw new Error(`${type} is not available in the client catalog`);
      const artifact = await catalog.resolvePortalArtifact(building.organizationId, building.buildingId, target.before.inspectionId, type);
      if (artifact.key !== target.files[type].key || artifact.contentType !== target.files[type].contentType) throw new Error("Client artifact resolution selected a different file");
    }
    if (!(await catalog.listPortalCatalogBuildings(building.organizationId)).some((row) => row.buildingId === building.buildingId)) throw new Error("Published building is missing from the client list");
  }
}
