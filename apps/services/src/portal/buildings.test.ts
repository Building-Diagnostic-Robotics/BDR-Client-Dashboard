import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCanSee,
  clientUserStatus,
  createClientAccount,
  createPortalAdmin,
  replaceClientEmail,
} from "./buildings";

afterEach(() => {
  vi.unstubAllEnvs();
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
