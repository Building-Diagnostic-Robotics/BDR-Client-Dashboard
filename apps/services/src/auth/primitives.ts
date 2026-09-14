import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { authenticationRequired, forbidden } from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import { cookies, header } from "../shared/http";

export const CLIENT_SESSION_COOKIE = "__Host-bdr_client_session";
export const CLIENT_LOGIN_COOKIE = "__Host-bdr_login";
export const CLIENT_CSRF_COOKIE = "__Host-bdr_csrf";
export const CLIENT_CSRF_HEADER = "x-bdr-csrf";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function equalSecrets(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function safeReturnTo(value: string | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/\p{Cc}/u.test(value)) return "/";
  return value;
}

export function assertMutationRequest(
  event: APIGatewayProxyEventV2,
  expectedOrigin: string,
  expectedCsrfHash: string,
): void {
  if (header(event, "origin") !== expectedOrigin) forbidden();
  const csrfCookie = cookies(event)[CLIENT_CSRF_COOKIE];
  const csrfHeader = header(event, CLIENT_CSRF_HEADER);
  if (!equalSecrets(csrfCookie, csrfHeader)) forbidden();
  if (createHash("sha256").update(csrfHeader!, "utf8").digest("hex") !== expectedCsrfHash) {
    authenticationRequired();
  }
}

export function bearerToken(event: APIGatewayProxyEventV2): string {
  const authorization = header(event, "authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    authenticationRequired();
  }
  return authorization.slice(7);
}
