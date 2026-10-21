import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  organizationSchema, portalAdminBuildingCountSchema, portalAdminBuildingListSchema,
  portalAdminClientListSchema, portalAdminReviewResponseSchema, portalReportTypeSchema,
  type PortalAdminClient, type PortalAdminReviewResponse, type PortalAdminReviewRow,
} from "@bdr/contracts";
import { notFound, sha256, tenantKeys } from "@bdr/domain";
import { z } from "zod";
import { allowedClientKey, buildingsUnder, linkedPortalOrganizations, loadPortalReportStatus, reportFileMatches } from "./buildings";
import { portalAdminCatalogBuildingsFor, sourceClaims, storedPortalInspectionSources } from "./catalog";
import { mapConcurrent, measuredAdminRead, type PortalReadContext } from "./read-context";

const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function activeClient(client: PortalAdminClient, context: PortalReadContext): Promise<PortalAdminClient | null> {
  const table = process.env.TENANT_DATA_TABLE_NAME;
  if (!table) throw new Error("Missing TENANT_DATA_TABLE_NAME");
  context.dynamoReadCount++;
  const result = await context.run(() => document.send(new GetCommand({ TableName: table, Key: tenantKeys.organization(client.organizationId),
    ConsistentRead: true, ProjectionExpression: "organizationId, displayName, #status", ExpressionAttributeNames: { "#status": "status" } })));
  const organization = organizationSchema.parse(result.Item);
  if (organization.organizationId !== client.organizationId) throw new Error("portal_organization_owner_invalid");
  return organization.status === "ACTIVE" ? client : null;
}

async function directory(context: PortalReadContext): Promise<PortalAdminClient[]> {
  const linked = await linkedPortalOrganizations(context);
  const clients = await mapConcurrent(linked, 4, (client) => activeClient(client, context));
  return clients.filter((client): client is PortalAdminClient => client !== null);
}

async function selectedClient(organizationId: string, context: PortalReadContext) {
  const client = (await linkedPortalOrganizations(context)).find((row) => row.organizationId === organizationId);
  if (!client) notFound();
  const active = await activeClient(client, context);
  if (!active) notFound();
  return active;
}

export function adminClients(requestId: string) {
  return measuredAdminRead("clients", requestId, async (context) => portalAdminClientListSchema.parse({ items: await directory(context) }));
}

export function adminClientBuildings(organizationId: string, requestId: string) {
  return measuredAdminRead("client_buildings", requestId, async (context) => {
    const client = await selectedClient(organizationId, context);
    return portalAdminBuildingListSchema.parse({ items: await portalAdminCatalogBuildingsFor(client, context), admin: true });
  });
}

export function adminClientBuildingCount(organizationId: string, requestId: string) {
  return measuredAdminRead("client_building_count", requestId, async (context) => {
    const client = await selectedClient(organizationId, context);
    return portalAdminBuildingCountSchema.parse({ count: (await portalAdminCatalogBuildingsFor(client, context)).length });
  });
}

const pendingReport = z.object({
  awaitingClientAdmin: z.boolean().nullish(), stale: z.boolean().nullish(), clientVisible: z.boolean().nullish(),
  sourceKey: z.string().nullish(), approvedKey: z.string().nullish(), generatedAt: z.string().nullish(),
  reportgenApprovedAt: z.string().nullish(), clientApprovedAt: z.string().nullish(), at: z.string().nullish(),
});

export function pendingReviewRows(client: PortalAdminClient, prefix: string, name: string, status: Record<string, unknown>): PortalAdminReviewRow[] {
  const reports = z.object({ reports: z.record(z.string(), z.unknown()).nullish() }).parse(status).reports ?? {};
  const rows = new Map<string, PortalAdminReviewRow>();
  for (const [key, value] of Object.entries(reports)) {
    if (value == null) continue;
    const report = pendingReport.parse(value);
    if (!report.awaitingClientAdmin || report.stale || report.clientVisible) continue;
    const reportType = portalReportTypeSchema.parse(key === "CAPITAL_PLAN" ? "CAPITAL_PLANNING" : key);
    if (rows.has(reportType)) throw new Error("portal_review_report_type_ambiguous");
    const reportKey = portalReportTypeSchema.or(z.literal("CAPITAL_PLAN")).parse(key);
    const artifactKey = report.approvedKey || report.sourceKey || null;
    const classificationKey = report.sourceKey || report.approvedKey;
    if (classificationKey && !reportFileMatches(key, classificationKey)) throw new Error("portal_review_report_file_invalid");
    if (artifactKey && !allowedClientKey(prefix, artifactKey)) throw new Error("portal_review_artifact_owner_invalid");
    rows.set(reportType, { organizationId: client.organizationId, clientName: client.displayName, prefix, name, reportType, reportKey, artifactKey,
      generatedAt: report.reportgenApprovedAt || report.generatedAt || report.clientApprovedAt || report.at || null });
  }
  return [...rows.values()];
}

export function adminReview(requestId: string) {
  return measuredAdminRead("review", requestId, async (context) => {
    const clients = await directory(context);
    const failures: PortalAdminReviewResponse["failures"] = [];
    const sources = new Map<string, { client: PortalAdminClient; prefix: string; name?: string }>();
    const blockedSources = new Set<string>();
    const failure = (client: PortalAdminClient, prefix: string | null) => failures.push({ organizationId: client.organizationId, clientName: client.displayName, prefix });
    const add = (client: PortalAdminClient, prefix: string, name?: string) => {
      const parts = prefix.replace(/\/$/, "").split("/");
      if (parts.length !== 4 || parts.some((part) => !part || part === "." || part === "..") || !client.clientPrefixes.includes(parts[0]!)) throw new Error("portal_review_source_owner_invalid");
      const normalized = `${parts.join("/")}/`;
      if (blockedSources.has(normalized)) throw new Error("portal_review_source_ambiguous");
      const existing = sources.get(normalized);
      if (existing && (existing.client.organizationId !== client.organizationId || existing.name && name && existing.name !== name)) {
        sources.delete(normalized); blockedSources.add(normalized); throw new Error("portal_review_source_ambiguous");
      }
      sources.set(normalized, { client, prefix: normalized, ...(name || existing?.name ? { name: name || existing!.name! } : {}) });
    };
    // Collect stored sources as well as discovered folders: old inspections must not disappear.
    await mapConcurrent(clients, 4, async (client) => {
      try {
        const stored = await storedPortalInspectionSources(client.organizationId, context);
        for (const source of stored) add(client, source.prefix, source.name);
      } catch { failure(client, null); }
    });
    const roots = clients.flatMap((client) => client.clientPrefixes.map((prefix) => ({ client, prefix })));
    await mapConcurrent(roots, 4, async ({ client, prefix }) => {
      try { for (const source of await buildingsUnder(prefix, context)) add(client, source); }
      catch { failure(client, `${prefix}/`); }
    });
    const unique = [...sources.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
    let claims: Awaited<ReturnType<typeof sourceClaims>>;
    try { claims = await sourceClaims(unique.map((source) => source.prefix), context); }
    catch {
      for (const client of clients) failure(client, null);
      context.incomplete = true;
      return portalAdminReviewResponseSchema.parse({ items: [], complete: false, failures });
    }
    const groups = await mapConcurrent(unique, 4, async ({ client, prefix, name }) => {
      try {
        const claim = claims.get(tenantKeys.portalSource(sha256(prefix.replace(/\/$/, ""))).PK);
        if (claim && (claim.organizationId !== client.organizationId || typeof claim.buildingId !== "string")) throw new Error("portal_review_claim_owner_invalid");
        const status = await loadPortalReportStatus(prefix, context);
        const label = name || (typeof status.displayName === "string" && status.displayName.trim() ? status.displayName.trim() : prefix.split("/").at(-2)!);
        return pendingReviewRows(client, prefix, label, status);
      } catch { failure(client, prefix); return []; }
    });
    const items = groups.flat().sort((a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name) || a.prefix.localeCompare(b.prefix) || a.reportType.localeCompare(b.reportType));
    const uniqueFailures = [...new Map(failures.map((row) => [`${row.organizationId}:${row.prefix ?? ""}`, row])).values()]
      .sort((a, b) => a.clientName.localeCompare(b.clientName) || (a.prefix ?? "").localeCompare(b.prefix ?? ""));
    context.incomplete = uniqueFailures.length > 0;
    return portalAdminReviewResponseSchema.parse({ items, complete: !context.incomplete, failures: uniqueFailures });
  });
}
