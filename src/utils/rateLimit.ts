// Per-source rate limiter. Serializes calls under a shared key and enforces
// a minimum interval between request *completions*, so internal retries inside
// fn() cannot burst past the provider's rate limit.
//
// Provider examples requiring this utility:
//   - BASE (Bielefeld):   1 qps hard limit, access revoked on violation
//   - Nominatim (OSM):    1 qps acceptable use policy
//   - EPO OPS:            varies by tier
//
// Usage:
//   const data = await rateLimited('base', 1100, () => fetchJSON<T>(url, opts));
//
// Single-process: state lives in module-level Maps. If alexandria is later
// horizontally scaled, this becomes a distributed problem (Redis token bucket
// or similar). For now, MCP servers are single-process per Railway service.

const lastCallEnd = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();

export async function rateLimited<T>(
  key: string,
  minIntervalMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const last = lastCallEnd.get(key) ?? 0;
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      // Mark completion time regardless of success — failures still consume a
      // request slot at the provider.
      lastCallEnd.set(key, Date.now());
    }
  });
  // Detach error handling from the queue chain so one failure doesn't break
  // subsequent calls; callers receive the original `next` and see real errors.
  queues.set(key, next.catch(() => undefined));
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
