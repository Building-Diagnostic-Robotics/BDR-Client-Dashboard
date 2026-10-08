import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertManifestMatches, readSampleFiles, SAMPLE_FILES, sampleDataset, setupSampleDashboard, type OriginalClient, type SetupManifest, type SetupPort } from "./sample-dashboard";

let directory: string;
const email = "client@example.com";
const original: OriginalClient = { username: "old-subject", sub: "old-subject", issuer: "https://issuer.example.com/pool", organizationId: "org_old", userId: "usr_old", revision: "rev_old", status: "ACTIVE" };
const instant = "2026-10-07T20:00:00Z";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sample-dashboard-test-"));
  for (const filename of Object.values(SAMPLE_FILES)) await writeFile(join(directory, filename), "%PDF-1.4\nsample\n%%EOF\n");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function fakePort(existing: OriginalClient | null = null) {
  let manifest: SetupManifest | null = null;
  let etag: string | null = null;
  let writes = 0;
  let current = existing;
  const port = {
    context: { environment: "production" as const, accountId: "123456789012", region: "us-east-1", bucket: "sample", tenantTable: "tenant", clientPool: "pool", clientPrefix: "bdr_sample_dashboard", organizationId: "org_sample", portalOrigin: "https://portal.example.com", operatorArn: "arn:aws:iam::123456789012:user/operator" },
    readManifest: vi.fn(async () => ({ value: manifest ? structuredClone(manifest) : null, eTag: etag })),
    saveManifest: vi.fn(async (value: SetupManifest, expected: string | null) => {
      if (expected !== etag) throw new Error("Conditional checkpoint conflict");
      manifest = structuredClone(value); etag = `etag-${++writes}`; return etag;
    }),
    assertVacant: vi.fn(async () => {}),
    inspectClient: vi.fn(async () => current),
    prepareDataset: vi.fn(async () => {}), verifyDataset: vi.fn(async () => []),
    resetClient: vi.fn(async () => { current = null; }),
    createClient: vi.fn(async () => {
      current = { ...original, sub: "new-subject", username: "new-subject", organizationId: "org_sample" };
      return { username: "new-subject", sub: "new-subject" };
    }),
    mapClient: vi.fn(async () => { current = { ...original, sub: "new-subject", username: "new-subject", organizationId: "org_sample" }; }),
    verifyClient: vi.fn(async () => {}), emit: vi.fn(),
  } satisfies SetupPort;
  return { port, getManifest: () => manifest, setManifest: (value: SetupManifest) => { manifest = structuredClone(value); }, setCurrent: (value: OriginalClient | null) => { current = value; } };
}
function options(apply: boolean, resetExistingClients = true) {
  return { apply, resetExistingClients, emails: [email], reportsDirectory: directory };
}

describe("sample dashboard setup", () => {
  it("previews memberships and sample data without any writes or invitations", async () => {
    const { port } = fakePort(original);
    await setupSampleDashboard(port, options(false), () => new Date(instant));
    expect(port.emit).toHaveBeenCalledWith(expect.objectContaining({ mode: "preview", organization: "BDR - Sample Dashboard" }));
    for (const method of [port.saveManifest, port.prepareDataset, port.resetClient, port.createClient, port.mapClient]) expect(method).not.toHaveBeenCalled();
  });
  it("validates every sample PDF before acquiring a checkpoint", async () => {
    await writeFile(join(directory, SAMPLE_FILES.EVIDENCE), "%PDF-incomplete");
    const { port } = fakePort();
    await expect(setupSampleDashboard(port, options(true))).rejects.toThrow("complete PDF");
    expect(port.saveManifest).not.toHaveBeenCalled();
    expect(port.createClient).not.toHaveBeenCalled();
  });
  it("builds eight inspections with five distinct report classifications and absolute dates", () => {
    const dataset = sampleDataset(instant, "bdr_sample_dashboard");
    expect(dataset.map((building) => building.inspections.length)).toEqual([3, 3, 2]);
    expect(new Set(dataset.flatMap((building) => building.inspections.map((inspection) => inspection.prefix))).size).toBe(8);
    expect(Object.values(dataset[0]!.inspections.at(-1)!.statuses)).toEqual(Array(5).fill("AVAILABLE"));
    expect(dataset[1]!.inspections.at(-1)!.statuses.AS_BUILT).toBe("IN_PREPARATION");
    expect(dataset[2]!.inspections.at(-1)!.statuses.CAPITAL_PLANNING).toBe("NOT_INCLUDED");
    for (const building of dataset) for (const inspection of building.inspections) {
      expect(Object.keys(inspection.statuses)).toHaveLength(5);
      expect(Date.parse(inspection.uploadedAt)).toBeGreaterThan(Date.parse(inspection.scannedAt));
    }
  });
  it("requires the explicit reset flag before any apply write", async () => {
    const { port } = fakePort(original);
    await expect(setupSampleDashboard(port, options(true, false))).rejects.toThrow("--reset-existing-clients");
    expect(port.saveManifest).not.toHaveBeenCalled();
  });
  it("verifies the dataset before revoking users and never revokes after failed verification", async () => {
    const { port } = fakePort(original);
    port.verifyDataset.mockRejectedValueOnce(new Error("Missing artifact"));
    await expect(setupSampleDashboard(port, options(true))).rejects.toThrow("Missing artifact");
    expect(port.resetClient).not.toHaveBeenCalled();
    expect(port.createClient).not.toHaveBeenCalled();
  });
  it("resumes a mapping failure without another Cognito creation or reset", async () => {
    const { port, getManifest } = fakePort(original);
    port.mapClient.mockRejectedValueOnce(new Error("DynamoDB unavailable"));
    await expect(setupSampleDashboard(port, options(true), () => new Date(instant))).rejects.toThrow("DynamoDB unavailable");
    expect(getManifest()?.clients[0]?.phase).toBe("created");
    await setupSampleDashboard(port, options(true), () => new Date(instant));
    expect(port.resetClient).toHaveBeenCalledOnce();
    expect(port.createClient).toHaveBeenCalledOnce();
    expect(getManifest()?.complete).toBe(true);
  });
  it("completed reruns only verify; they do not recreate data, reset clients, or resend", async () => {
    const { port } = fakePort(original);
    await setupSampleDashboard(port, options(true), () => new Date(instant));
    await setupSampleDashboard(port, options(true), () => new Date(instant));
    expect(port.prepareDataset).toHaveBeenCalledOnce();
    expect(port.createClient).toHaveBeenCalledOnce();
    expect(port.resetClient).toHaveBeenCalledOnce();
    expect(port.verifyDataset).toHaveBeenCalledTimes(2);
  });
  it("rejects competing apply runs, altered inputs, and an uncertain new subject", async () => {
    const fake = fakePort();
    await setupSampleDashboard(fake.port, options(true), () => new Date(instant));
    const saved = fake.getManifest()!;
    const files = await readSampleFiles(directory);
    expect(() => assertManifestMatches(saved, { ...fake.port.context, tenantTable: "other" }, files, [email])).toThrow("ownership mismatch");
    fake.setManifest({ ...saved, lease: { owner: "other-run", expiresAt: "2026-10-08T20:00:00Z" } });
    await expect(setupSampleDashboard(fake.port, options(true), () => new Date(instant))).rejects.toThrow("lease");
    fake.setManifest({ ...saved, complete: false, lease: null, clients: [{ ...saved.clients[0]!, phase: "creating", sub: null, username: null }] });
    await expect(setupSampleDashboard(fake.port, options(true), () => new Date(instant))).rejects.toThrow("Unexpected client identity");
    expect(fake.port.createClient).toHaveBeenCalledOnce();
  });
});
