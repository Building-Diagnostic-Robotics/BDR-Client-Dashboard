import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { normalizeLoginEmail } from "./cognito-user-pools";
import { resolvePasswordLoginPool, secretHash, type PasswordPoolConfig } from "./password-login";

const defaultCognito = new CognitoIdentityProviderClient({});

export class PasswordResetServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "PasswordResetServiceError";
  }
}

export type PasswordResetInputConfig = PasswordPoolConfig & Readonly<{
  clientSecretArn?: string;
  cognitoClient?: CognitoIdentityProviderClient;
  hashCalculator?: (username: string, clientId: string, secretArn: string) => Promise<string>;
}>;

export async function requestPasswordReset(
  input: PasswordResetInputConfig & { email: string },
): Promise<{ accepted: true }> {
  const email = normalizeLoginEmail(input.email);
  const client = input.cognitoClient ?? defaultCognito;
  const selected = await resolvePasswordLoginPool(client, email, input);
  if (!selected) {
    return { accepted: true };
  }

  const { admin, clientId } = selected;
  const hashCalc = input.hashCalculator ?? secretHash;
  const hash = !admin && input.clientSecretArn
    ? await hashCalc(email, clientId, input.clientSecretArn)
    : undefined;

  try {
    await client.send(new ForgotPasswordCommand({
      ClientId: clientId,
      Username: email,
      ...(hash ? { SecretHash: hash } : {}),
    }));
    return { accepted: true };
  } catch (error: unknown) {
    const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (errorName === "UserNotFoundException") {
      return { accepted: true };
    }
    if (errorName === "LimitExceededException" || errorName === "TooManyRequestsException") {
      throw new PasswordResetServiceError("throttled", "Too many attempts. Please try again later.", 429);
    }
    if (errorName === "InvalidParameterException") {
      throw new PasswordResetServiceError("invalid_request", "Invalid email address format.", 400);
    }
    throw error;
  }
}

export async function confirmPasswordReset(
  input: PasswordResetInputConfig & {
    email: string;
    confirmationCode: string;
    newPassword: string;
  },
): Promise<{ reset: true }> {
  const email = normalizeLoginEmail(input.email);
  const client = input.cognitoClient ?? defaultCognito;
  const selected = await resolvePasswordLoginPool(client, email, input);
  if (!selected) {
    throw new PasswordResetServiceError("invalid_code", "Incorrect reset code.", 400);
  }

  const { admin, clientId } = selected;
  const hashCalc = input.hashCalculator ?? secretHash;
  const hash = !admin && input.clientSecretArn
    ? await hashCalc(email, clientId, input.clientSecretArn)
    : undefined;

  try {
    await client.send(new ConfirmForgotPasswordCommand({
      ClientId: clientId,
      Username: email,
      ConfirmationCode: input.confirmationCode,
      Password: input.newPassword,
      ...(hash ? { SecretHash: hash } : {}),
    }));
    return { reset: true };
  } catch (error: unknown) {
    const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (errorName === "UserNotFoundException" || errorName === "CodeMismatchException") {
      throw new PasswordResetServiceError("invalid_code", "Incorrect reset code.", 400);
    }
    if (errorName === "ExpiredCodeException") {
      throw new PasswordResetServiceError("expired_code", "This reset code has expired. Request a new code.", 400);
    }
    if (errorName === "InvalidPasswordException") {
      throw new PasswordResetServiceError("invalid_password", "Password does not meet requirements.", 400);
    }
    if (errorName === "LimitExceededException" || errorName === "TooManyRequestsException") {
      throw new PasswordResetServiceError("throttled", "Too many attempts. Please try again later.", 429);
    }
    if (errorName === "InvalidParameterException") {
      throw new PasswordResetServiceError("invalid_request", "Invalid code or password format.", 400);
    }
    throw error;
  }
}
