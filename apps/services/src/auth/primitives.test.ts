import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DomainError } from "@bdr/domain";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

import { assertMutationRequest, safeReturnTo } from "./primitives";

function event(origin: string, csrfHeader: string, csrfCookie = csrfHeader) {
  return {
    cookies: [`__Host-bdr_csrf=${csrfCookie}`],
    headers: { origin, "x-bdr-csrf": csrfHeader },
  } as unknown as APIGatewayProxyEventV2;
}

describe("browser request security", () => {
  it("accepts only local return paths", () => {
    expect(safeReturnTo("/projects/one")).toBe("/projects/one");
    expect(safeReturnTo("//attacker.example.com")).toBe("/");
    expect(safeReturnTo("/\\attacker.example.com")).toBe("/");
  });

  it("requires exact origin and matching CSRF cookie, header, and session hash", () => {
    const token = "csrf-token";
    const hash = createHash("sha256").update(token).digest("hex");
    expect(() => assertMutationRequest(event("https://portal.example.com", token), "https://portal.example.com", hash)).not.toThrow();
    expect(() => assertMutationRequest(event("https://evil.example.com", token), "https://portal.example.com", hash)).toThrow(DomainError);
    expect(() => assertMutationRequest(event("https://portal.example.com", token, "other"), "https://portal.example.com", hash)).toThrow(DomainError);
  });
});
