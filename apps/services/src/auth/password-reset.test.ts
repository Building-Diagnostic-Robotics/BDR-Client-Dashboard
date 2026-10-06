import { describe, expect, it, vi } from "vitest";

import {
  confirmPasswordReset,
  PasswordResetServiceError,
  requestPasswordReset,
} from "./password-reset";

const config = {
  clientPoolId: "client-pool",
  clientClientId: "client-app",
  clientSecretArn: "arn:aws:secretsmanager:region:account:secret:client-secret",
  adminPoolId: "admin-pool",
  adminClientId: "admin-app",
};

describe("requestPasswordReset", () => {
  it("resolves client pool first and sends ForgotPassword with SecretHash", async () => {
    const send = vi.fn(async (command: { input?: Record<string, unknown>; constructor: { name: string } }) => {
      // User pool check
      if (command.input?.UserPoolId) {
        return { Username: "client-user" };
      }
      return {};
    });
    const hashCalc = vi.fn(async () => "computed-secret-hash");

    const result = await requestPasswordReset({
      ...config,
      email: "Client@Example.com",
      cognitoClient: { send } as never,
      hashCalculator: hashCalc,
    });

    expect(result).toEqual({ accepted: true });
    expect(hashCalc).toHaveBeenCalledWith("client@example.com", "client-app", config.clientSecretArn);
    // Verified forgot password command sent
    expect(send).toHaveBeenCalledTimes(2); // 1: cognitoUserExists, 2: ForgotPasswordCommand
    const forgotCall = send.mock.calls[1]?.[0];
    expect(forgotCall?.input).toEqual({
      ClientId: "client-app",
      Username: "client@example.com",
      SecretHash: "computed-secret-hash",
    });
  });

  it("falls back to administrator pool when client is absent and omits secret hash", async () => {
    const send = vi.fn(async (command: { input?: { UserPoolId?: string } }) => {
      if (command.input?.UserPoolId === "client-pool") {
        throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
      }
      if (command.input?.UserPoolId === "admin-pool") {
        return { Username: "admin-user" };
      }
      return {};
    });
    const hashCalc = vi.fn(async () => "should-not-be-called");

    const result = await requestPasswordReset({
      ...config,
      email: "Admin@Example.com",
      cognitoClient: { send } as never,
      hashCalculator: hashCalc,
    });

    expect(result).toEqual({ accepted: true });
    expect(hashCalc).not.toHaveBeenCalled();
    const forgotCall = send.mock.calls[2]?.[0];
    expect(forgotCall?.input).toEqual({
      ClientId: "admin-app",
      Username: "admin@example.com",
    });
  });

  it("returns accepted: true without sending ForgotPassword when email is absent from both pools", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
    });

    const result = await requestPasswordReset({
      ...config,
      email: "Unknown@Example.com",
      cognitoClient: { send } as never,
    });

    expect(result).toEqual({ accepted: true });
    // Lookups performed in both pools, but no ForgotPassword command issued
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("handles Cognito UserNotFoundException gracefully with accepted: true", async () => {
    const send = vi.fn(async (command: { input?: { UserPoolId?: string } }) => {
      if (command.input?.UserPoolId === "client-pool") {
        return { Username: "client-user" };
      }
      throw Object.assign(new Error("user not found"), { name: "UserNotFoundException" });
    });

    const result = await requestPasswordReset({
      ...config,
      email: "client@example.com",
      cognitoClient: { send } as never,
      hashCalculator: async () => "hash",
    });

    expect(result).toEqual({ accepted: true });
  });

  it("maps Cognito rate limiting to throttled error", async () => {
    const send = vi.fn(async (command: { input?: { UserPoolId?: string } }) => {
      if (command.input?.UserPoolId === "client-pool") {
        return { Username: "client-user" };
      }
      throw Object.assign(new Error("too many requests"), { name: "LimitExceededException" });
    });

    await expect(requestPasswordReset({
      ...config,
      email: "client@example.com",
      cognitoClient: { send } as never,
      hashCalculator: async () => "hash",
    })).rejects.toMatchObject({
      name: "PasswordResetServiceError",
      code: "throttled",
      statusCode: 429,
    });
  });
});

describe("confirmPasswordReset", () => {
  it("confirms password reset for client with secret hash", async () => {
    const send = vi.fn(async (command: { input?: { UserPoolId?: string } }) => {
      if (command.input?.UserPoolId === "client-pool") {
        return { Username: "client-user" };
      }
      return {};
    });
    const hashCalc = vi.fn(async () => "computed-secret-hash");

    const result = await confirmPasswordReset({
      ...config,
      email: "Client@Example.com",
      confirmationCode: "123456",
      newPassword: "NewSecretPassword123!",
      cognitoClient: { send } as never,
      hashCalculator: hashCalc,
    });

    expect(result).toEqual({ reset: true });
    expect(hashCalc).toHaveBeenCalledWith("client@example.com", "client-app", config.clientSecretArn);
    const confirmCall = send.mock.calls[1]?.[0];
    expect(confirmCall?.input).toEqual({
      ClientId: "client-app",
      Username: "client@example.com",
      ConfirmationCode: "123456",
      Password: "NewSecretPassword123!",
      SecretHash: "computed-secret-hash",
    });
  });

  it("rejects with invalid_code when account does not exist in any pool", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("missing"), { name: "UserNotFoundException" });
    });

    await expect(confirmPasswordReset({
      ...config,
      email: "unknown@example.com",
      confirmationCode: "123456",
      newPassword: "NewSecretPassword123!",
      cognitoClient: { send } as never,
    })).rejects.toMatchObject({
      name: "PasswordResetServiceError",
      code: "invalid_code",
      message: "Incorrect reset code.",
      statusCode: 400,
    });
  });

  it.each([
    { exception: "CodeMismatchException", expectedCode: "invalid_code", expectedMessage: "Incorrect reset code.", expectedStatus: 400 },
    { exception: "ExpiredCodeException", expectedCode: "expired_code", expectedMessage: "This reset code has expired. Request a new code.", expectedStatus: 400 },
    { exception: "InvalidPasswordException", expectedCode: "invalid_password", expectedMessage: "Password does not meet requirements.", expectedStatus: 400 },
    { exception: "LimitExceededException", expectedCode: "throttled", expectedMessage: "Too many attempts. Please try again later.", expectedStatus: 429 },
  ])("maps Cognito $exception to $expectedCode ($expectedStatus)", async ({ exception, expectedCode, expectedMessage, expectedStatus }) => {
    const send = vi.fn(async (command: { input?: { UserPoolId?: string } }) => {
      if (command.input?.UserPoolId === "client-pool") {
        return { Username: "client-user" };
      }
      throw Object.assign(new Error(exception), { name: exception });
    });

    await expect(confirmPasswordReset({
      ...config,
      email: "client@example.com",
      confirmationCode: "123456",
      newPassword: "NewSecretPassword123!",
      cognitoClient: { send } as never,
      hashCalculator: async () => "hash",
    })).rejects.toMatchObject({
      name: "PasswordResetServiceError",
      code: expectedCode,
      message: expectedMessage,
      statusCode: expectedStatus,
    });
  });
});
