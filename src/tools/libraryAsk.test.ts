import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import '../sources/all.ts';
import { candidatesWithMargin, resetCatalogCacheForTests } from '../utils/catalogIndex.ts';
import { resetRoutingCacheForTests } from '../utils/resultCache.ts';
import { detectFreshnessPreference, libraryAsk, planRoute, runAsk } from './libraryAsk.ts';

const arxivFixture = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/arxiv-search.xml'),
  'utf8',
);

interface RouterServer {
  url: string;
  systemPrompts: string[];
  close(): Promise<void>;
}

type RouterHandler = (systemPrompt: string) => unknown;

// A fake OpenAI-compatible /v1/chat/completions endpoint standing in for
// the `router` role, returning a canned routing decision and recording the
// system prompt it was sent (so a test can inspect the candidate shortlist
// stage 2 was actually given).
function startFakeRouter(decide: RouterHandler): Promise<RouterServer> {
  const systemPrompts: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const system = body.messages[0].content as string;
        systemPrompts.push(system);
        const decision = decide(system);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 0,
            model: 'test-router',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(decision) },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        systemPrompts,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test('detectFreshnessPreference', async (t) => {
  await t.test('a strong recency term prefers realtime', () => {
    assert.equal(detectFreshnessPreference('latest news on the strike'), 'realtime');
    assert.equal(detectFreshnessPreference('breaking developments today'), 'realtime');
    assert.equal(detectFreshnessPreference('what happened this week'), 'realtime');
  });

  await t.test('a mention of the current or previous year prefers daily', () => {
    const currentYear = new Date().getFullYear();
    assert.equal(detectFreshnessPreference(`inflation in ${currentYear}`), 'daily');
    assert.equal(detectFreshnessPreference(`inflation in ${currentYear - 1}`), 'daily');
  });

  await t.test('an old year or no recency signal returns undefined', () => {
    assert.equal(detectFreshnessPreference('inflation in 1990'), undefined);
    assert.equal(detectFreshnessPreference('Pride and Prejudice full text'), undefined);
  });
});

test('runAsk / libraryAsk', async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    resetCatalogCacheForTests();
    resetRoutingCacheForTests();
  });

  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;
  // These tests exercise the stage-2 router path specifically (hallucinated
  // routes, cluster/freshness tagging), so disable the Task 6 margin-skip -
  // margin never exceeds 1 for the BM25 ranking this file runs under (no
  // embeddings key), so any threshold above 1 guarantees stage 2 always
  // runs. Dedicated skip-path tests are in catalogIndex.test.ts / this
  // file's own margin-skip block below.
  process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN = '2';
  resetCatalogCacheForTests();
  resetRoutingCacheForTests();

  await t.test(
    'drops a route naming a source outside the shortlist, tags results with cluster',
    async () => {
      const router = await startFakeRouter(() => ({
        intent: 'find papers about attention mechanisms',
        routes: [
          { source: 'arxiv', query: 'attention is all you need', reason: 'academic preprint' },
          { source: 'not-a-real-source', query: 'x', reason: 'hallucinated' },
        ],
      }));
      t.after(() => router.close());

      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://export.arxiv.org/api/query')) {
          return new Response(arxivFixture, {
            status: 200,
            headers: { 'Content-Type': 'application/atom+xml' },
          });
        }
        return originalFetch(input as string, init);
      }) as typeof fetch;

      const result = await runAsk('arxiv preprints on transformer attention', { maxSources: 5 });
      assert.equal(result.intent, 'find papers about attention mechanisms');
      assert.deepEqual(
        result.routing.map((r) => r.source),
        ['arxiv'],
        'the hallucinated source is dropped',
      );
      assert.ok(result.perSource.arxiv.length > 0);
      assert.equal(result.perSource.arxiv[0].cluster, 'academic');
      assert.equal(result.errors.length, 0);

      const ask = await libraryAsk('arxiv preprints on transformer attention', 5, 5);
      assert.equal(ask.sources_searched.length, 1);
      assert.equal(ask.sources_searched[0], 'arxiv');
      assert.ok(ask.total_results > 0);
      assert.equal(ask.results.length, ask.total_results);

      delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
      delete process.env.ALEXANDRIA_ROUTER_API_KEY;
    },
  );

  await t.test('caps the routes kept at maxSources even if the model returns more', async () => {
    const router = await startFakeRouter(() => ({
      intent: 'find astronomy papers',
      routes: [
        { source: 'arxiv', query: 'astronomy', reason: 'r1' },
        { source: 'nasa', query: 'astronomy', reason: 'r2' },
        { source: 'nasaads', query: 'astronomy', reason: 'r3' },
      ],
    }));
    t.after(() => router.close());

    process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://export.arxiv.org/api/query')) {
        return new Response('<feed></feed>', {
          status: 200,
          headers: { 'Content-Type': 'application/atom+xml' },
        });
      }
      return originalFetch(input as string, init);
    }) as typeof fetch;

    const result = await runAsk('astronomy papers', { maxSources: 1 });
    assert.equal(result.routing.length, 1);
    assert.equal(result.routing[0].source, 'arxiv');

    delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
    delete process.env.ALEXANDRIA_ROUTER_API_KEY;
  });

  await t.test('stage 2 candidates are tagged with cluster and freshness', async () => {
    let capturedSystem = '';
    const router = await startFakeRouter((system) => {
      capturedSystem = system;
      return { intent: 'x', routes: [] };
    });
    t.after(() => router.close());

    process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

    await runAsk('public domain books');
    assert.match(capturedSystem, /\[freshness: (realtime|daily|static)\]/);
    assert.match(capturedSystem, /\(cluster [a-z_]+\)/);

    delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
    delete process.env.ALEXANDRIA_ROUTER_API_KEY;
  });
});

// Task 6: the router-skip margin and the routing decision cache, both
// against planRoute() directly (stage 1 + stage 2 only, no fan-out) so a
// call count on the fake router server is a direct proxy for "how many LLM
// calls did this make", the same thing scripts/eval-routing.ts and
// src/utils/metrics.ts's llmCalls counter measure in production.
test('router skip margin and routing cache', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
    resetCatalogCacheForTests();
    resetRoutingCacheForTests();
  });

  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;

  await t.test(
    "skips the router at or above the query's own margin, calls it just below",
    async () => {
      resetCatalogCacheForTests();
      resetRoutingCacheForTests();

      // A query with a real, nonzero margin under BM25 (see
      // catalogIndex.test.ts's "left-pad" regression test: depsdev
      // dominates this one), so the boundary this test sets is meaningful
      // rather than an arbitrary constant that could stop meaning anything
      // if the catalog changes.
      const query = 'npm package left-pad maintainers';
      const { margin } = await candidatesWithMargin(query, 20, 3);
      assert.ok(margin > 0, 'the test needs a real margin to bracket a threshold around');

      const router = await startFakeRouter(() => ({
        intent: 'router picked this',
        routes: [{ source: 'depsdev', query: 'left-pad', reason: 'r' }],
      }));
      t.after(() => router.close());
      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

      // The threshold is set just above the query's own margin, so the
      // margin is below it: not confident enough yet.
      process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN = String(margin + 0.001);
      resetRoutingCacheForTests();
      const below = await planRoute(query, { maxSources: 3 });
      assert.equal(below.stage2, 'llm');
      assert.equal(below.intent, 'router picked this');
      assert.equal(router.systemPrompts.length, 1, 'the router was called');

      // Exactly at the query's own margin: confident enough (>=).
      process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN = String(margin);
      resetRoutingCacheForTests();
      const atThreshold = await planRoute(query, { maxSources: 3 });
      assert.equal(atThreshold.stage2, 'skipped');
      assert.equal(atThreshold.intent, query, 'the raw query stands in for an LLM-written intent');
      assert.ok(
        atThreshold.routes.every((r) => r.query === query),
        'a skipped route fans out with the raw query, not an optimized per-source one',
      );
      assert.equal(
        router.systemPrompts.length,
        1,
        'the router was not called a second time once skipped',
      );

      delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
      delete process.env.ALEXANDRIA_ROUTER_API_KEY;
      delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;
    },
  );

  await t.test(
    'a routing cache hit replays the decision and never calls the router again',
    async () => {
      resetCatalogCacheForTests();
      resetRoutingCacheForTests();

      const router = await startFakeRouter(() => ({
        intent: 'router picked this once',
        routes: [{ source: 'arxiv', query: 'attention', reason: 'r' }],
      }));
      t.after(() => router.close());
      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
      // Margin can never reach 2 under BM25 (no negative scores), so this
      // isolates the cache's own effect from the margin-skip path above.
      process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN = '2';

      const first = await planRoute('a repeated cache-test query', { maxSources: 2 });
      assert.equal(first.stage2, 'llm');
      assert.equal(router.systemPrompts.length, 1);

      const second = await planRoute('a repeated cache-test query', { maxSources: 2 });
      assert.equal(
        router.systemPrompts.length,
        1,
        'a cache hit costs no LLM call: the router was not called a second time',
      );
      assert.equal(second.stage2, 'llm', 'the cached decision replays which path produced it');
      assert.equal(second.intent, first.intent);
      assert.deepEqual(second.routes, first.routes);

      // Whitespace/case normalisation matches resultCache.ts's cacheKey.
      const third = await planRoute('  A REPEATED   cache-test QUERY  ', { maxSources: 2 });
      assert.equal(router.systemPrompts.length, 1, 'normalised query text still hits the cache');
      assert.equal(third.intent, first.intent);

      // A different max_sources is a different cache key.
      await planRoute('a repeated cache-test query', { maxSources: 3 });
      assert.equal(
        router.systemPrompts.length,
        2,
        'a different max_sources is a cache miss, so the router runs again',
      );

      delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
      delete process.env.ALEXANDRIA_ROUTER_API_KEY;
      delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;
    },
  );

  await t.test('a routing cache hit replays a margin-skip decision too', async () => {
    resetCatalogCacheForTests();
    resetRoutingCacheForTests();

    const router = await startFakeRouter(() => ({
      intent: 'should never be called',
      routes: [{ source: 'depsdev', query: 'x', reason: 'r' }],
    }));
    t.after(() => router.close());
    process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
    // Always skip: the top score is always > 0 for a query that matches
    // anything at all, and margin >= 0 is always true.
    process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN = '0';

    const first = await planRoute('npm package left-pad maintainers', { maxSources: 3 });
    assert.equal(first.stage2, 'skipped');
    assert.equal(router.systemPrompts.length, 0, 'stage 2 never ran the first time either');

    const second = await planRoute('npm package left-pad maintainers', { maxSources: 3 });
    assert.equal(second.stage2, 'skipped', 'the cache replays "skipped", not a fresh margin check');
    assert.deepEqual(second.routes, first.routes);
    assert.equal(router.systemPrompts.length, 0);

    delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
    delete process.env.ALEXANDRIA_ROUTER_API_KEY;
    delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;
  });
});
