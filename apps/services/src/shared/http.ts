import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

export const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export function json(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  options: { cookies?: string[]; headers?: Readonly<Record<string, string>> } = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...options.headers },
    body: JSON.stringify(body),
    ...(options.cookies ? { cookies: options.cookies } : {}),
  };
}

export function redirect(location: string, cookies: string[] = []): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 302,
    headers: { "cache-control": "no-store", location, "referrer-policy": "no-referrer" },
    ...(cookies.length > 0 ? { cookies } : {}),
  };
}

export function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

export function cookies(event: APIGatewayProxyEventV2): Readonly<Record<string, string>> {
  const raw = event.cookies?.join(";") ?? header(event, "cookie") ?? "";
  const result: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !(name in result)) result[name] = value;
  }
  return result;
}

export function secureCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; maxAgeSeconds: number; sameSite: "Lax" | "Strict" },
): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${options.maxAgeSeconds}`,
    "Secure",
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

export function clearCookie(name: string, httpOnly: boolean): string {
  return secureCookie(name, "", { httpOnly, maxAgeSeconds: 0, sameSite: "Lax" });
}

export function requestId(event: APIGatewayProxyEventV2): string {
  return event.requestContext.requestId || crypto.randomUUID();
}
