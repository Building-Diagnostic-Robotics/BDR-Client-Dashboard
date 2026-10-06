import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCanSee,
  clientUserStatus,
  createClientAccount,
  createPortalAdmin,
  listPortalBuildings,
  mergePortalListMetadata,
  replaceClientEmail,
  summary,
} from "./buildings";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("shared building client visibility", () => {
  it("shows an existing building after a report has been approved", () => {
    expect(clientCanSee({
      released: false,
      reports: {
        EVIDENCE: { clientVisible: true, awaitingClientAdmin: false },
      },
    }, "org_sig", false)).toBe(true);
  });

  it("keeps an unreleased building with no approved report hidden", () => {
    expect(clientCanSee({
      released: false,
      reports: {
        ASSESSMENT: { clientVisible: false, awaitingClientAdmin: true },
      },
    }, "org_sig", false)).toBe(false);
  });

  it("allows administrators to inspect an unreleased building", () => {
    expect(clientCanSee({ released: false, reports: {} }, "org_sig", true)).toBe(true);
  });
});

describe("shared client account status", () => {
  it("does not present a disabled Cognito account as signed in", () => {
    expect(clientUserStatus("ACTIVE", { Enabled: false, UserStatus: "CONFIRMED" })).toBe("REVOKED");
  });

  it("preserves invitation and active states for enabled accounts", () => {
    expect(clientUserStatus("ACTIVE", { Enabled: true, UserStatus: "FORCE_CHANGE_PASSWORD" })).toBe("INVITED");
    expect(clientUserStatus("ACTIVE", { Enabled: true, UserStatus: "CONFIRMED" })).toBe("ACTIVE");
  });
});

describe("cross-pool email uniqueness", () => {
  it("rejects administrator creation when the email exists in the client pool", async () => {
    vi.stubEnv("ADMIN_ISSUER", "https://issuer.example.com/admin-pool");
    vi.stubEnv("CLIENT_USER_POOL_ID", "client-pool");
    const send = vi.fn(async (_command: { input: Record<string, unknown> }) => ({ Username: "client-user" }));

    await expect(createPortalAdmin(" Client@Example.com ", { send } as never)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This email already belongs to a client account",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("rejects client creation when the email exists in the administrator pool", async () => {
    vi.stubEnv("ADMIN_ISSUER", "https://issuer.example.com/admin-pool");
    vi.stubEnv("CLIENT_USER_POOL_ID", "client-pool");
    vi.stubEnv("CLIENT_ISSUER", "https://issuer.example.com/client-pool");
    vi.stubEnv("IDENTITY_TABLE_NAME", "identity");
    vi.stubEnv("TENANT_DATA_TABLE_NAME", "tenant");
    const send = vi.fn(async (_command: { input: Record<string, unknown> }) => ({ Username: "admin-user" }));

    await expect(createClientAccount(
      { email: " Admin@Example.com ", clientPrefix: "client-folder" },
      { send } as never,
    )).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This email already belongs to an administrator account",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("checks a replacement email before revoking the current client", async () => {
    vi.stubEnv("ADMIN_ISSUER", "https://issuer.example.com/admin-pool");
    const send = vi.fn(async (_command: { input: Record<string, unknown> }) => ({ Username: "admin-user" }));

    await expect(replaceClientEmail(
      "client-folder",
      "current@example.com",
      "admin@example.com",
      { send } as never,
    )).rejects.toMatchObject({ code: "CONFLICT" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      UserPoolId: "admin-pool",
      Username: "admin@example.com",
    });
  });
});

describe("shared building summary and latest report update", () => {
  it("fills a missing status address from general data even when the status already has a name", () => {
    expect(mergePortalListMetadata(
      { displayName: "Main Tower", address: "" },
      { displayName: "Ignored Name", address: "100 Main Street" },
    )).toMatchObject({
      displayName: "Main Tower",
      address: "100 Main Street",
    });
  });

  it("keeps explicit status identity metadata and does not fabricate a missing address", () => {
    expect(mergePortalListMetadata(
      { displayName: "Main Tower", address: "200 Current Street" },
      { displayName: "Old Name", address: "100 Old Street" },
    )).toMatchObject({
      displayName: "Main Tower",
      address: "200 Current Street",
    });
    expect(mergePortalListMetadata(
      { displayName: "Main Tower", address: "   " },
      {},
    )).toMatchObject({
      displayName: "Main Tower",
      address: "",
    });
  });

  it("lists card summaries without full report, history, or as-built enrichment", async () => {
    vi.stubEnv("DATA_BUCKET_NAME", "portal-bucket");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const jsonResponse = (value: Record<string, unknown>) => ({
      ETag: '"etag"',
      Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify(value)) },
    });
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command) {
        const prefix = String(command.input.Prefix ?? "");
        const prefixes: Record<string, string[]> = {
          "client/": ["client/robot/"],
          "client/robot/": ["client/robot/2026-09-15/"],
          "client/robot/2026-09-15/": ["client/robot/2026-09-15/main-tower/"],
        };
        return { CommonPrefixes: (prefixes[prefix] ?? []).map((Prefix) => ({ Prefix })) } as never;
      }
      if (command instanceof GetObjectCommand) {
        const key = String(command.input.Key ?? "");
        if (key === "reportgen_portal/org_links.json") {
          return jsonResponse({ organizations: [{ organizationId: "org-client", clientPrefixes: ["client"] }] }) as never;
        }
        if (key.endsWith("reportgen/client_portal/status.json")) {
          return jsonResponse({
            displayName: "Main Tower",
            scanTime: "2026-09-15T14:00:00-04:00",
            reports: { ASSESSMENT: { clientVisible: true, generatedAt: "2026-09-16T12:00:00.000Z" } },
          }) as never;
        }
        if (key.endsWith("general_data.json")) {
          return jsonResponse({ address: "100 Main Street" }) as never;
        }
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    });

    await expect(listPortalBuildings("org-client", false)).resolves.toMatchObject([
      {
        displayName: "Main Tower",
        address: "100 Main Street",
        latestReportUpdate: "2026-09-16T12:00:00.000Z",
      },
    ]);
    expect(send.mock.calls.some(([command]) => command instanceof HeadObjectCommand)).toBe(false);
    expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(3);
  });

  it("calculates latestReportUpdate using newest timestamp among client-visible reports", () => {
    const res = summary("client/robot/2026-09-17/building/", {
      displayName: "Main Tower",
      reports: {
        ASSESSMENT: {
          clientVisible: true,
          generatedAt: "2026-09-10T10:00:00.000Z",
        },
        EVIDENCE: {
          clientVisible: true,
          generatedAt: "2026-09-15T12:00:00.000Z",
        },
        ROOF_TAKEOFF: {
          clientVisible: false,
          generatedAt: "2026-09-20T16:00:00.000Z",
        },
      },
    });

    expect(res.latestReportUpdate).toBe("2026-09-15T12:00:00.000Z");
    expect(res.readyReports).toEqual(["ASSESSMENT", "EVIDENCE"]);
  });

  it("returns null for latestReportUpdate when no reports are client-visible", () => {
    const res = summary("client/robot/2026-09-17/building/", {
      displayName: "Main Tower",
      reports: {
        ASSESSMENT: {
          clientVisible: false,
          generatedAt: "2026-09-10T10:00:00.000Z",
        },
      },
    });

    expect(res.latestReportUpdate).toBeNull();
    expect(res.readyReports).toEqual([]);
  });

  it("returns null for latestReportUpdate when client-visible reports have no timestamp", () => {
    const res = summary("client/robot/2026-09-17/building/", {
      displayName: "Main Tower",
      reports: {
        ASSESSMENT: {
          clientVisible: true,
        },
      },
    });

    expect(res.latestReportUpdate).toBeNull();
    expect(res.readyReports).toEqual(["ASSESSMENT"]);
  });
});
