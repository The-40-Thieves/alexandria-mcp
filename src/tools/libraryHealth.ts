// Task 2 (vault idea 1): library_health_check merges three layers per
// registered source into one status an agent can act on without shelling
// out to `curl /health` or reading eval/probe-latest.json itself:
//
//   1. static registry facts (hidden/auth/verifiedAt) - src/sources/registry.ts
//   2. this process's live counters - src/utils/metrics.ts
//   3. the last off-process probe run - scripts/probe.ts's
//      eval/probe-latest.json, when one exists (a separate, infrequent
//      process; this tool never runs a probe itself).
//
import fs from 'node:fs';
import path from 'node:path';
import { isConfigured, listSources } from '../sources/registry.ts';
import { sourceMetrics } from '../utils/metrics.ts';
import { utcDay } from '../utils/quotaLedger.ts';
import { stateStore } from '../utils/stateStore.ts';
import type { ResponseFormat } from './format.ts';

// Mirrors scripts/probe.ts's ProbeStatus/ProbeResult exactly - that file's
// module comment documents these as the shape of eval/probe-latest.json.
// Not imported from there: tsconfig.build.json scopes `rootDir` to `src/`
// and excludes `scripts/**/*` entirely (scripts run natively via
// `node scripts/*.ts`, never from dist), so even a type-only import from
// scripts/probe.ts fails `npm run build`'s rootDir check. A future change
// to probe.ts's status set needs updating here too - a small price for a
// build that never has to reach outside src/.
type ProbeStatus = 'OK' | 'EMPTY' | 'EMPTY_REGRESSION' | 'ERROR' | 'TIMEOUT' | 'KEY_MISSING';
interface ProbeResult {
  status: ProbeStatus;
  ms: number;
  count: number;
  message?: string;
}

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'key_missing' | 'unknown';

export interface SourceHealth {
  name: string;
  cluster: string;
  status: HealthStatus;
  // Present in `response_format: "detailed"` only; concise rows omit them.
  kind?: string;
  errorRate?: number;
  avgLatencyMs?: number;
  quotaUsed?: number;
  note?: string;
}

export interface LibraryHealthResult {
  generatedAt: string;
  probeAt?: string;
  sources: SourceHealth[];
}

export interface LibraryHealthOptions {
  source?: string;
  cluster?: string;
  response_format?: ResponseFormat;
  // Test seams: production always reads the repo's real probe file and the
  // real clock. A test points probePath at a fixture instead of touching
  // eval/probe-latest.json (which npm test writes as a side effect of
  // other things, and which must never be committed).
  probePath?: string;
  now?: number;
}

interface ProbeFile {
  generatedAt: string;
  results: Record<string, ProbeResult>;
}

const DEFAULT_PROBE_PATH = path.resolve(import.meta.dirname, '../../eval/probe-latest.json');
const PROBE_CACHE_TTL_MS = 60_000;

interface ProbeCacheEntry {
  data: ProbeFile | undefined;
  loadedAt: number;
}

// Keyed by path (not a single slot) so a test fixture path and the real
// default path never share a cache entry.
const probeCache = new Map<string, ProbeCacheEntry>();

// Reads and parses eval/probe-latest.json at most once per PROBE_CACHE_TTL_MS
// per path: an agent calling library_health_check repeatedly in one session
// should not re-stat and re-parse a file that only scripts/probe.ts (a
// separate, infrequent process) ever rewrites. Absent or corrupt is treated
// exactly like "no probe has ever run" - caught here, never left to throw
// into the tool handler.
function loadProbeFile(probePath: string, now: number): ProbeFile | undefined {
  const cached = probeCache.get(probePath);
  if (cached && now - cached.loadedAt < PROBE_CACHE_TTL_MS) return cached.data;
  let data: ProbeFile | undefined;
  try {
    data = JSON.parse(fs.readFileSync(probePath, 'utf8')) as ProbeFile;
  } catch {
    data = undefined;
  }
  probeCache.set(probePath, { data, loadedAt: now });
  return data;
}

/** Test-only: clears the probe-file read cache so a test can point at a fresh fixture. */
export function resetHealthProbeCacheForTests(): void {
  probeCache.clear();
}

// Status rules (task-2 brief), checked in order - the first that matches
// wins:
//   1. key_missing: hidden specifically because a required key/env is
//      absent (not a source hidden by explicit choice with no auth spec).
//   2. down: the last probe errored or timed out, AND this process's own
//      live errorRate backs that up (>= 0.5) or has made no calls of its
//      own to contradict it (calls === 0).
//   3. degraded: a meaningfully elevated live error rate (>= 0.2), or the
//      last probe silently regressed from OK to EMPTY (scripts/probe.ts's
//      EMPTY_REGRESSION).
//   4. unknown: no probe has ever run AND this process has never called
//      the source either - there is no evidence either way, so this is
//      not the same claim as "ok".
//   5. ok: otherwise.
function classifyStatus(
  errorRate: number,
  calls: number,
  hiddenForAuth: boolean,
  probe: ProbeResult | undefined,
): HealthStatus {
  if (hiddenForAuth) return 'key_missing';
  if (
    probe &&
    (probe.status === 'ERROR' || probe.status === 'TIMEOUT') &&
    (errorRate >= 0.5 || calls === 0)
  ) {
    return 'down';
  }
  if (errorRate >= 0.2 || probe?.status === 'EMPTY_REGRESSION') return 'degraded';
  if (!probe && calls === 0) return 'unknown';
  return 'ok';
}

export function libraryHealth(options: LibraryHealthOptions = {}): LibraryHealthResult {
  const {
    source,
    cluster,
    response_format = 'concise',
    probePath = DEFAULT_PROBE_PATH,
    now = Date.now(),
  } = options;

  const probeFile = loadProbeFile(probePath, now);
  const quotaBySource = stateStore.quotaForDay(utcDay(new Date(now)));

  const sources = listSources()
    .filter((s) => !source || s.name === source)
    .filter((s) => !cluster || s.cluster === cluster)
    .map((s): SourceHealth => {
      const metrics = sourceMetrics(s.name);
      const errorRate = metrics.errors / Math.max(metrics.calls, 1);
      const avgLatencyMs = metrics.latencyMsTotal / Math.max(metrics.calls, 1);
      const probe = probeFile?.results[s.name];
      const hiddenForAuth = Boolean(s.hidden && s.auth && !isConfigured(s.auth));
      const status = classifyStatus(errorRate, metrics.calls, hiddenForAuth, probe);
      const note = hiddenForAuth ? `requires ${s.auth?.env}` : probe?.message;

      if (response_format === 'detailed') {
        const row: SourceHealth = {
          name: s.name,
          cluster: s.cluster,
          kind: s.kind,
          status,
          errorRate,
          avgLatencyMs,
        };
        const quotaUsed = quotaBySource.get(s.name);
        if (quotaUsed !== undefined) row.quotaUsed = quotaUsed;
        if (note) row.note = note;
        return row;
      }
      const row: SourceHealth = { name: s.name, cluster: s.cluster, status };
      if (note) row.note = note;
      return row;
    });

  const result: LibraryHealthResult = { generatedAt: new Date(now).toISOString(), sources };
  if (probeFile?.generatedAt) result.probeAt = probeFile.generatedAt;
  return result;
}
