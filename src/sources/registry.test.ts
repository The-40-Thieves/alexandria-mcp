import { strict as assert } from 'node:assert';
import test, { describe, it } from 'node:test';
import { fetchJSON } from '../utils/http.ts';
import { sourceMetrics } from '../utils/metrics.ts';
import { stateStore } from '../utils/stateStore.ts';
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

  await t.test(
    'getAdapter caches an identical read (static freshness) without re-calling the adapter',
    async () => {
      let calls = 0;
      register('t_read_cached_static', {
        description: 'x',
        supportsIngest: true,
        freshness: 'static',
        async search() {
          return [];
        },
        async read() {
          calls++;
          return { title: 'cached', authors: [] };
        },
      });
      const adapter = getAdapter('t_read_cached_static');
      const before = sourceMetrics('t_read_cached_static').cacheHits;
      const first = await adapter.read('id-1');
      const second = await adapter.read('id-1');
      assert.deepEqual(second, first);
      assert.equal(calls, 1);
      assert.equal(sourceMetrics('t_read_cached_static').cacheHits, before + 1);
    },
  );

  await t.test('a realtime source never caches reads', async () => {
    let calls = 0;
    register('t_read_realtime', {
      description: 'x',
      supportsIngest: true,
      freshness: 'realtime',
      async search() {
        return [];
      },
      async read() {
        calls++;
        return { title: 'live', authors: [] };
      },
    });
    const adapter = getAdapter('t_read_realtime');
    await adapter.read('id-1');
    await adapter.read('id-1');
    assert.equal(calls, 2);
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

  it('a search call is reflected in quota.reserved and cache.entries (Task 4)', async () => {
    register('t_health_quota', {
      description: 'x',
      supportsIngest: false,
      async search() {
        return [];
      },
      async read() {
        return { title: '', authors: [] };
      },
    });
    const before = healthSummary();
    await getAdapter('t_health_quota').search('q', 1);
    const after = healthSummary();
    assert.equal(after.quota.reserved, before.quota.reserved + 1);
    assert.equal(after.quota.sources, before.quota.sources + 1);
    assert.equal(after.cache.entries, before.cache.entries + 1);
    assert.equal(after.quota.day, before.quota.day);
  });

  // Final wave, B3: cacheSize() is a raw row count that can include rows
  // already past their expiresAt but not yet lazily evicted - nothing had
  // read that particular key since it expired, so nothing triggered its
  // removal. healthSummary() now evicts first, so an already-expired row
  // must not inflate cache.entries.
  it('does not count an already-expired cache row (evicts before counting)', () => {
    const before = healthSummary();
    stateStore.setCache('t_health_expired_probe', 'x', Date.now() - 1000);
    const after = healthSummary();
    assert.equal(
      after.cache.entries,
      before.cache.entries,
      'an expired row is evicted, not counted',
    );
  });

  // Final wave, B4: under ALEXANDRIA_LEDGER=supabase, quota.reserved/
  // quota.sources read as zero (reservations go to Supabase, not this
  // StateStore) - easy to misread as "no quota used today" rather than
  // "wrong backend for this view". quota.backend names which one these
  // numbers actually came from, the same condition createLedger() itself
  // gates on (ALEXANDRIA_LEDGER=supabase AND both Supabase env vars set).
  it('quota.backend is "state" by default', () => {
    assert.equal(healthSummary().quota.backend, 'state');
  });

  it('quota.backend is "supabase" only when the ledger would actually route there', () => {
    const original = {
      ALEXANDRIA_LEDGER: process.env.ALEXANDRIA_LEDGER,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    try {
      process.env.ALEXANDRIA_LEDGER = 'supabase';
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      assert.equal(
        healthSummary().quota.backend,
        'state',
        'ALEXANDRIA_LEDGER=supabase alone, with no Supabase credentials, still reads as state',
      );

      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
      assert.equal(healthSummary().quota.backend, 'supabase');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

// Regression: registry.ts's ledger used to be built eagerly at module
// load (`const ledger = createLedger()`), and createLedger() reads
// config.ALEXANDRIA_LEDGER/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY - a
// single config field access runs the FULL schema.safeParse(process.env)
// (config.ts's module comment), so an unrelated malformed ambient var
// (a bad TRANSPORT, here) threw merely by IMPORTING registry.ts, before a
// caller ever asked for anything ledger-related. registry.ts is imported
// by nearly everything (gen-docs, probe, eval-routing, every registry
// test), so that was the least diagnosable place for it to fail. A fresh
// module instance (cache-busting query string, the only way to re-run
// this module's top-level code within one process) proves the actual
// `getLedger()` lazy path, not a stand-in.
describe('config laziness', () => {
  it('importing registry.ts under a malformed unrelated env var succeeds; the failure surfaces only on first ledger use', async () => {
    const originalTransport = process.env.TRANSPORT;
    process.env.TRANSPORT = 'not-a-real-transport'; // invalid per config.ts's TRANSPORT enum
    try {
      const mod = (await import(`./registry.ts?lazy-config-test=${Date.now()}`)) as {
        register: typeof register;
        getAdapter: typeof getAdapter;
      };

      // The import itself must not throw.
      mod.register('t_lazy_config', {
        description: 'x',
        supportsIngest: false,
        async search() {
          return [];
        },
        async read() {
          return { title: '', authors: [] };
        },
      });

      // The first guarded call reaches getLedger() -> createLedger() ->
      // config.ALEXANDRIA_LEDGER, which is where the deferred failure
      // must actually surface, naming the bad variable.
      await assert.rejects(mod.getAdapter('t_lazy_config').search('q', 1), /TRANSPORT/);
    } finally {
      if (originalTransport === undefined) delete process.env.TRANSPORT;
      else process.env.TRANSPORT = originalTransport;
    }
  });
});
