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

import { AdminGetUserCommand, AdminInitiateAuthCommand, AdminRespondToAuthChallengeCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { afterEach } from "vitest";
import { passwordLogin } from "./password-login";
afterEach(() => vi.restoreAllMocks());

function mockChallenge(challenge: string | undefined) {
  return vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockImplementation(async (command) => {
    if (command instanceof AdminGetUserCommand) {
      if (command.input.UserPoolId === "client-pool") throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
      return { Enabled: true, UserStatus: "CONFIRMED", UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] } as never;
    }
    if (command instanceof AdminRespondToAuthChallengeCommand || command instanceof AdminInitiateAuthCommand) return (challenge
      ? { ChallengeName: challenge, Session: "next-challenge" }
      : { AuthenticationResult: { AccessToken: "access", IdToken: "id", RefreshToken: "refresh" } }) as never;
    throw new Error("Unexpected command");
  });
}
it("handles a second MFA challenge after password replacement without issuing a session", async () => {
  mockChallenge("SOFTWARE_TOKEN_MFA");
  await expect(passwordLogin({ ...config, email: "admin@example.com", password: "", newPassword: "NewPassword123!", mfaSession: "prior" })).resolves.toEqual({ kind: "mfa", session: "next-challenge" });
});
it("hands new administrators and MFA setup to hosted Cognito", async () => {
  for (const challenge of ["NEW_PASSWORD_REQUIRED", "MFA_SETUP"]) {
    vi.restoreAllMocks(); mockChallenge(challenge);
    await expect(passwordLogin({ ...config, email: "admin@example.com", password: "temporary" })).resolves.toEqual({ kind: "admin-setup" });
  }
});
it("rejects an unsupported challenge instead of assuming tokens exist", async () => {
  mockChallenge("SELECT_MFA_TYPE");
  await expect(passwordLogin({ ...config, email: "admin@example.com", password: "password" })).rejects.toThrow("Unsupported authentication challenge");
});
it("returns admin tokens only after completed MFA enrollment", async () => {
  const send = mockChallenge(undefined);
  await expect(passwordLogin({ ...config, email: "admin@example.com", password: "", mfaSession: "prior", mfaCode: "123456" })).resolves.toMatchObject({ kind: "tokens", admin: true });
  expect(send.mock.calls.filter(([command]) => command instanceof AdminGetUserCommand)).toHaveLength(3);
});
