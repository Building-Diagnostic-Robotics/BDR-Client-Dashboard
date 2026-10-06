import {
  AdminGetUserCommand,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";

export type CognitoUserReader = Readonly<{
  send(command: AdminGetUserCommand): Promise<AdminGetUserCommandOutput>;
}>;

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function cognitoUserExists(
  cognito: CognitoUserReader,
  userPoolId: string,
  emailInput: string,
): Promise<boolean> {
  const email = normalizeLoginEmail(emailInput);
  try {
    await cognito.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: email,
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "UserNotFoundException") return false;
    throw error;
  }
}
