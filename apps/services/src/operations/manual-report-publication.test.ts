import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { applyManualReports, inspectManualReportFile, MANUAL_REPORT_TYPES, manualReportSnapshotSchema,
  manualSourcePrefix, previewManualReports, sameJson, type ManualReportManifest, type ManualReportObservation,
  type ManualReportPort, type ManualReportSnapshot, type ManualReportTarget, type ManualReportFile, type PreparedManualReports } from "./manual-report-publication";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))); temporary.length = 0; });
const org = "org_0123456789abcdef";
const context = { environment: "production" as const, accountId: "123456789012", region: "us-east-1", bucket: "reports", tenantTable: "tenant", auditTable: "audit", operatorArn: "arn:aws:iam::123456789012:user/operator" };

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "manual-reports-")); temporary.push(directory);
  const reports = { ASSESSMENT: "assessment.pdf", EVIDENCE: "evidence.pdf", AS_BUILT: "as-built.pdf" };
  for (const filename of Object.values(reports)) await writeFile(join(directory, filename), "%PDF-1.7\noperator report\n%%EOF\n");
  const manifest: ManualReportManifest = { version: 1, environment: "production", accountId: context.accountId, organization: "Client",
    buildings: ["first", "second"].map((name) => ({ name, sourceUri: `s3://reports/client/Roofus#0003/date/${name}/`, reports: { ...reports } })) };
  const order: string[] = []; let uploads = 0; let catalogWrites = 0; let statusWrites = 0;
  const current = new Map<string, { catalog: unknown; status: unknown }>();
  const faults = { upload: 0, catalogResponse: false, statusResponse: false, conflict: false };
  const port: ManualReportPort = {
    context,
    observe: vi.fn(async (_organization: string, prefix: string, name: string): Promise<ManualReportObservation> => {
      const id = name === "first" ? "11111111111111111111" : "22222222222222222222";
      current.set(prefix, { catalog: null, status: {} });
      return { organization: { organizationId: org, displayName: "Client", status: "ACTIVE" }, linksETag: "links", sourceFingerprint: "source",
        status: { value: {}, eTag: null }, catalog: null, claim: null, inspectionId: `pin_${id}`,
        candidate: { buildingId: `pbl_${id}`, organizationId: org, inspections: [{ inspectionId: `pin_${id}`, asBuilt: null }] } };
    }),
    assertCurrent: vi.fn(async (_snapshot: ManualReportSnapshot, target: ManualReportTarget) => {
      if (faults.conflict) throw new Error("External ownership conflict");
      const state = current.get(target.sourcePrefix)!;
      if (state.catalog !== null && !sameJson(state.catalog, target.prepared?.catalog)) throw new Error("External catalog edit");
    }),
    upload: vi.fn(async (_snapshot: ManualReportSnapshot, file: ManualReportFile) => { order.push("upload"); if (++uploads === faults.upload) throw new Error("Upload failed"); expect(file.key).toContain("/"); }),
    prepare: vi.fn(async (target: ManualReportTarget, operationId: string, publishedAt: string): Promise<PreparedManualReports> => ({ publishedAt,
      catalog: { ...target.before.candidate, revision: `rev_${operationId}` }, status: { operationId, publishedAt } })),
    commitCatalog: vi.fn(async (_snapshot: ManualReportSnapshot, target: ManualReportTarget) => {
      const state = current.get(target.sourcePrefix)!;
      if (sameJson(state.catalog, target.prepared!.catalog)) return;
      order.push("catalog"); state.catalog = structuredClone(target.prepared!.catalog); catalogWrites++;
      if (faults.catalogResponse) { faults.catalogResponse = false; throw new Error("Commit response lost"); }
    }),
    publishStatus: vi.fn(async (_snapshot: ManualReportSnapshot, target: ManualReportTarget) => {
      const state = current.get(target.sourcePrefix)!;
      if (sameJson(state.status, target.prepared!.status)) return;
      order.push("publish"); state.status = structuredClone(target.prepared!.status); statusWrites++;
      if (faults.statusResponse) { faults.statusResponse = false; throw new Error("Publication response lost"); }
    }),
    verify: vi.fn(async () => { order.push("verify"); }),
  };
  const snapshot = await previewManualReports(port, manifest, directory);
  const checkpoint = vi.fn(async () => undefined);
  return { port, manifest, directory, snapshot, checkpoint, order, faults, writes: () => ({ catalogWrites, statusWrites }) };
}

it("previews without cloud mutations and gives every report an immutable scoped key", async () => {
  const { port, snapshot, order } = await harness();
  expect(order).toEqual([]); expect(snapshot.targets).toHaveLength(2);
  expect(port.upload).not.toHaveBeenCalled(); expect(port.commitCatalog).not.toHaveBeenCalled();
  for (const target of snapshot.targets) {
    expect(target.files.ASSESSMENT.key).toContain(`/versions/${snapshot.operationId}/assessment.pdf`);
    expect(target.files.AS_BUILT.key).toContain(`/as-built/${org}/${target.before.candidate.buildingId}/${target.before.inspectionId}/drafts/upl_`);
    expect(target.sourcePrefix).toContain("Roofus#0003/");
  }
});

it("stages all six reports before publication, checkpoints candidates first, and verifies both buildings", async () => {
  const { port, snapshot, checkpoint, order } = await harness();
  await applyManualReports(port, snapshot, checkpoint);
  expect(order.slice(0, 6)).toEqual(Array(6).fill("upload"));
  expect(order.slice(6)).toEqual(["catalog", "publish", "verify", "catalog", "publish", "verify"]);
  expect(checkpoint.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(port.commitCatalog).mock.invocationCallOrder[0]!);
  expect(snapshot.complete).toBe(true); expect(snapshot.targets.every((target) => target.verified)).toBe(true);
});

it("never publishes after an upload failure and preserves the original source/record definitions", async () => {
  const { port, snapshot, checkpoint, faults } = await harness(); faults.upload = 4;
  const before = structuredClone(snapshot.targets.map((target) => target.before));
  await expect(applyManualReports(port, snapshot, checkpoint)).rejects.toThrow("Upload failed");
  expect(port.commitCatalog).not.toHaveBeenCalled(); expect(port.publishStatus).not.toHaveBeenCalled();
  expect(snapshot.targets.map((target) => target.before)).toEqual(before); expect(snapshot.complete).toBe(false);
});

it.each(["catalogResponse", "statusResponse"] as const)("resumes an uncertain %s without duplicate writes", async (fault) => {
  const { port, snapshot, faults, writes } = await harness();
  let persisted: ManualReportSnapshot = structuredClone(snapshot);
  const checkpoint = async () => { persisted = structuredClone(snapshot); };
  faults[fault] = true;
  await expect(applyManualReports(port, snapshot, checkpoint)).rejects.toThrow("response lost");
  const resumed = manualReportSnapshotSchema.parse(persisted);
  await applyManualReports(port, resumed, async () => undefined);
  expect(writes()).toEqual({ catalogWrites: 2, statusWrites: 2 }); expect(resumed.complete).toBe(true);
});

it("rejects changed files, AWS context, ownership and edited snapshot keys before uploading", async () => {
  const { port, snapshot, directory, checkpoint, faults } = await harness();
  await expect(applyManualReports({ ...port, context: { ...context, bucket: "wrong" } }, snapshot, checkpoint)).rejects.toThrow("context");
  faults.conflict = true;
  await expect(applyManualReports(port, snapshot, checkpoint)).rejects.toThrow("ownership conflict");
  faults.conflict = false;
  const altered = structuredClone(snapshot); altered.targets[0]!.files.ASSESSMENT.key = "other-client/report.pdf";
  await expect(applyManualReports(port, altered, checkpoint)).rejects.toThrow("upload key");
  await writeFile(join(directory, "assessment.pdf"), "%PDF-1.7\nmodified\n%%EOF\n");
  await expect(applyManualReports(port, snapshot, checkpoint)).rejects.toThrow("changed since preview");
  expect(port.upload).not.toHaveBeenCalled();
});

it("rejects invalid PDF input and applies the As-built file-size/type limits", async () => {
  const { directory } = await harness();
  await writeFile(join(directory, "invalid.pdf"), "%PDF-1.7\ntruncated");
  await expect(inspectManualReportFile(join(directory, "invalid.pdf"), "ASSESSMENT")).rejects.toThrow("supported complete");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7FAAAAAASUVORK5CYII=", "base64");
  await writeFile(join(directory, "roof.png"), png);
  await expect(inspectManualReportFile(join(directory, "roof.png"), "AS_BUILT")).resolves.toMatchObject({ contentType: "image/png" });
  await expect(inspectManualReportFile(join(directory, "roof.png"), "EVIDENCE")).rejects.toThrow();
  await writeFile(join(directory, "huge.pdf"), Buffer.alloc(50 * 1024 * 1024 + 1));
  await expect(inspectManualReportFile(join(directory, "huge.pdf"), "AS_BUILT")).rejects.toThrow("size");
});

it("rejects unsupported roots and duplicate targets without URL-fragment corruption", async () => {
  expect(manualSourcePrefix("s3://reports/client/Roofus#0003/date/building/", "reports")).toBe("client/Roofus#0003/date/building/");
  for (const uri of ["s3://other/client/robot/date/building/", "s3://reports/client/../date/building/", "s3://reports/client/date/building/"]) expect(() => manualSourcePrefix(uri, "reports")).toThrow();
  const { port, manifest, directory } = await harness();
  await expect(previewManualReports(port, { ...manifest, accountId: "999999999999" }, directory)).rejects.toThrow("account/environment");
  await expect(previewManualReports(port, { ...manifest, buildings: [manifest.buildings[0], manifest.buildings[0]] }, directory)).rejects.toThrow();
  expect(MANUAL_REPORT_TYPES).toEqual(["ASSESSMENT", "EVIDENCE", "AS_BUILT"]);
});
