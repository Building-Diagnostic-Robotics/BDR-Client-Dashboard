import { createHash, randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  PortalBuildingDetail,
  PortalBuildingSummary,
  PortalInspection,
  PortalInspectionCandidate,
  PortalPendingReportStatus,
  PortalReport,
  PortalReportType,
} from "@bdr/contracts";
import { auditExpiresAt, auditKeys, conflict, notFound, sha256, tenantKeys } from "@bdr/domain";

import {
  allowedClientKey,
  discoverPortalSources,
  inspectPortalSource,
  linkedPrefixesForOrganization,
  listLinkedClients,
  listPortalBuildings,
  loadPortalStatus,
  loadPortalReportStatus,
  normalizePortalTimestamp,
  portalObjectMetadata,
  portalSourceId,
  provisionalPortalBuildingId,
  provisionalPortalInspectionId,
  reportFileMatches,
  resolvePortalArtifactSource,
  signedUpload,
  type PortalBuilding,
  type PortalSourceInspection,
} from "./buildings";
import { reportDownloadFilename } from "./artifact-filenames";

const REPORT_ORDER: readonly PortalReportType[] = [
  "ASSESSMENT",
  "EVIDENCE",
  "ROOF_TAKEOFF",
  "AS_BUILT",
  "CAPITAL_PLANNING",
];

const DEFAULT_STATUSES: Record<PortalReportType, PortalPendingReportStatus> = {
  ASSESSMENT: "IN_PREPARATION",
  EVIDENCE: "IN_PREPARATION",
  ROOF_TAKEOFF: "NOT_INCLUDED",
  AS_BUILT: "NOT_INCLUDED",
  CAPITAL_PLANNING: "NOT_INCLUDED",
};

type AsBuiltArtifact = {
  key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  publishedAt: string;
};

type StoredInspection = {
  inspectionId: string;
  sourceId: string;
  sourcePrefix: string;
  includedSectionIds: string[];
  scannedAt: string | null;
  uploadCompletedAt: string | null;
  timeZone: string | null;
  reportStatuses: Record<PortalReportType, PortalPendingReportStatus>;
  sourceFingerprint: string;
  asBuilt: AsBuiltArtifact | null;
};

type StoredBuilding = {
  PK: string;
  SK: string;
  entityType: "PORTAL_BUILDING";
  organizationId: string;
  buildingId: string;
  displayName: string;
  address: string;
  engineerNames: string;
  clientVisible: boolean;
  inspections: StoredInspection[];
  revision: string;
  createdAt: string;
  updatedAt: string;
};

type ResolvedBuilding = {
  item: StoredBuilding;
  provisional: boolean;
  inspectionViews?: PortalInspection[];
};

type ResolvedArtifact = {
  key: string;
  filename: string;
  contentType: string;
};

export type PortalCatalogMutationContext = {
  actorId: string;
  actorSub: string;
  requestId: string;
  action: string;
};

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function table(): string {
  const value = process.env.TENANT_DATA_TABLE_NAME;
  if (!value) throw new Error("Missing TENANT_DATA_TABLE_NAME");
  return value;
}

function auditTable(): string {
  const value = process.env.AUDIT_TABLE_NAME;
  if (!value) throw new Error("Missing AUDIT_TABLE_NAME");
  return value;
}

function auditWrite(
  organizationId: string,
  context: PortalCatalogMutationContext,
  target: Record<string, string>,
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  const occurredAt = new Date().toISOString();
  const eventId = `event_${randomUUID()}`;
  return {
    Put: {
      TableName: auditTable(),
      Item: {
        ...auditKeys.organization(organizationId, occurredAt, eventId),
        eventId,
        organizationId,
        occurredAt,
        ttlExpiresAt: auditExpiresAt(occurredAt),
        action: context.action,
        actorId: context.actorId,
        actorSub: context.actorSub,
        requestId: context.requestId,
        target,
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    },
  };
}

function reportKey(type: PortalReportType): string {
  return type === "CAPITAL_PLANNING" ? "CAPITAL_PLAN" : type;
}

function sourceClaimHash(prefix: string): string {
  return sha256(prefix.replace(/^\/+|\/+$/g, ""));
}

async function sourceClaims(prefixes: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(prefixes.map(sourceClaimHash))];
  const claims = new Map<string, Record<string, unknown>>();
  const tableName = table();
  for (let offset = 0; offset < unique.length; offset += 100) {
    let keys: Array<Record<string, string>> = unique
      .slice(offset, offset + 100)
      .map((hash) => ({ ...tenantKeys.portalSource(hash) }));
    for (let attempt = 0; keys.length > 0 && attempt < 4; attempt += 1) {
      const result = await document.send(new BatchGetCommand({
        RequestItems: {
          [tableName]: { Keys: keys, ConsistentRead: true },
        },
      }));
      for (const item of result.Responses?.[tableName] ?? []) {
        if (typeof item.PK === "string") claims.set(item.PK, item);
      }
      keys = (result.UnprocessedKeys?.[tableName]?.Keys ?? []).flatMap((key: Record<string, unknown>) => (
        typeof key["PK"] === "string" && typeof key["SK"] === "string"
          ? [{ PK: key["PK"], SK: key["SK"] }]
          : []
      ));
    }
    if (keys.length > 0) throw new Error("portal_source_claim_read_incomplete");
  }
  return claims;
}

function sourceFingerprint(source: PortalSourceInspection, includedSectionIds: readonly string[]): string {
  const rows = source.sections
    .filter((section) => includedSectionIds.includes(section.sectionId))
    .map((section) => `${section.sectionId}:${section.uploadCompletedAt}:${section.completionTag}`)
    .sort();
  return createHash("sha256").update(rows.join("|")).digest("hex");
}

function inspectionFromSource(
  source: PortalSourceInspection,
  includedSectionIds: readonly string[],
): StoredInspection {
  const selected = source.sections.filter((section) => includedSectionIds.includes(section.sectionId));
  if (selected.length !== includedSectionIds.length || selected.some((section) => !section.eligible)) {
    throw new Error("invalid_request");
  }
  const scanTimes = selected.map((section) => section.scannedAt).filter((value): value is string => Boolean(value));
  const uploadTimes = selected.map((section) => section.uploadCompletedAt);
  return {
    inspectionId: provisionalPortalInspectionId(source.prefix),
    sourceId: source.sourceId,
    sourcePrefix: source.prefix,
    includedSectionIds: [...includedSectionIds],
    scannedAt: scanTimes.length > 0 ? scanTimes.sort()[0]! : null,
    uploadCompletedAt: uploadTimes.length > 0 ? uploadTimes.sort().at(-1)! : null,
    timeZone: source.timeZone,
    reportStatuses: { ...DEFAULT_STATUSES },
    sourceFingerprint: sourceFingerprint(source, includedSectionIds),
    asBuilt: null,
  };
}

function legacyInspection(row: PortalBuilding, source: PortalSourceInspection): StoredInspection {
  const eligible = source.sections.filter((section) => section.eligible).map((section) => section.sectionId);
  if (eligible.length > 0) return inspectionFromSource(source, eligible);
  return {
    inspectionId: provisionalPortalInspectionId(row.buildingPrefix),
    sourceId: portalSourceId(row.buildingPrefix),
    sourcePrefix: row.buildingPrefix,
    includedSectionIds: [],
    scannedAt: row.scanTime,
    uploadCompletedAt: row.uploadTime,
    timeZone: row.timeZone,
    reportStatuses: { ...DEFAULT_STATUSES },
    sourceFingerprint: sha256(row.buildingPrefix),
    asBuilt: null,
  };
}

function provisionalItem(organizationId: string, row: PortalBuilding, source: PortalSourceInspection): StoredBuilding {
  const buildingId = provisionalPortalBuildingId(row.buildingPrefix);
  const now = new Date().toISOString();
  return {
    ...tenantKeys.portalBuilding(organizationId, buildingId),
    entityType: "PORTAL_BUILDING",
    organizationId,
    buildingId,
    displayName: source.displayName || row.displayName,
    address: source.address || row.address,
    engineerNames: source.engineerNames,
    clientVisible: row.clientVisible,
    inspections: [legacyInspection(row, source)],
    revision: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
}

async function storedRows(organizationId: string): Promise<Array<Record<string, unknown>>> {
  const result = await document.send(new QueryCommand({
    TableName: table(),
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: {
      ":pk": `ORG#${organizationId}`,
      ":prefix": "PORTAL_",
    },
    ConsistentRead: true,
  }));
  return result.Items ?? [];
}

function isStoredBuilding(value: Record<string, unknown>): value is StoredBuilding {
  return value.entityType === "PORTAL_BUILDING"
    && typeof value.buildingId === "string"
    && typeof value.clientVisible === "boolean"
    && Array.isArray(value.inspections)
    && typeof value.revision === "string";
}

async function resolveBuilding(
  organizationId: string,
  buildingId: string,
  includeHidden = false,
): Promise<ResolvedBuilding> {
  const result = await document.send(new GetCommand({
    TableName: table(),
    Key: tenantKeys.portalBuilding(organizationId, buildingId),
    ConsistentRead: true,
  }));
  if (result.Item && isStoredBuilding(result.Item)) {
    if (includeHidden || result.Item.clientVisible) return { item: result.Item, provisional: false };
    const item = result.Item;
    const inspectionViews = await Promise.all(sortInspections(item.inspections).map((inspection) => inspectionView(inspection, item)));
    if (!inspectionViews.some((inspection) => inspection.availableReportTypes.length > 0)) notFound();
    return { item: result.Item, provisional: false, inspectionViews };
  }

  const prefixes = includeHidden ? await linkedPrefixesForOrganization(organizationId) : undefined;
  const legacy = await listPortalBuildings(organizationId, includeHidden, prefixes);
  const row = legacy.find((candidate) => provisionalPortalBuildingId(candidate.buildingPrefix) === buildingId);
  if (!row) notFound();
  const source = await inspectPortalSource(row.buildingPrefix);
  return { item: provisionalItem(organizationId, row, source), provisional: true };
}

function publishedArtifact(
  building: Pick<StoredBuilding, "organizationId" | "buildingId" | "displayName">,
  inspection: StoredInspection,
  type: PortalReportType,
  status: Record<string, unknown>,
): ResolvedArtifact | null {
  if (type === "AS_BUILT") {
    const published = inspection.asBuilt;
    if (!published) return null;
    const root = `reportgen_portal/as-built/${building.organizationId}/${building.buildingId}/${inspection.inspectionId}/drafts/`;
    const extension = published.contentType === "application/pdf" ? "pdf"
      : published.contentType === "image/png" ? "png" : published.contentType === "image/jpeg" ? "jpg" : null;
    if (!extension || !published.key.startsWith(root)
      || !new RegExp(`^upl_[a-f0-9]{32}/as-built\\.${extension}$`).test(published.key.slice(root.length))
      || !Number.isFinite(Date.parse(published.publishedAt))) return null;
    return {
      key: published.key,
      filename: reportDownloadFilename(building.displayName, type, published.contentType),
      contentType: published.contentType,
    };
  }
  const reports = status.reports;
  if (!reports || typeof reports !== "object" || Array.isArray(reports)) return null;
  const report = (reports as Record<string, unknown>)[reportKey(type)];
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const row = report as Record<string, unknown>;
  const key = typeof row.approvedKey === "string" ? row.approvedKey : "";
  // Approved versions may have opaque filenames. Match the source name when
  // present, using the same classification rule as operational enrichment.
  const source = row.sourceKey || key;
  if (row.clientVisible !== true || row.stale || !key
    || !allowedClientKey(inspection.sourcePrefix, key)
    || typeof source !== "string" || !reportFileMatches(reportKey(type), source)) return null;
  return { key, filename: reportDownloadFilename(building.displayName, type), contentType: "application/pdf" };
}

async function reportView(inspection: StoredInspection, building: StoredBuilding): Promise<{ reports: PortalReport[]; artifacts: Map<PortalReportType, ResolvedArtifact> }> {
  const status = await loadPortalStatus(inspection.sourcePrefix);
  const sourceReports = status.reports && typeof status.reports === "object"
    ? status.reports as Record<string, Record<string, unknown>>
    : {};
  const artifacts = new Map<PortalReportType, ResolvedArtifact>();
  const reports = REPORT_ORDER.map((type): PortalReport => {
    const artifact = publishedArtifact(building, inspection, type, status);
    if (artifact) artifacts.set(type, artifact);
    if (type === "AS_BUILT") {
      if (artifact && inspection.asBuilt) {
        return {
          reportType: type,
          deliveryStatus: "AVAILABLE",
          publishedAt: inspection.asBuilt.publishedAt,
          filename: artifact.filename,
        };
      }
      return {
        reportType: type,
        deliveryStatus: inspection.reportStatuses[type] ?? DEFAULT_STATUSES[type],
        publishedAt: null,
        filename: null,
      };
    }
    const sourceReport = sourceReports[reportKey(type)];
    const available = artifact !== null;
    const publishedAtValue = sourceReport?.generatedAt
      ?? sourceReport?.reportgenApprovedAt
      ?? sourceReport?.clientApprovedAt
      ?? sourceReport?.approvedAt;
    const publishedAt = normalizePortalTimestamp(publishedAtValue, inspection.timeZone);
    return {
      reportType: type,
      deliveryStatus: available ? "AVAILABLE" : inspection.reportStatuses[type] ?? DEFAULT_STATUSES[type],
      publishedAt: available ? publishedAt : null,
      filename: artifact?.filename ?? null,
    };
  });
  return { reports, artifacts };
}

async function inspectionView(inspection: StoredInspection, building: StoredBuilding): Promise<PortalInspection> {
  const { reports } = await reportView(inspection, building);
  const available = reports.filter((report) => report.deliveryStatus === "AVAILABLE");
  const dates = available.map((report) => report.publishedAt).filter((value): value is string => Boolean(value)).sort();
  return {
    inspectionId: inspection.inspectionId,
    scannedAt: inspection.scannedAt,
    uploadCompletedAt: inspection.uploadCompletedAt,
    timeZone: inspection.timeZone,
    availableReportTypes: available.map((report) => report.reportType),
    latestReportUpdate: dates.at(-1) ?? null,
    reports,
  };
}

function inspectionSummary(inspection: PortalInspection): PortalBuildingSummary["latestInspection"] {
  return {
    inspectionId: inspection.inspectionId,
    scannedAt: inspection.scannedAt,
    uploadCompletedAt: inspection.uploadCompletedAt,
    timeZone: inspection.timeZone,
    availableReportTypes: inspection.availableReportTypes,
    latestReportUpdate: inspection.latestReportUpdate,
  };
}

function sortInspections(inspections: readonly StoredInspection[]): StoredInspection[] {
  return [...inspections].sort((left, right) => {
    const leftDate = left.scannedAt ?? left.uploadCompletedAt ?? "";
    const rightDate = right.scannedAt ?? right.uploadCompletedAt ?? "";
    return rightDate.localeCompare(leftDate);
  });
}

async function detailFromResolved(resolved: ResolvedBuilding): Promise<PortalBuildingDetail> {
  const ordered = sortInspections(resolved.item.inspections);
  const inspections = resolved.inspectionViews ?? await Promise.all(ordered.map((inspection) => inspectionView(inspection, resolved.item)));
  return {
    buildingId: resolved.item.buildingId,
    displayName: resolved.item.displayName,
    address: resolved.item.address,
    engineerNames: resolved.item.engineerNames,
    revision: resolved.provisional ? null : resolved.item.revision,
    latestInspection: inspections[0] ?? null,
    inspectionCount: inspections.length,
    provisional: resolved.provisional,
    inspections,
  };
}

async function storedSummary(
  item: StoredBuilding,
  includeHidden: boolean,
): Promise<PortalBuildingSummary | null> {
  const ordered = sortInspections(item.inspections);
  const latest = ordered[0] ? await inspectionView(ordered[0], item) : null;
  let visible = includeHidden
    || item.clientVisible
    || Boolean(latest?.availableReportTypes.length);
  if (!visible && ordered.length > 1) {
    const previous = await Promise.all(ordered.slice(1).map((inspection) => inspectionView(inspection, item)));
    visible = previous.some((inspection) => inspection.availableReportTypes.length > 0);
  }
  if (!visible) return null;
  if (!latest) {
    return {
      buildingId: item.buildingId,
      displayName: item.displayName,
      address: item.address,
      engineerNames: item.engineerNames,
      revision: item.revision,
      latestInspection: null,
      inspectionCount: 0,
      provisional: false,
    };
  }
  return {
    buildingId: item.buildingId,
    displayName: item.displayName,
    address: item.address,
    engineerNames: item.engineerNames,
    revision: item.revision,
    latestInspection: inspectionSummary(latest),
    inspectionCount: item.inspections.length,
    provisional: false,
  };
}

async function portalCatalogState(organizationId: string, includeHidden = false): Promise<{
  items: PortalBuildingSummary[];
  sourcePrefixes: Map<string, string>;
}> {
  const rows = await storedRows(organizationId);
  const buildings = rows.filter(isStoredBuilding);
  const claimedSources = new Set(buildings.flatMap((building) => (
    building.inspections.map((inspection) => inspection.sourceId)
  )));
  const explicit = (await Promise.all(buildings.map((item) => storedSummary(item, includeHidden))))
    .filter((item): item is PortalBuildingSummary => item !== null);
  const prefixes = includeHidden ? await linkedPrefixesForOrganization(organizationId) : undefined;
  const legacy = await listPortalBuildings(organizationId, includeHidden, prefixes);
  const provisionalRows = legacy.filter((row) => !claimedSources.has(portalSourceId(row.buildingPrefix)));
  const globalClaims = await sourceClaims(provisionalRows.map((row) => row.buildingPrefix));
  const provisional = provisionalRows
    .filter((row) => !globalClaims.has(tenantKeys.portalSource(sourceClaimHash(row.buildingPrefix)).PK))
    .map((row): PortalBuildingSummary => ({
      buildingId: provisionalPortalBuildingId(row.buildingPrefix),
      displayName: row.displayName,
      address: row.address,
      engineerNames: "",
      revision: null,
      latestInspection: {
        inspectionId: provisionalPortalInspectionId(row.buildingPrefix),
        scannedAt: row.scanTime,
        uploadCompletedAt: row.uploadTime,
        timeZone: row.timeZone,
        availableReportTypes: row.readyReports
          .map((type) => type === "CAPITAL_PLAN" ? "CAPITAL_PLANNING" : type)
          .filter((type): type is PortalReportType => REPORT_ORDER.includes(type as PortalReportType)),
        latestReportUpdate: row.latestReportUpdate,
      },
      inspectionCount: 1,
      provisional: true,
    }));
  const sourcePrefixes = new Map<string, string>();
  for (const item of buildings) {
    const latest = sortInspections(item.inspections)[0];
    if (latest) sourcePrefixes.set(item.buildingId, latest.sourcePrefix);
  }
  for (const row of legacy) {
    sourcePrefixes.set(provisionalPortalBuildingId(row.buildingPrefix), row.buildingPrefix);
  }
  return {
    items: [...explicit, ...provisional].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    sourcePrefixes,
  };
}

export async function listPortalCatalogBuildings(organizationId: string): Promise<PortalBuildingSummary[]> {
  return (await portalCatalogState(organizationId)).items;
}

export async function listPortalAdminCatalogBuildings(): Promise<Array<PortalBuildingSummary & {
  buildingPrefix: string;
  scanTime: string | null;
  uploadTime: string | null;
  timeZone: string | null;
  readyReports: PortalReportType[];
  latestReportUpdate: string | null;
}>> {
  const clients = await listLinkedClients();
  const byOrganization = new Map<string, string>();
  for (const client of clients) {
    if (!byOrganization.has(client.organizationId)) byOrganization.set(client.organizationId, client.clientPrefix);
  }
  const groups = await Promise.all([...byOrganization].map(async ([organizationId, clientPrefix]) => {
    const catalog = await portalCatalogState(organizationId, true);
    return catalog.items.map((building) => ({
      ...building,
      buildingPrefix: catalog.sourcePrefixes.get(building.buildingId) ?? `${clientPrefix}/`,
      scanTime: building.latestInspection?.scannedAt ?? null,
      uploadTime: building.latestInspection?.uploadCompletedAt ?? null,
      timeZone: building.latestInspection?.timeZone ?? null,
      readyReports: building.latestInspection?.availableReportTypes ?? [],
      latestReportUpdate: building.latestInspection?.latestReportUpdate ?? null,
    }));
  }));
  return groups.flat();
}

export async function getPortalCatalogBuilding(
  organizationId: string,
  buildingId: string,
  includeHidden = false,
): Promise<PortalBuildingDetail> {
  return detailFromResolved(await resolveBuilding(organizationId, buildingId, includeHidden));
}

export async function portalBuildingIdForSource(
  organizationId: string,
  sourcePrefix: string,
): Promise<string> {
  const normalizedPrefix = sourcePrefix.replace(/^\/+|\/+$/g, "");
  const result = await document.send(new GetCommand({
    TableName: table(),
    Key: tenantKeys.portalSource(sourceClaimHash(normalizedPrefix)),
    ConsistentRead: true,
  }));
  const buildingId = result.Item?.buildingId;
  if (result.Item) {
    if (result.Item.organizationId !== organizationId || typeof buildingId !== "string") notFound();
    return buildingId;
  }
  return provisionalPortalBuildingId(normalizedPrefix);
}

async function saveBuilding(
  item: StoredBuilding,
  expectedRevision: string,
  audit: PortalCatalogMutationContext,
  target: Record<string, string>,
): Promise<StoredBuilding> {
  const next = { ...item, revision: randomUUID(), updatedAt: new Date().toISOString() };
  try {
    await document.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table(),
            Item: next,
            ConditionExpression: "revision = :expected",
            ExpressionAttributeValues: { ":expected": expectedRevision },
          },
        },
        auditWrite(item.organizationId, audit, target),
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") conflict();
    throw error;
  }
  return next;
}

async function materialize(
  item: StoredBuilding,
  audit: PortalCatalogMutationContext,
  target: Record<string, string>,
): Promise<StoredBuilding> {
  const source = item.inspections[0];
  if (!source) throw new Error("invalid_request");
  try {
    await document.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table(),
            Item: item,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
        {
          Put: {
            TableName: table(),
            Item: {
              ...tenantKeys.portalSource(sourceClaimHash(source.sourcePrefix)),
              entityType: "PORTAL_SOURCE",
              organizationId: item.organizationId,
              buildingId: item.buildingId,
              inspectionId: source.inspectionId,
              sourceId: source.sourceId,
              sourcePrefix: source.sourcePrefix,
            },
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
        auditWrite(item.organizationId, audit, target),
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") conflict();
    throw error;
  }
  return item;
}

export async function updatePortalCatalogBuilding(
  organizationId: string,
  buildingId: string,
  input: { displayName: string; address: string; engineerNames: string; expectedRevision: string | null },
  audit: PortalCatalogMutationContext,
  includeHidden = false,
): Promise<PortalBuildingDetail> {
  const resolved = await resolveBuilding(organizationId, buildingId, includeHidden);
  const changed = {
    ...resolved.item,
    displayName: input.displayName.trim(),
    address: input.address.trim(),
    engineerNames: input.engineerNames.trim(),
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  if (resolved.provisional) {
    if (input.expectedRevision !== null) conflict();
    await materialize(changed, audit, { buildingId });
    return detailFromResolved({ item: changed, provisional: false });
  }
  if (input.expectedRevision !== resolved.item.revision) conflict();
  return detailFromResolved({
    item: await saveBuilding(changed, resolved.item.revision, audit, { buildingId }),
    provisional: false,
  });
}

async function findSourceForOrganization(organizationId: string, sourceId: string): Promise<PortalSourceInspection> {
  const roots = await linkedPrefixesForOrganization(organizationId);
  const sources = (await Promise.all(roots.map(discoverPortalSources))).flat();
  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  if (!source) notFound();
  return source;
}

export async function listPortalInspectionCandidates(
  organizationId: string,
  clientPrefix: string,
  buildingId: string,
): Promise<PortalInspectionCandidate[]> {
  const allowed = await linkedPrefixesForOrganization(organizationId);
  if (!allowed.includes(clientPrefix.replace(/^\/+|\/+$/g, ""))) notFound();
  const current = await resolveBuilding(organizationId, buildingId, true);
  const sources = (await Promise.all(allowed.map(discoverPortalSources))).flat();
  const claims = await sourceClaims(sources.map((source) => source.prefix));
  const assigned = new Set(current.item.inspections.map((inspection) => inspection.sourceId));
  for (const source of sources) {
    if (claims.has(tenantKeys.portalSource(sourceClaimHash(source.prefix)).PK)) assigned.add(source.sourceId);
  }
  return sources.map((source) => ({
    sourceId: source.sourceId,
    displayName: source.displayName,
    address: source.address,
    assigned: assigned.has(source.sourceId),
    sections: source.sections,
  }));
}

export async function attachPortalInspection(
  organizationId: string,
  buildingId: string,
  input: { sourceId: string; includedSectionIds: string[]; expectedRevision: string | null },
  audit: PortalCatalogMutationContext,
): Promise<PortalBuildingDetail> {
  const [resolved, source] = await Promise.all([
    resolveBuilding(organizationId, buildingId, true),
    findSourceForOrganization(organizationId, input.sourceId),
  ]);
  if (resolved.item.inspections.some((current) => current.sourceId === source.sourceId)) {
    conflict("This scan is already attached to this building.");
  }
  const inspection = inspectionFromSource(source, input.includedSectionIds);
  const base = resolved.item;
  if (!resolved.provisional && input.expectedRevision !== base.revision) conflict();
  const next: StoredBuilding = {
    ...base,
    inspections: [...base.inspections, inspection],
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];
  if (resolved.provisional) {
    const first = base.inspections[0]!;
    items.push({ Put: {
      TableName: table(), Item: { ...next, inspections: [first, inspection] },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    } });
    items.push({ Put: {
      TableName: table(),
      Item: { ...tenantKeys.portalSource(sourceClaimHash(first.sourcePrefix)), entityType: "PORTAL_SOURCE", organizationId, buildingId, inspectionId: first.inspectionId, sourceId: first.sourceId, sourcePrefix: first.sourcePrefix },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    } });
  } else {
    items.push({ Put: {
      TableName: table(), Item: next,
      ConditionExpression: "revision = :expected",
      ExpressionAttributeValues: { ":expected": base.revision },
    } });
  }
  items.push({ Put: {
    TableName: table(),
    Item: { ...tenantKeys.portalSource(sourceClaimHash(source.prefix)), entityType: "PORTAL_SOURCE", organizationId, buildingId, inspectionId: inspection.inspectionId, sourceId: source.sourceId, sourcePrefix: source.prefix },
    ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
  } });
  items.push(auditWrite(organizationId, audit, {
    buildingId,
    inspectionId: inspection.inspectionId,
    sourceId: source.sourceId,
  }));
  try {
    await document.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") conflict("This scan is already assigned or the building changed. Reload and review it before retrying.");
    throw error;
  }
  return detailFromResolved({ item: next, provisional: false });
}

export async function updatePortalInspectionStatuses(
  organizationId: string,
  buildingId: string,
  inspectionId: string,
  reportStatuses: Record<PortalReportType, PortalPendingReportStatus>,
  expectedRevision: string,
  audit: PortalCatalogMutationContext,
): Promise<PortalBuildingDetail> {
  const resolved = await resolveBuilding(organizationId, buildingId, true);
  if (resolved.provisional || resolved.item.revision !== expectedRevision) conflict();
  const inspections = resolved.item.inspections.map((inspection) => inspection.inspectionId === inspectionId
    ? { ...inspection, reportStatuses: { ...reportStatuses } }
    : inspection);
  if (!inspections.some((inspection) => inspection.inspectionId === inspectionId)) notFound();
  const next = await saveBuilding(
    { ...resolved.item, inspections },
    expectedRevision,
    audit,
    { buildingId, inspectionId },
  );
  return detailFromResolved({ item: next, provisional: false });
}

export async function startPortalAsBuiltUpload(
  organizationId: string,
  buildingId: string,
  inspectionId: string,
  input: { filename: string; contentType: string; sizeBytes: number },
): Promise<{ uploadId: string; url: string; key: string }> {
  const resolved = await resolveBuilding(organizationId, buildingId, true);
  if (!resolved.item.inspections.some((inspection) => inspection.inspectionId === inspectionId)) notFound();
  const uploadId = `upl_${randomUUID().replaceAll("-", "")}`;
  const extension = input.contentType === "application/pdf" ? "pdf" : input.contentType === "image/png" ? "png" : "jpg";
  const key = `reportgen_portal/as-built/${organizationId}/${buildingId}/${inspectionId}/drafts/${uploadId}/as-built.${extension}`;
  return { uploadId, key, url: await signedUpload(key, input.contentType) };
}

export async function publishPortalAsBuilt(
  organizationId: string,
  buildingId: string,
  inspectionId: string,
  input: { uploadId: string; key: string; filename: string; contentType: string; sizeBytes: number; expectedRevision: string },
  audit: PortalCatalogMutationContext,
): Promise<PortalBuildingDetail> {
  const expectedPrefix = `reportgen_portal/as-built/${organizationId}/${buildingId}/${inspectionId}/drafts/${input.uploadId}/`;
  if (!input.key.startsWith(expectedPrefix)) throw new Error("invalid_request");
  const metadata = await portalObjectMetadata(input.key);
  if (metadata.sizeBytes !== input.sizeBytes || metadata.contentType !== input.contentType) throw new Error("invalid_request");
  const resolved = await resolveBuilding(organizationId, buildingId, true);
  if (resolved.provisional || resolved.item.revision !== input.expectedRevision) conflict();
  let found = false;
  const inspections = resolved.item.inspections.map((inspection) => {
    if (inspection.inspectionId !== inspectionId) return inspection;
    found = true;
    return {
      ...inspection,
      asBuilt: {
        key: input.key,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        publishedAt: new Date().toISOString(),
      },
    };
  });
  if (!found) notFound();
  const next = await saveBuilding(
    { ...resolved.item, inspections },
    input.expectedRevision,
    audit,
    { buildingId, inspectionId, uploadId: input.uploadId },
  );
  return detailFromResolved({ item: next, provisional: false });
}

export async function resolvePortalArtifact(
  organizationId: string,
  buildingId: string,
  inspectionId: string,
  type: PortalReportType,
): Promise<ResolvedArtifact> {
  const startedAt = Date.now();
  let outcome = "error";
  let provisional = false;
  try {
    const result = await document.send(new GetCommand({
      TableName: table(), Key: tenantKeys.portalBuilding(organizationId, buildingId), ConsistentRead: true,
    }));
    let artifact: ResolvedArtifact | null;
    if (result.Item) {
      if (!isStoredBuilding(result.Item) || result.Item.organizationId !== organizationId || result.Item.buildingId !== buildingId) notFound();
      const building = result.Item;
      const inspection = building.inspections.find((candidate) => candidate.inspectionId === inspectionId);
      if (!inspection) notFound();
      // An available published report also makes a legacy unreleased building visible.
      const status = type === "AS_BUILT" ? {} : await loadPortalReportStatus(inspection.sourcePrefix);
      artifact = publishedArtifact(building, inspection, type, status);
    } else {
      provisional = true;
      const source = await resolvePortalArtifactSource(organizationId, buildingId);
      if (provisionalPortalInspectionId(source.prefix) !== inspectionId) notFound();
      const claims = await sourceClaims([source.prefix]);
      if (claims.size > 0) notFound();
      const inspection: StoredInspection = {
        inspectionId, sourceId: portalSourceId(source.prefix), sourcePrefix: source.prefix,
        includedSectionIds: [], scannedAt: null, uploadCompletedAt: null, timeZone: null,
        reportStatuses: { ...DEFAULT_STATUSES }, sourceFingerprint: sha256(source.prefix), asBuilt: null,
      };
      artifact = publishedArtifact({ organizationId, buildingId, displayName: source.displayName }, inspection, type, source.status);
    }
    if (!artifact) notFound();
    outcome = "success";
    return artifact;
  } finally {
    console.info(JSON.stringify({ event: "portal_artifact_resolution", reportType: type, provisional, outcome, durationMs: Date.now() - startedAt }));
  }
}
