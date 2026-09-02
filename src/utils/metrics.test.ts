import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdapter, register } from '../sources/registry.ts';
import {
  metricsSnapshot,
  resetMetricsForTests,
  sourceCallTotals,
  sourceMetrics,
  toolMetrics,
} from './metrics.ts';

test('metricsSnapshot / sourceMetrics / toolMetrics', async (t) => {
  t.beforeEach(() => resetMetricsForTests());

  await t.test('starts empty: no source or tool has been touched yet', () => {
    assert.deepEqual(metricsSnapshot(), { sources: {}, tools: {} });
  });

  await t.test(
    'sourceMetrics(name) creates a zeroed entry lazily and is stable across calls',
    () => {
      const a = sourceMetrics('demo');
      a.calls = 5;
      const b = sourceMetrics('demo');
      assert.equal(b.calls, 5, 'same underlying object on a second call');
    },
  );

  await t.test('toolMetrics(name) creates a zeroed entry lazily', () => {
    const counters = toolMetrics('library_ask');
    assert.deepEqual(counters, { invocations: 0, llmCalls: 0 });
  });

  await t.test(
    'a wrapped adapter search increments calls and latencyMsTotal, and appears in the snapshot',
    async () => {
      register('metrics_demo_search', {
        description: 'x',
        supportsIngest: false,
        async search() {
          return [];
        },
        async read() {
          return { title: '', authors: [] };
        },
      });

      await getAdapter('metrics_demo_search').search('q', 1);

      const snapshot = metricsSnapshot();
      const counters = snapshot.sources.metrics_demo_search;
      assert.ok(counters, 'the source appears in the /metrics snapshot after one call');
      assert.equal(counters.calls, 1);
      assert.equal(counters.errors, 0);
      assert.ok(counters.latencyMsTotal >= 0);
    },
  );

  await t.test('a cache hit increments cacheHits, not calls', async () => {
    register('metrics_demo_cache', {
      description: 'x',
      supportsIngest: false,
      async search() {
        return [
          { id: '1', source: 'metrics_demo_cache', title: 't', authors: [], hasFullText: false },
        ];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });

    const adapter = getAdapter('metrics_demo_cache');
    await adapter.search('same query', 1);
    await adapter.search('same query', 1); // second call hits resultCache

    const counters = sourceMetrics('metrics_demo_cache');
    assert.equal(counters.calls, 1, 'only the first call reaches the adapter');
    assert.equal(counters.cacheHits, 1);
  });

  await t.test('a failing adapter call increments errors', async () => {
    register('metrics_demo_error', {
      description: 'x',
      supportsIngest: false,
      async search() {
        throw new Error('boom');
      },
      async read() {
        return { title: '', authors: [] };
      },
    });

    await assert.rejects(getAdapter('metrics_demo_error').search('q', 1), /boom/);
    const counters = sourceMetrics('metrics_demo_error');
    assert.equal(counters.calls, 1);
    assert.equal(counters.errors, 1);
    assert.equal(counters.timeouts, 0);
    assert.equal(counters.quotaRejections, 0);
  });

  await t.test('a quota rejection increments quotaRejections, not errors', async () => {
    register('metrics_demo_quota', {
      description: 'x',
      supportsIngest: false,
      pacing: { dailyCap: 1 },
      async search() {
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });

    const adapter = getAdapter('metrics_demo_quota');
    await adapter.search('q1', 1);
    await assert.rejects(adapter.search('q2', 1), /Daily quota/);

    const counters = sourceMetrics('metrics_demo_quota');
    assert.equal(counters.calls, 2);
    assert.equal(counters.quotaRejections, 1);
    assert.equal(counters.errors, 0);
  });

  // Regression: latencyMsTotal used to start its clock before
  // rateLimited()'s pacing wait and reserveQuota(), so a paced source's
  // recorded "provider latency" was actually dominated by queue time. A
  // near-instant adapter paced at 300ms between calls should record a
  // TINY total latency even though the wall-clock time between the two
  // calls is well over 300ms.
  await t.test(
    'latencyMsTotal excludes the pacing wait, not just the provider call time',
    async () => {
      const PACE_MS = 300;
      register('metrics_demo_pacing_latency', {
        description: 'x',
        supportsIngest: false,
        pacing: { minIntervalMs: PACE_MS },
        async search() {
          return []; // resolves immediately - the only real "provider time" here
        },
        async read() {
          return { title: '', authors: [] };
        },
      });

      const adapter = getAdapter('metrics_demo_pacing_latency');
      const wallStart = Date.now();
      await adapter.search('q1', 1);
      // Different query -> a fresh cache key, so this second call actually
      // reaches the adapter (and the pacing queue) rather than serving from
      // searchCache.
      await adapter.search('q2', 1);
      const wallElapsed = Date.now() - wallStart;

      const counters = sourceMetrics('metrics_demo_pacing_latency');
      assert.equal(counters.calls, 2);
      assert.ok(
        wallElapsed >= PACE_MS - 20,
        `expected the second call to be paced by ~${PACE_MS}ms, wall-clock elapsed was only ${wallElapsed}ms`,
      );
      assert.ok(
        counters.latencyMsTotal < PACE_MS / 2,
        `latencyMsTotal (${counters.latencyMsTotal}ms) should exclude the ~${PACE_MS}ms pacing wait, not include it`,
      );
    },
  );
});

test('sourceCallTotals aggregates calls/errors across every source', () => {
  resetMetricsForTests();
  sourceMetrics('a').calls = 3;
  sourceMetrics('a').errors = 1;
  sourceMetrics('b').calls = 2;
  sourceMetrics('b').errors = 0;
  assert.deepEqual(sourceCallTotals(), { calls: 5, errors: 1 });
});
