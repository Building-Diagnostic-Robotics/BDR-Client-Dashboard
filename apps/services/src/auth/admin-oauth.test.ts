import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminPoolOAuth } from "./admin-oauth";

const jwt = vi.hoisted(() => ({ group: true }));
vi.mock("jose", () => ({ createRemoteJWKSet: vi.fn(), jwtVerify: vi.fn(async (token: string) => ({ payload: token === "access"
  ? { iss: "https://issuer.example.com/admin", sub: "subject", token_use: "access", client_id: "admin-app", exp: 4102444800, "cognito:groups": jwt.group ? ["bdr-admins"] : [] }
  : { sub: "subject", token_use: "id", nonce: "nonce" } })) }));
const oauth = () => new AdminPoolOAuth({ issuer: "https://issuer.example.com/admin", clientId: "admin-app", authDomain: "https://login.example.com", callbackUrl: "https://portal.example.com/bff/auth/admin/callback", logoutUrl: "https://portal.example.com/logged-out" });
const tokens = { accessToken: "access", idToken: "id", refreshToken: "refresh" };
beforeEach(() => {
  jwt.group = true;
  vi.spyOn(CognitoIdentityProviderClient.prototype, "send").mockResolvedValue({ UserAttributes: [{ Name: "sub", Value: "subject" }], UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] } as never);
});
afterEach(() => vi.restoreAllMocks());
it("requires the group on initial, password and refresh tokens", async () => {
  jwt.group = false;
  await expect(oauth().verifyInitial(tokens, "nonce")).rejects.toThrow("group required");
  await expect(oauth().verifyIssued(tokens)).rejects.toThrow("group required");
  await expect(oauth().verifyRefresh(tokens, "https://issuer.example.com/admin", "subject")).rejects.toThrow("group required");
});
it("checks live TOTP enrollment instead of trusting token issuance", async () => {
  vi.mocked(CognitoIdentityProviderClient.prototype.send).mockResolvedValueOnce({ UserAttributes: [{ Name: "sub", Value: "subject" }], UserMFASettingList: [] } as never);
  await expect(oauth().verifyIssued(tokens)).rejects.toThrow("TOTP setup required");
  await expect(oauth().verifyInitial(tokens, "nonce")).resolves.toMatchObject({ sub: "subject" });
});
it("retains state, nonce, PKCE and the user-verification scope for hosted setup", () => {
  const url = new URL(oauth().authorizationUrl({ state: "state", nonce: "nonce", codeChallenge: "challenge" }));
  expect(url.searchParams.get("scope")).toContain("aws.cognito.signin.user.admin");
  expect(url.searchParams.get("state")).toBe("state");
  expect(url.searchParams.get("nonce")).toBe("nonce");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("prompt")).toBe("login");
});
