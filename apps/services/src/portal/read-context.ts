/** Request-local only: bounded workers plus a shared IO limit, never a publication cache. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0; let failed = false; let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]!, index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}

export type PortalReadContext = {
  getObjectCount: number;
  listObjectCount: number;
  dynamoReadCount: number;
  failedReadCount: number;
  incomplete: boolean;
  run<T>(work: () => Promise<T>): Promise<T>;
};

export function createPortalReadContext(): PortalReadContext {
  let active = 0;
  const waiting: Array<() => void> = [];
  const context: PortalReadContext = {
    getObjectCount: 0, listObjectCount: 0, dynamoReadCount: 0, failedReadCount: 0, incomplete: false,
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active < 4) active++;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try { return await work(); }
      catch (error) { context.failedReadCount++; throw error; }
      finally { const wake = waiting.shift(); if (wake) wake(); else active--; }
    },
  };
  return context;
}

export async function measuredAdminRead<T>(operation: string, requestId: string, work: (context: PortalReadContext) => Promise<T>): Promise<T> {
  const context = createPortalReadContext(); const startedAt = Date.now(); let outcome = "success";
  try { return await work(context); }
  catch (error) { outcome = "error"; throw error; }
  finally {
    console.info(JSON.stringify({ event: "portal_admin_read", operation, requestId, outcome: outcome === "success" && context.incomplete ? "partial" : outcome,
      durationMs: Date.now() - startedAt, s3GetObjectCount: context.getObjectCount,
      s3ListObjectCount: context.listObjectCount, dynamoReadCount: context.dynamoReadCount, failedReadCount: context.failedReadCount }));
  }
}
