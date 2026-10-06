import { describe, expect, it, vi } from "vitest";

import { resolvePasswordLoginPool } from "./password-login";

const config = {
  clientPoolId: "client-pool",
  clientClientId: "client-app",
  adminPoolId: "admin-pool",
  adminClientId: "admin-app",
};

describe("password login pool resolution", () => {
  it("uses the client pool without querying the administrator pool when the client exists", async () => {
    const send = vi.fn(async (_command: { input: { UserPoolId?: string } }) => ({ Username: "client-user" }));

    await expect(resolvePasswordLoginPool(
      { send } as never,
      " Client@Example.com ",
      config,
    )).resolves.toEqual({ admin: false, userPoolId: "client-pool", clientId: "client-app" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input.UserPoolId).toBe("client-pool");
  });

  it("falls back to the administrator pool when the client is absent", async () => {
    const send = vi.fn(async (command: { input: { UserPoolId?: string } }) => {
      if (command.input.UserPoolId === "client-pool") {
        throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
      }
      return { Username: "admin-user" };
    });

    await expect(resolvePasswordLoginPool(
      { send } as never,
      "admin@example.com",
      config,
    )).resolves.toEqual({ admin: true, userPoolId: "admin-pool", clientId: "admin-app" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("returns no pool when the email is absent from both", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
    });

    await expect(resolvePasswordLoginPool(
      { send } as never,
      "missing@example.com",
      config,
    )).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
