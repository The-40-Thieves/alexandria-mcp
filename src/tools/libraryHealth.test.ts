import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from '../sources/registry.ts';
import { resetMetricsForTests, sourceMetrics } from '../utils/metrics.ts';
import { utcDay } from '../utils/quotaLedger.ts';
import { stateStore } from '../utils/stateStore.ts';
import { libraryHealth, resetHealthProbeCacheForTests } from './libraryHealth.ts';

const FIXTURE_PROBE_PATH = path.resolve(process.cwd(), 'eval/fixtures/health-probe.json');

function registerPlain(name: string, extra: Partial<Parameters<typeof register>[1]> = {}): void {
  register(name, {
    description: 'x',
    supportsIngest: true,
    async search() {
      return [];
    },
    async read() {
      return { title: '', authors: [] };
    },
    ...extra,
  });
}

test('libraryHealth', async (t) => {
  t.beforeEach(() => {
    resetMetricsForTests();
    resetHealthProbeCacheForTests();
  });

  await t.test('key_missing: hidden specifically because a required auth env is absent', () => {
    delete process.env.T_HEALTH_KEY;
    registerPlain('t_health_key_missing', {
      auth: { type: 'query', env: 'T_HEALTH_KEY', param: 'key' },
    });
    const { sources } = libraryHealth({
      source: 't_health_key_missing',
      response_format: 'detailed',
      probePath: FIXTURE_PROBE_PATH,
    });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.status, 'key_missing');
    assert.equal(sources[0]?.note, 'requires T_HEALTH_KEY');
  });

  await t.test('down: last probe ERROR and live errorRate >= 0.5', () => {
    registerPlain('t_health_down');
    const metrics = sourceMetrics('t_health_down');
    metrics.calls = 4;
    metrics.errors = 4;
    const { sources } = libraryHealth({ source: 't_health_down', probePath: FIXTURE_PROBE_PATH });
    assert.equal(sources[0]?.status, 'down');
  });

  await t.test('down: last probe TIMEOUT and this process has made no calls of its own', () => {
    registerPlain('t_health_down_no_calls');
    const { sources } = libraryHealth({
      source: 't_health_down_no_calls',
      probePath: FIXTURE_PROBE_PATH,
    });
    assert.equal(sources[0]?.status, 'down');
  });

  await t.test('not down: last probe ERROR but live errorRate is low and calls > 0', () => {
    registerPlain('t_health_down');
    const metrics = sourceMetrics('t_health_down');
    metrics.calls = 10;
    metrics.errors = 1; // errorRate 0.1, below both the down (0.5) and degraded (0.2) thresholds
    const { sources } = libraryHealth({ source: 't_health_down', probePath: FIXTURE_PROBE_PATH });
    assert.notEqual(sources[0]?.status, 'down');
  });

  await t.test('degraded: live errorRate >= 0.2 with no probe data', () => {
    registerPlain('t_health_degraded');
    const metrics = sourceMetrics('t_health_degraded');
    metrics.calls = 5;
    metrics.errors = 1; // errorRate exactly 0.2
    const { sources } = libraryHealth({
      source: 't_health_degraded',
      probePath: FIXTURE_PROBE_PATH,
    });
    assert.equal(sources[0]?.status, 'degraded');
  });

  await t.test('degraded: last probe silently regressed (EMPTY_REGRESSION)', () => {
    registerPlain('t_health_regression');
    const { sources } = libraryHealth({
      source: 't_health_regression',
      probePath: FIXTURE_PROBE_PATH,
    });
    assert.equal(sources[0]?.status, 'degraded');
  });

  await t.test('unknown: no probe data and this process has never called the source', () => {
    registerPlain('t_health_unknown');
    const { sources } = libraryHealth({
      source: 't_health_unknown',
      probePath: FIXTURE_PROBE_PATH,
    });
    assert.equal(sources[0]?.status, 'unknown');
  });

  await t.test('ok: calls made, low errorRate, no negative probe signal', () => {
    registerPlain('t_health_ok_probe');
    const metrics = sourceMetrics('t_health_ok_probe');
    metrics.calls = 10;
    metrics.errors = 0;
    const { sources } = libraryHealth({
      source: 't_health_ok_probe',
      probePath: FIXTURE_PROBE_PATH,
    });
    assert.equal(sources[0]?.status, 'ok');
  });

  await t.test("probeAt reflects the probe file's generatedAt when present", () => {
    registerPlain('t_health_ok_probe');
    const result = libraryHealth({ source: 't_health_ok_probe', probePath: FIXTURE_PROBE_PATH });
    assert.equal(result.probeAt, '2026-09-01T00:00:00.000Z');
  });

  await t.test('probeAt is absent when the probe file does not exist', () => {
    registerPlain('t_health_no_probe_file');
    const result = libraryHealth({
      source: 't_health_no_probe_file',
      probePath: '/nonexistent/probe.json',
    });
    assert.equal(result.probeAt, undefined);
  });

  await t.test('filters by source and by cluster', () => {
    registerPlain('t_health_filter_a', { cluster: 'security' });
    registerPlain('t_health_filter_b', { cluster: 'security' });
    registerPlain('t_health_filter_c', { cluster: 'developer' });
    const bySource = libraryHealth({ source: 't_health_filter_a', probePath: FIXTURE_PROBE_PATH });
    assert.deepEqual(
      bySource.sources.map((s) => s.name),
      ['t_health_filter_a'],
    );
    const byCluster = libraryHealth({ cluster: 'developer', probePath: FIXTURE_PROBE_PATH });
    assert.deepEqual(
      byCluster.sources.map((s) => s.name),
      ['t_health_filter_c'],
    );
  });

  await t.test('concise response_format omits kind/errorRate/avgLatencyMs/quotaUsed', () => {
    registerPlain('t_health_concise');
    const metrics = sourceMetrics('t_health_concise');
    metrics.calls = 3;
    metrics.errors = 0;
    const { sources } = libraryHealth({
      source: 't_health_concise',
      response_format: 'concise',
      probePath: FIXTURE_PROBE_PATH,
    });
    const row = sources[0];
    assert.ok(row);
    assert.equal(row.kind, undefined);
    assert.equal(row.errorRate, undefined);
    assert.equal(row.avgLatencyMs, undefined);
    assert.equal(row.quotaUsed, undefined);
  });

  await t.test(
    'detailed response_format includes kind/errorRate/avgLatencyMs and quotaUsed',
    () => {
      registerPlain('t_health_detailed');
      const metrics = sourceMetrics('t_health_detailed');
      metrics.calls = 4;
      metrics.errors = 1;
      metrics.latencyMsTotal = 800;
      const now = Date.now();
      stateStore.reserveQuota('t_health_detailed', utcDay(new Date(now)), 100);
      const { sources } = libraryHealth({
        source: 't_health_detailed',
        response_format: 'detailed',
        probePath: FIXTURE_PROBE_PATH,
        now,
      });
      const row = sources[0];
      assert.ok(row);
      assert.equal(row.kind, 'rest');
      assert.equal(row.errorRate, 0.25);
      assert.equal(row.avgLatencyMs, 200);
      assert.equal(row.quotaUsed, 1);
    },
  );

  await t.test('the probe file is read lazily and cached for 60s per path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'alexandria-health-'));
    const probePath = path.join(dir, 'probe.json');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    registerPlain('t_health_cache_probe');

    writeFileSync(
      probePath,
      JSON.stringify({
        generatedAt: '2026-09-01T00:00:00.000Z',
        results: { t_health_cache_probe: { status: 'OK', ms: 10, count: 1 } },
      }),
    );
    const t0 = 1_000_000;
    const first = libraryHealth({ source: 't_health_cache_probe', probePath, now: t0 });
    assert.equal(first.probeAt, '2026-09-01T00:00:00.000Z');

    // Rewrite the file with different content; a read within 60s of the
    // first must still see the cached (stale) value.
    writeFileSync(
      probePath,
      JSON.stringify({
        generatedAt: '2026-09-02T00:00:00.000Z',
        results: { t_health_cache_probe: { status: 'ERROR', ms: 10, count: 0 } },
      }),
    );
    const stillCached = libraryHealth({
      source: 't_health_cache_probe',
      probePath,
      now: t0 + 59_000,
    });
    assert.equal(stillCached.probeAt, '2026-09-01T00:00:00.000Z');

    // Past the 60s window, the fresh content is read.
    const refreshed = libraryHealth({
      source: 't_health_cache_probe',
      probePath,
      now: t0 + 61_000,
    });
    assert.equal(refreshed.probeAt, '2026-09-02T00:00:00.000Z');
  });
});

// Final wave (E7): a probe file that PARSES but has the wrong shape - a
// truncated write, an older format, `{}` - left `results` undefined, and
// the first `results[name]` read threw TypeError out of the one tool
// handler that had no try/catch. Absent and corrupt were already meant to
// read the same way; shape is part of corrupt now.
test('libraryHealth: a valid-JSON probe file of the wrong shape reads as no probe', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alexandria-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cases: Record<string, string> = {
    'empty-object.json': '{}',
    'no-results.json': JSON.stringify({ generatedAt: '2026-09-03T00:00:00.000Z' }),
    'results-is-an-array.json': JSON.stringify({
      generatedAt: '2026-09-03T00:00:00.000Z',
      results: [],
    }),
    'results-is-a-string.json': JSON.stringify({
      generatedAt: '2026-09-03T00:00:00.000Z',
      results: 'nope',
    }),
    'top-level-array.json': '[]',
    'top-level-null.json': 'null',
  };

  for (const [name, body] of Object.entries(cases)) {
    const probePath = path.join(dir, name);
    writeFileSync(probePath, body);
    resetHealthProbeCacheForTests();
    const result = libraryHealth({ probePath });
    assert.equal(result.probeAt, undefined, `${name}: no probe timestamp is reported`);
    assert.ok(result.sources.length > 0, `${name}: sources are still reported`);
  }

  // And a well-formed file is still read.
  const good = path.join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ generatedAt: '2026-09-03T00:00:00.000Z', results: {} }));
  resetHealthProbeCacheForTests();
  assert.equal(libraryHealth({ probePath: good }).probeAt, '2026-09-03T00:00:00.000Z');
});
