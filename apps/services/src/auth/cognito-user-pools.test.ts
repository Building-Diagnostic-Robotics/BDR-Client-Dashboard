import { describe, expect, it, vi } from "vitest";

import { cognitoUserExists, normalizeLoginEmail } from "./cognito-user-pools";

describe("Cognito user-pool lookup", () => {
  it("normalizes login emails", () => {
    expect(normalizeLoginEmail(" Client@Example.COM ")).toBe("client@example.com");
  });

  it("treats any returned Cognito user as existing", async () => {
    const send = vi.fn(async (_command: { input: Record<string, unknown> }) => ({ Username: "opaque-user" }));

    await expect(cognitoUserExists({ send } as never, "pool", "Client@Example.com")).resolves.toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input).toEqual({
      UserPoolId: "pool",
      Username: "client@example.com",
    });
  });

  it("returns false only when Cognito reports that the user is absent", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
    });

    await expect(cognitoUserExists({ send } as never, "pool", "missing@example.com")).resolves.toBe(false);
  });

  it("propagates operational Cognito errors", async () => {
    const error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    const send = vi.fn(async () => { throw error; });

    await expect(cognitoUserExists({ send } as never, "pool", "client@example.com")).rejects.toBe(error);
  });
});
