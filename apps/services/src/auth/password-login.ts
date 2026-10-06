import { createHmac } from "node:crypto";

import {
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import type { ClientTokenSet } from "./client";
import {
  cognitoUserExists,
  normalizeLoginEmail,
  type CognitoUserReader,
} from "./cognito-user-pools";

const cognito = new CognitoIdentityProviderClient({});
const secrets = new SecretsManagerClient({});
let clientSecret: string | undefined;

export type PasswordLoginResult =
  | { kind: "tokens"; admin: boolean; tokens: ClientTokenSet }
  | { kind: "mfa"; session: string }
  | { kind: "new-password"; session: string };

type PasswordPoolConfig = Readonly<{
  adminPoolId?: string;
  adminClientId?: string;
  clientPoolId?: string;
  clientClientId?: string;
}>;

export async function resolvePasswordLoginPool(
  reader: CognitoUserReader,
  emailInput: string,
  config: PasswordPoolConfig,
): Promise<{ admin: boolean; userPoolId: string; clientId: string } | null> {
  const email = normalizeLoginEmail(emailInput);
  if (
    config.clientPoolId &&
    config.clientClientId &&
    await cognitoUserExists(reader, config.clientPoolId, email)
  ) {
    return { admin: false, userPoolId: config.clientPoolId, clientId: config.clientClientId };
  }
  if (
    config.adminPoolId &&
    config.adminClientId &&
    await cognitoUserExists(reader, config.adminPoolId, email)
  ) {
    return { admin: true, userPoolId: config.adminPoolId, clientId: config.adminClientId };
  }
  return null;
}

async function secretHash(username: string, clientId: string, secretArn: string): Promise<string> {
  if (!clientSecret) {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!result.SecretString) throw new Error("Client secret is unavailable");
    clientSecret = result.SecretString;
  }
  return createHmac("sha256", clientSecret).update(`${username}${clientId}`).digest("base64");
}

function tokensFrom(result: {
  AccessToken?: string | undefined;
  RefreshToken?: string | undefined;
  IdToken?: string | undefined;
} | undefined): ClientTokenSet {
  const accessToken = result?.AccessToken;
  const refreshToken = result?.RefreshToken;
  const idToken = result?.IdToken;
  if (!accessToken || !refreshToken || !idToken) throw new Error("Cognito did not return a session");
  return { accessToken, refreshToken, idToken };
}

export async function passwordLogin(input: {
  email: string;
  password: string;
  mfaCode?: string;
  mfaSession?: string;
  newPassword?: string;
  adminPoolId?: string;
  adminClientId?: string;
  clientPoolId?: string;
  clientClientId?: string;
  clientSecretArn?: string;
}): Promise<PasswordLoginResult> {
  const email = normalizeLoginEmail(input.email);
  const selected = await resolvePasswordLoginPool(cognito, email, input);
  if (!selected) throw new Error("unknown_account");
  const { admin, userPoolId, clientId } = selected;
  const hash = !admin && input.clientSecretArn
    ? await secretHash(email, clientId, input.clientSecretArn)
    : undefined;
  const authParameters: Record<string, string> = {
    USERNAME: email,
    PASSWORD: input.password,
    ...(hash ? { SECRET_HASH: hash } : {}),
  };
  if (input.newPassword && input.mfaSession) {
    const response = await cognito.send(new AdminRespondToAuthChallengeCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: input.mfaSession,
      ChallengeResponses: {
        USERNAME: email,
        NEW_PASSWORD: input.newPassword,
        ...(hash ? { SECRET_HASH: hash } : {}),
      },
    }));
    return { kind: "tokens", admin, tokens: tokensFrom(response.AuthenticationResult) };
  }
  if (input.mfaCode && input.mfaSession) {
    const response = await cognito.send(new AdminRespondToAuthChallengeCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: input.mfaSession,
      ChallengeResponses: {
        USERNAME: email,
        SOFTWARE_TOKEN_MFA_CODE: input.mfaCode,
        ...(hash ? { SECRET_HASH: hash } : {}),
      },
    }));
    return { kind: "tokens", admin, tokens: tokensFrom(response.AuthenticationResult) };
  }
  const started = await cognito.send(new AdminInitiateAuthCommand({
    UserPoolId: userPoolId,
    ClientId: clientId,
    AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
    AuthParameters: authParameters,
  }));
  if (started.ChallengeName === "SOFTWARE_TOKEN_MFA" && started.Session) {
    return { kind: "mfa", session: started.Session };
  }
  if (started.ChallengeName === "NEW_PASSWORD_REQUIRED" && started.Session) {
    return { kind: "new-password", session: started.Session };
  }
  return { kind: "tokens", admin, tokens: tokensFrom(started.AuthenticationResult) };
}
