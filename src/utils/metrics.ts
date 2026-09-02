// Task 5 (review 3.7): per-source and per-tool counters, exposed as JSON on
// GET /metrics (HTTP transport) and summarized on GET /health.
//
// Plain in-memory Maps, process lifetime only (like the pre-Task-4 result
// cache): these are point-in-time operational counters for one running
// process, not a durable metric store, so nothing here touches StateStore.
// A name is created lazily on first increment/read so /metrics starts as
// `{}` rather than pre-seeded with every registered source, matching how
// registry.ts only knows a source's name at registration time, not at
// module load.

export interface SourceCounters {
  calls: number;
  errors: number;
  timeouts: number;
  cacheHits: number;
  quotaRejections: number;
  latencyMsTotal: number;
}

export interface ToolCounters {
  invocations: number;
  llmCalls: number;
}

const sourceCounters = new Map<string, SourceCounters>();
const toolCounters = new Map<string, ToolCounters>();

function emptySourceCounters(): SourceCounters {
  return { calls: 0, errors: 0, timeouts: 0, cacheHits: 0, quotaRejections: 0, latencyMsTotal: 0 };
}

function emptyToolCounters(): ToolCounters {
  return { invocations: 0, llmCalls: 0 };
}

/** The live counters object for `source`, created (all zero) on first call. */
export function sourceMetrics(source: string): SourceCounters {
  let counters = sourceCounters.get(source);
  if (!counters) {
    counters = emptySourceCounters();
    sourceCounters.set(source, counters);
  }
  return counters;
}

/** The live counters object for `tool`, created (all zero) on first call. */
export function toolMetrics(tool: string): ToolCounters {
  let counters = toolCounters.get(tool);
  if (!counters) {
    counters = emptyToolCounters();
    toolCounters.set(tool, counters);
  }
  return counters;
}

/** GET /metrics body: every source/tool with at least one counter touched. */
export function metricsSnapshot(): {
  sources: Record<string, SourceCounters>;
  tools: Record<string, ToolCounters>;
} {
  return {
    sources: Object.fromEntries(sourceCounters),
    tools: Object.fromEntries(toolCounters),
  };
}

/** GET /health's `sources.calls`/`sources.errors` summary: totals across every source. */
export function sourceCallTotals(): { calls: number; errors: number } {
  let calls = 0;
  let errors = 0;
  for (const counters of sourceCounters.values()) {
    calls += counters.calls;
    errors += counters.errors;
  }
  return { calls, errors };
}

/** Test-only: clears every counter so a test starts from a known-empty state. */
export function resetMetricsForTests(): void {
  sourceCounters.clear();
  toolCounters.clear();
}
