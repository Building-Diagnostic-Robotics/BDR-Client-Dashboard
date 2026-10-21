import { expect, it } from "vitest";
import { createPortalReadContext, mapConcurrent } from "./read-context";

it("caps shared IO at four even when multiple bounded discovery groups run together", async () => {
  const context = createPortalReadContext(); let active = 0; let peak = 0;
  const groups = await mapConcurrent([0, 1, 2, 3], 4, (group) => mapConcurrent([0, 1, 2, 3], 4, (index) => context.run(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--; return group * 4 + index;
  })));
  expect(groups.flat()).toEqual(Array.from({ length: 16 }, (_, index) => index));
  expect(peak).toBe(4); expect(active).toBe(0);
});

it("releases IO slots after failure and waits for in-flight workers before reporting an error", async () => {
  const context = createPortalReadContext(); let inFlight = 0;
  await expect(mapConcurrent([0, 1, 2, 3, 4], 4, (index) => context.run(async () => {
    inFlight++;
    try { await new Promise<void>((resolve) => setImmediate(resolve)); if (index === 0) throw new Error("unavailable"); }
    finally { inFlight--; }
  }))).rejects.toThrow("unavailable");
  expect(inFlight).toBe(0); expect(context.failedReadCount).toBe(1);
  await expect(context.run(async () => "next request")).resolves.toBe("next request");
});
