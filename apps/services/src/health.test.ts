import { describe, expect, it } from "vitest";

import { handler } from "./health";

function event(method: string, rawPath: string) {
  return {
    rawPath,
    requestContext: { http: { method } },
  } as Parameters<typeof handler>[0];
}

describe("unimplemented service boundary", () => {
  it("serves a minimal health response", async () => {
    await expect(handler(event("GET", "/health"))).resolves.toMatchObject({
      statusCode: 200,
      headers: { "cache-control": "no-store" },
    });
  });

  it("fails closed for every unimplemented route", async () => {
    await expect(handler(event("GET", "/bff/me/projects"))).resolves.toMatchObject({
      statusCode: 404,
      body: JSON.stringify({ error: "not_found" }),
    });
  });
});
