import { afterEach, describe, expect, it, vi } from "vitest";
import { z as serverZod } from "zod";

const initialJitless = serverZod.config().jitless;
afterEach(() => { serverZod.config({ jitless: initialJitless }); vi.unstubAllGlobals(); vi.resetModules(); });

describe("browser-safe schema initialization", () => {
  it("disables JIT before constructing browser contract schemas without weakening validation", async () => {
    vi.resetModules(); vi.stubGlobal("window", {});
    const { z } = await import("./zod");
    const { portalBuildingListResponseSchema } = await import("./portal");
    expect(z.config().jitless).toBe(true);
    expect(portalBuildingListResponseSchema.parse({ items: [], admin: false })).toEqual({ items: [], admin: false });
    expect(portalBuildingListResponseSchema.safeParse({ items: [{ buildingId: "untrusted" }], admin: false }).success).toBe(false);
    expect(portalBuildingListResponseSchema.safeParse({ items: [], admin: "false" }).success).toBe(false);
  });

  it("does not change server-side Zod configuration", async () => {
    vi.resetModules();
    const previous = serverZod.config().jitless;
    await import("./zod");
    expect(serverZod.config().jitless).toBe(previous);
  });
});
