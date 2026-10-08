import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { portalReportTypeSchema, type PortalBuildingDetail, type PortalReportDeliveryStatus, type PortalReportType } from "@bdr/contracts";
import { z } from "zod";

export const SAMPLE_NAME = "BDR - Sample Dashboard";
export const SAMPLE_FILES: Record<PortalReportType, string> = {
  ASSESSMENT: "Sample_Assessment-BDR.pdf",
  EVIDENCE: "Sample_Evidence-BDR.pdf",
  ROOF_TAKEOFF: "Sample_Roof_Takeoff-BDR.pdf",
  AS_BUILT: "Sample-As-built.pdf",
  CAPITAL_PLANNING: "Sample_Capital_Plan-BDR.pdf",
};
export const REPORT_TYPES = portalReportTypeSchema.options;
const DAY = 86_400_000;
const fileSchema = z.object({ filename: z.string(), sizeBytes: z.number().int().positive().max(100 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const originalSchema = z.object({ username: z.string(), sub: z.string(), issuer: z.string(), organizationId: z.string(), userId: z.string(), revision: z.string(), status: z.string() });
const clientSchema = z.object({
  email: z.email(), original: originalSchema.nullable(),
  phase: z.enum(["pending", "resetting", "deleted", "creating", "created", "done"]),
  username: z.string().nullable(), sub: z.string().nullable(),
});
export const setupManifestSchema = z.object({
  version: z.literal(1), seedId: z.literal("bdr-sample-dashboard-v1"),
  environment: z.enum(["development", "production"]), accountId: z.string(), region: z.string(),
  bucket: z.string(), tenantTable: z.string(), clientPool: z.string(), clientPrefix: z.string(), organizationId: z.string(),
  createdAt: z.iso.datetime({ offset: true }), files: z.record(portalReportTypeSchema, fileSchema),
  clients: z.array(clientSchema),
  asBuilt: z.record(z.string(), z.object({ uploadId: z.string(), key: z.string() })),
  complete: z.boolean(), lease: z.object({ owner: z.string(), expiresAt: z.iso.datetime({ offset: true }) }).nullable(),
}).strict();
export type SetupManifest = z.infer<typeof setupManifestSchema>;
export type OriginalClient = z.infer<typeof originalSchema>;
export type SetupClient = z.infer<typeof clientSchema>;
export type SampleFiles = SetupManifest["files"];
export type SampleContext = Pick<SetupManifest, "environment" | "accountId" | "region" | "bucket" | "tenantTable" | "clientPool" | "clientPrefix" | "organizationId"> & { portalOrigin: string; operatorArn: string };
export type SampleInspection = { prefix: string; scannedAt: string; uploadedAt: string; publishedAt: string; statuses: Record<PortalReportType, PortalReportDeliveryStatus> };
export type SampleBuilding = { name: string; address: string; engineerNames: string; inspections: SampleInspection[] };
export type SetupOptions = { apply: boolean; resetExistingClients: boolean; emails: string[]; reportsDirectory: string };
export type ManifestSnapshot = { value: SetupManifest | null; eTag: string | null };

export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readSampleFiles(directory: string): Promise<SampleFiles> {
  const files = {} as SampleFiles;
  for (const type of REPORT_TYPES) {
    const filename = SAMPLE_FILES[type];
    const bytes = await readFile(resolve(directory, filename));
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || !bytes.subarray(-4096).includes(Buffer.from("%%EOF"))) {
      throw new Error(`Not a complete PDF: ${filename}`);
    }
    files[type] = fileSchema.parse({ filename, sizeBytes: bytes.length, sha256: hash(bytes) });
  }
  return files;
}

export function sampleDataset(createdAt: string, prefix: string): SampleBuilding[] {
  const base = Date.parse(createdAt);
  if (!Number.isFinite(base)) throw new Error("Invalid setup date");
  const available = Object.fromEntries(REPORT_TYPES.map((type) => [type, "AVAILABLE"])) as Record<PortalReportType, PortalReportDeliveryStatus>;
  const definitions: Array<{ slug: string; name: string; address: string; ages: number[]; uploadAge: number; reportAge: number; latest: Record<PortalReportType, PortalReportDeliveryStatus> }> = [
    { slug: "office", name: "Sample Office Building", address: "101 Sample Lane, Demo City, NY 10001", ages: [90, 30, 3], uploadAge: 3 / 24, reportAge: 2 / 24, latest: available },
    { slug: "warehouse", name: "Sample Warehouse", address: "202 Sample Avenue, Demo City, NY 10001", ages: [60, 14, 4], uploadAge: 3, reportAge: 23 / 24,
      latest: { ...available, ROOF_TAKEOFF: "IN_PREPARATION", AS_BUILT: "IN_PREPARATION", CAPITAL_PLANNING: "IN_PREPARATION" } },
    { slug: "retail", name: "Sample Retail Center", address: "303 Sample Road, Demo City, NY 10001", ages: [45, 10], uploadAge: 9, reportAge: 4,
      latest: { ...available, EVIDENCE: "IN_PREPARATION", ROOF_TAKEOFF: "IN_PREPARATION", AS_BUILT: "NOT_INCLUDED", CAPITAL_PLANNING: "NOT_INCLUDED" } },
  ];
  return definitions.map((building) => ({
    name: building.name, address: building.address, engineerNames: "Sample Engineer",
    inspections: building.ages.map((age, index) => {
      const latest = index === building.ages.length - 1;
      const scannedAt = new Date(base - age * DAY).toISOString();
      return {
        prefix: `${prefix}/sample_robot/${scannedAt.slice(0, 10)}/${building.slug}/`, scannedAt,
        uploadedAt: new Date(base - (latest ? building.uploadAge : age - 1) * DAY).toISOString(),
        publishedAt: new Date(base - (latest ? building.reportAge : age - 2) * DAY).toISOString(),
        statuses: { ...(latest ? building.latest : available) },
      };
    }),
  }));
}

export function assertManifestMatches(manifest: SetupManifest, context: SampleContext, files: SampleFiles, emails: string[]): void {
  for (const field of ["environment", "accountId", "region", "bucket", "tenantTable", "clientPool", "clientPrefix", "organizationId"] as const) {
    if (manifest[field] !== context[field]) throw new Error(`Setup ownership mismatch: ${field}`);
  }
  for (const type of REPORT_TYPES) {
    if (manifest.files[type].sha256 !== files[type].sha256 || manifest.files[type].sizeBytes !== files[type].sizeBytes) {
      throw new Error(`Sample file changed after setup began: ${files[type].filename}`);
    }
  }
  if (JSON.stringify(manifest.clients.map((client) => client.email).sort()) !== JSON.stringify([...emails].sort())) {
    throw new Error("Use the original client email arguments when resuming this setup");
  }
}

export interface SetupPort {
  context: SampleContext;
  readManifest(): Promise<ManifestSnapshot>;
  saveManifest(manifest: SetupManifest, expectedETag: string | null): Promise<string>;
  assertVacant(): Promise<void>;
  inspectClient(email: string): Promise<OriginalClient | null>;
  prepareDataset(manifest: SetupManifest, directory: string, checkpoint: () => Promise<void>): Promise<void>;
  verifyDataset(manifest: SetupManifest): Promise<PortalBuildingDetail[]>;
  resetClient(client: SetupClient): Promise<void>;
  createClient(email: string): Promise<{ username: string; sub: string }>;
  mapClient(client: SetupClient): Promise<void>;
  verifyClient(client: SetupClient): Promise<void>;
  emit(value: unknown): void;
}

export async function setupSampleDashboard(port: SetupPort, options: SetupOptions, now = () => new Date()): Promise<void> {
  const emails = [...new Set(options.emails.map((email) => z.email().parse(email.trim().toLowerCase())))].sort();
  if (emails.length === 0) throw new Error("Provide at least one --client-email");
  const files = await readSampleFiles(options.reportsDirectory);
  const snapshot = await port.readManifest();
  let manifest = snapshot.value;
  if (manifest) assertManifestMatches(manifest, port.context, files, emails);
  else await port.assertVacant();
  const observed = await Promise.all(emails.map((email) => port.inspectClient(email)));
  if (!manifest) {
    const { portalOrigin: _portalOrigin, operatorArn: _operatorArn, ...ownership } = port.context;
    manifest = setupManifestSchema.parse({
      version: 1, seedId: "bdr-sample-dashboard-v1", ...ownership,
      createdAt: now().toISOString(), files,
      clients: emails.map((email, index) => ({ email, original: observed[index] ?? null, phase: "pending", username: null, sub: null })),
      asBuilt: {}, complete: false, lease: null,
    });
  }
  // Never reset a different subject after a partially completed run.
  for (const [index, client] of manifest.clients.entries()) {
    const current = observed[index];
    if (current && current.sub !== client.original?.sub && current.sub !== client.sub) {
      throw new Error(`Unexpected client identity for ${client.email}; stop and reconcile before retrying`);
    }
    if (["created", "done"].includes(client.phase) && current?.sub !== client.sub) throw new Error(`The new client account changed: ${client.email}`);
    if (client.phase === "creating" && current && current.sub !== client.original?.sub) {
      throw new Error(`Invitation outcome is uncertain for ${client.email}; do not resend or delete automatically`);
    }
  }
  port.emit({ mode: options.apply ? "apply" : "preview", organization: SAMPLE_NAME, ...port.context,
    files, buildings: sampleDataset(manifest.createdAt, manifest.clientPrefix),
    clients: manifest.clients.map((client) => ({ email: client.email, previousOrganization: client.original?.organizationId ?? null, phase: client.phase, resetsExistingClient: client.original !== null && client.phase !== "done" })),
    invitationTemplate: "Existing production/development Cognito template; no changes", complete: manifest.complete,
  });
  if (!options.apply) return;
  if (manifest.clients.some((client) => client.original && client.phase !== "done") && !options.resetExistingClients) {
    throw new Error("Existing clients require --reset-existing-clients; review the preview first");
  }
  const owner = randomUUID();
  if (manifest.lease && Date.parse(manifest.lease.expiresAt) > now().getTime()) throw new Error("Another setup holds the lease; wait until it finishes or the lease expires");
  let eTag = snapshot.eTag;
  const state = manifest;
  const checkpoint = async () => {
    if (state.lease && state.lease.owner === owner && Date.parse(state.lease.expiresAt) <= now().getTime()) throw new Error("Setup lease expired; rerun to resume safely");
    state.lease = { owner, expiresAt: new Date(now().getTime() + 15 * 60_000).toISOString() };
    eTag = await port.saveManifest(state, eTag);
  };
  state.lease = null;
  await checkpoint();
  try {
    if (!state.complete) await port.prepareDataset(state, options.reportsDirectory, checkpoint);
    await port.verifyDataset(state);
    for (const client of state.clients) {
      if (client.phase === "done") { await port.verifyClient(client); continue; }
      if (client.phase === "pending" || client.phase === "resetting") {
        client.phase = "resetting";
        await checkpoint();
        await port.resetClient(client);
        client.phase = "deleted";
        await checkpoint();
      }
      if (client.phase === "deleted" || client.phase === "creating") {
        client.phase = "creating";
        await checkpoint();
        const created = await port.createClient(client.email);
        client.username = created.username;
        client.sub = created.sub;
        client.phase = "created";
        await checkpoint();
      }
      await port.mapClient(client);
      await port.verifyClient(client);
      client.phase = "done";
      await checkpoint();
    }
    state.complete = true;
    await checkpoint();
    port.emit({ complete: true, organization: SAMPLE_NAME, portalUrl: `${port.context.portalOrigin}/projects`, clients: state.clients.map((client) => client.email), buildingCount: 3, inspectionCounts: [3, 3, 2] });
  } finally {
    // A stale writer must not release another process's lease.
    state.lease = null;
    await port.saveManifest(state, eTag);
  }
}
