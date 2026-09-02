import { strict as assert } from 'node:assert';
import test, { describe, it } from 'node:test';
import { fetchJSON } from '../utils/http.ts';
import {
  catalog,
  getAdapter,
  healthSummary,
  listSources,
  READ_MAX_CHARS,
  register,
  truncateText,
} from './registry.ts';

describe('truncateText', () => {
  it('returns exact string if below max limit', () => {
    const text = 'Hello world';
    const result = truncateText(text);
    assert.deepEqual(result, {
      text: 'Hello world',
      charCount: 11,
      truncated: false,
      truncatedAt: undefined,
    });
  });

  it('returns exact string if exactly at max limit', () => {
    const text = 'a'.repeat(READ_MAX_CHARS);
    const result = truncateText(text);
    assert.deepEqual(result, {
      text,
      charCount: READ_MAX_CHARS,
      truncated: false,
      truncatedAt: undefined,
    });
  });

  it('truncates string if above max limit', () => {
    const overflow = 50;
    const text = 'a'.repeat(READ_MAX_CHARS) + 'b'.repeat(overflow);
    const result = truncateText(text);
    assert.deepEqual(result, {
      text: 'a'.repeat(READ_MAX_CHARS),
      charCount: READ_MAX_CHARS + overflow,
      truncated: true,
      truncatedAt: READ_MAX_CHARS,
    });
  });
});

test('registry v2', async (t) => {
  await t.test('applies defaults and exposes metadata', () => {
    register('t_defaults', {
      description: 'x',
      supportsIngest: false,
      async search() {
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    const s = listSources().find((x) => x.name === 't_defaults');
    assert.ok(s);
    assert.equal(s.kind, 'rest');
    assert.equal(s.freshness, 'static');
    assert.equal(s.timeoutMs, 15000);
  });

  await t.test('keyed source without env is hidden from catalog but still resolvable', () => {
    delete process.env.T_KEY;
    register('t_keyed', {
      description: 'x',
      supportsIngest: false,
      auth: { type: 'query', env: 'T_KEY', param: 'key' },
      async search() {
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    assert.ok(!catalog().some((c) => c.name === 't_keyed'));
    assert.ok(getAdapter('t_keyed'));
  });

  await t.test('getAdapter wraps search with the daily quota cap from pacing', async () => {
    let calls = 0;
    register('t_capped', {
      description: 'x',
      supportsIngest: false,
      pacing: { dailyCap: 2 },
      async search() {
        calls++;
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    const adapter = getAdapter('t_capped');
    await adapter.search('q1', 1);
    await adapter.search('q2', 1);
    await assert.rejects(adapter.search('q3', 1), /Daily quota/);
    assert.equal(calls, 2);
  });

  await t.test(
    'getAdapter reserves quota atomically: 6 concurrent calls against dailyCap 3 yield exactly 3 successes and 3 QuotaExceededError rejections',
    async () => {
      register('t_concurrent', {
        description: 'x',
        supportsIngest: false,
        pacing: { dailyCap: 3 },
        async search() {
          return [];
        },
        async read() {
          return { title: '', authors: [] };
        },
      });
      const adapter = getAdapter('t_concurrent');
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => adapter.search(`q${i}`, 1)),
      );
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      assert.equal(fulfilled.length, 3);
      assert.equal(rejected.length, 3);
    },
  );

  await t.test('getAdapter caches an identical search without re-calling the adapter', async () => {
    let calls = 0;
    register('t_cached', {
      description: 'x',
      supportsIngest: false,
      async search() {
        calls++;
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    const adapter = getAdapter('t_cached');
    await adapter.search('same query', 3);
    await adapter.search('same query', 3);
    assert.equal(calls, 1);
  });

  await t.test('getAdapter returns a stable wrapped instance per name', () => {
    register('t_stable', {
      description: 'x',
      supportsIngest: false,
      async search() {
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    assert.equal(getAdapter('t_stable'), getAdapter('t_stable'));
  });

  await t.test(
    'a registry timeout aborts the ambient signal, so fetchWithRetry cancels the in-flight fetch and never retries',
    async () => {
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      let capturedSignal: AbortSignal | undefined;
      // A fetch that never settles on its own, matching a hung real
      // request, except by rejecting once its (combined) signal aborts,
      // the same as a real fetch() call behaves when its signal fires.
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        fetchCalls++;
        const signal = init?.signal;
        capturedSignal = signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) return;
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      }) as typeof fetch;

      try {
        register('t_timeout_abort', {
          description: 'x',
          supportsIngest: false,
          timeoutMs: 100,
          async search() {
            // Default retries and timeoutMs (unchanged): the registry's own
            // 100ms source timeout above is what should cut this short, not
            // fetchJSON's own (much longer) default per-attempt timeout.
            await fetchJSON('https://example.invalid/t-timeout-abort');
            return [];
          },
          async read() {
            return { title: '', authors: [] };
          },
        });

        const start = Date.now();
        await assert.rejects(
          getAdapter('t_timeout_abort').search('q', 1),
          /This operation was aborted/,
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 80 && elapsed < 500, `expected a ~100ms timeout, got ${elapsed}ms`);
        assert.equal(fetchCalls, 1);

        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(fetchCalls, 1, 'no retry should have started after the caller aborted');
        assert.ok(
          capturedSignal?.aborted,
          'the ambient signal should be aborted after the timeout',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await t.test(
    'a nested guarded call (outer adapter calling getAdapter(inner).search()) chains the outer abort to the inner: the outer times out at ~100ms and the inner fetch is aborted along with it, never retried',
    async () => {
      const originalFetch = globalThis.fetch;
      let innerFetchCalls = 0;
      let innerSignal: AbortSignal | undefined;
      // Never settles on its own; only rejects once its own (inner)
      // signal aborts. Without chaining, that signal is the inner call's
      // own controller, which nothing ever aborts within the 100ms the
      // outer allows (the inner's own default timeout is 15000ms) - so
      // this would hang until this test's own timeout without the fix.
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        innerFetchCalls++;
        innerSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (!innerSignal) return;
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (innerSignal.aborted) onAbort();
          else innerSignal.addEventListener('abort', onAbort, { once: true });
        });
      }) as typeof fetch;

      try {
        register('t_nested_inner', {
          description: 'x',
          supportsIngest: false,
          // No timeoutMs override: defaults to 15000ms, far longer than
          // the outer's 100ms below, so the inner call only stops early
          // if the outer's abort is actually chained through to it.
          async search() {
            await fetchJSON('https://example.invalid/t-nested-inner');
            return [];
          },
          async read() {
            return { title: '', authors: [] };
          },
        });
        register('t_nested_outer', {
          description: 'x',
          supportsIngest: false,
          timeoutMs: 100,
          async search(query, limit) {
            return getAdapter('t_nested_inner').search(query, limit);
          },
          async read() {
            return { title: '', authors: [] };
          },
        });

        const start = Date.now();
        await assert.rejects(
          getAdapter('t_nested_outer').search('q', 1),
          /This operation was aborted/,
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed >= 80 && elapsed < 500, `expected a ~100ms timeout, got ${elapsed}ms`);
        assert.equal(innerFetchCalls, 1);
        assert.ok(
          innerSignal?.aborted,
          'the inner adapter call should have been aborted when the outer timed out',
        );

        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(
          innerFetchCalls,
          1,
          'the inner call should not have started a retry after being aborted',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

describe('healthSummary', () => {
  it('counts a newly registered visible source into sources/visible/byKind', () => {
    const before = healthSummary();
    register('t_health_visible', {
      description: 'x',
      supportsIngest: false,
      kind: 'rss',
      async search() {
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    const after = healthSummary();
    assert.equal(after.sources, before.sources + 1);
    assert.equal(after.visible, before.visible + 1);
    assert.equal(after.hidden, before.hidden);
    assert.equal(after.byKind.rss, before.byKind.rss + 1);
  });

  it('counts a hidden source into sources/hidden but not visible', () => {
    const before = healthSummary();
    register('t_health_hidden', {
      description: 'x',
      supportsIngest: false,
      kind: 'mcp',
      hidden: true,
      async search() {
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    const after = healthSummary();
    assert.equal(after.sources, before.sources + 1);
    assert.equal(after.visible, before.visible);
    assert.equal(after.hidden, before.hidden + 1);
    assert.equal(after.byKind.mcp, before.byKind.mcp + 1);
  });
});

// Regression test for the guard ordering bug: quota was reserved and the
// timeout timer started before the pacing wait, so every paced source failed
// with "This operation was aborted" while it was still queued and burned a
// quota unit for a call that never reached the provider.
describe('withGuards guard ordering', () => {
  it('paces outside the timeout so queued calls are not aborted', async () => {
    let calls = 0;
    register('t_pacing_order', {
      description: 'synthetic paced source',
      supportsIngest: false,
      kind: 'rest',
      hidden: true,
      timeoutMs: 200,
      pacing: { minIntervalMs: 300, dailyCap: 3 },
      async search(query: string) {
        calls += 1;
        return [
          {
            id: query,
            source: 't_pacing_order',
            title: query,
            authors: [],
            hasFullText: false,
          },
        ];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    const adapter = getAdapter('t_pacing_order');

    // Three concurrent searches. Serialized by the 300ms pacing interval they
    // span ~600ms in total, well past each call's own 200ms timeout.
    const results = await Promise.all(['a', 'b', 'c'].map((q) => adapter.search(q, 1)));

    assert.equal(results.length, 3);
    for (const [i, r] of results.entries()) {
      assert.equal(r.length, 1, `search ${i} returned no results`);
    }
    assert.deepEqual(
      results.map((r) => r[0].id),
      ['a', 'b', 'c'],
    );
    assert.equal(calls, 3, 'the adapter should have been reached three times');

    // The cap is 3, so a fourth call proves the first three reserved exactly
    // three units between them: it is the fourth reservation that trips.
    await assert.rejects(
      () => adapter.search('d', 1),
      /Daily quota for t_pacing_order reached \(4\/3\)/,
    );
  });
});
