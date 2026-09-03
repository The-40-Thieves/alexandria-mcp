import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../sources/all.ts';
import { destinationOverride } from '../log.ts';
import { candidatesWithMargin, resetCatalogCacheForTests } from '../utils/catalogIndex.ts';
import { resetRoutingCacheForTests } from '../utils/resultCache.ts';
import {
  detectFreshnessPreference,
  libraryAsk,
  parseSkipMargin,
  planRoute,
  resetSkipMarginWarningForTests,
  runAsk,
} from './libraryAsk.ts';

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

interface FakeEmbeddingServer {
  url: string;
  close(): Promise<void>;
}

function toBase64Float32(nums: number[]): string {
  const buf = Buffer.alloc(nums.length * 4);
  nums.forEach((n, i) => {
    buf.writeFloatLE(n, i * 4);
  });
  return buf.toString('base64');
}

// A fake OpenAI-compatible /v1/embeddings endpoint whose vectors are
// controlled entirely by `isDominant`, not content-derived like
// catalogIndex.test.ts's hash-based fake server: every input text
// `isDominant` accepts embeds to [1, 0, 0] (parallel, cosine similarity 1
// with each other), everything else to [0, 1, 0] (orthogonal to the
// first, cosine similarity 0). Pairing a query that satisfies `isDominant`
// with a catalog entry-text predicate that only one real source's text
// satisfies (its own module comment format is "name: description
// (cluster X)", so `startsWith('${name}:')` isolates one) produces a
// margin of exactly 1 deterministically, instead of hoping a real
// embedding model's semantics happen to land above whatever threshold a
// test wants to exercise.
function startFakeEmbeddingServer(
  isDominant: (text: string) => boolean,
): Promise<FakeEmbeddingServer> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        const input = (body.input as string[]) ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: input.map((text: string, i: number) => ({
              embedding: toBase64Float32(isDominant(text) ? [1, 0, 0] : [0, 1, 0]),
              index: i,
            })),
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
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

  await t.test('onRouted fires with the final routing before the fan-out searches', async () => {
    const router = await startFakeRouter(() => ({
      intent: 'find astronomy papers',
      routes: [{ source: 'arxiv', query: 'astronomy', reason: 'r1' }],
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

    let routedCalledBeforeReturn = false;
    let capturedSources: string[] = [];
    const result = await runAsk('astronomy papers', { maxSources: 1 }, (routing) => {
      routedCalledBeforeReturn = true;
      capturedSources = routing.map((r) => r.source);
    });

    assert.ok(routedCalledBeforeReturn, 'onRouted was called at all');
    assert.deepEqual(capturedSources, ['arxiv']);
    assert.deepEqual(
      result.routing.map((r) => r.source),
      capturedSources,
    );

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

// Task 6 fix round 1 (IMPORTANT 1): Number('') is 0, finite and >= 0, so
// an env-file loader's "present but unset" shape (KEY=, an empty string,
// not undefined) used to make skipMargin 0 and skip on every query.
// config.ts's own preprocess now normalizes an empty ALEXANDRIA_ROUTER_
// SKIP_MARGIN to undefined before parseSkipMargin ever sees it, but this
// tests parseSkipMargin directly regardless, since a future caller might
// not go through config.ts.
test('parseSkipMargin', async (t) => {
  t.afterEach(() => {
    destinationOverride.value = undefined;
    resetSkipMarginWarningForTests();
  });

  await t.test('an empty string is treated as unset: the default, no warning', () => {
    const warnings: string[] = [];
    destinationOverride.value = { write: (msg: string) => void warnings.push(msg) };
    assert.equal(parseSkipMargin('', 0.4), 0.4);
    assert.equal(warnings.length, 0);
  });

  await t.test('a whitespace-only string is also treated as unset', () => {
    const warnings: string[] = [];
    destinationOverride.value = { write: (msg: string) => void warnings.push(msg) };
    assert.equal(parseSkipMargin('   ', 0.4), 0.4);
    assert.equal(warnings.length, 0);
  });

  await t.test('undefined is treated as unset', () => {
    assert.equal(parseSkipMargin(undefined, 0.4), 0.4);
  });

  await t.test('an explicit "0" is a valid opt-in to always-skip, not "unset"', () => {
    assert.equal(parseSkipMargin('0', 0.4), 0);
  });

  await t.test('a normal in-range value parses through', () => {
    assert.equal(parseSkipMargin('0.4', 0.9), 0.4);
  });

  await t.test('a non-numeric value falls back to the default and warns once', () => {
    const warnings: string[] = [];
    destinationOverride.value = { write: (msg: string) => void warnings.push(msg) };
    assert.equal(parseSkipMargin('abc', 0.4), 0.4);
    assert.equal(parseSkipMargin('abc', 0.4), 0.4);
    assert.equal(warnings.length, 1, 'the warning fires once, not per call');
  });

  await t.test('a negative value falls back to the default and warns once', () => {
    const warnings: string[] = [];
    destinationOverride.value = { write: (msg: string) => void warnings.push(msg) };
    assert.equal(parseSkipMargin('-1', 0.4), 0.4);
    assert.equal(warnings.length, 1);
  });

  await t.test('no upper bound: a value above 1 parses through unchanged', () => {
    assert.equal(parseSkipMargin('2', 0.4), 2);
  });
});

// Task 6 fix round 1 (IMPORTANT 2, controller ruling): the BM25-only eval
// rows regressed 0.024 nDCG@5 under the router skip at every margin tested
// (0.2/0.3/0.4), outside the brief's 0.01 band, and skipped 60/62 queries
// at all three (BM25's normalised margin is near-saturated) - see
// docs/routing-eval.md. So the default skip margin only applies when
// stage 1 ran in embeddings mode; BM25 mode needs an operator-set
// ALEXANDRIA_ROUTER_SKIP_MARGIN to opt in, in which case it applies the
// same as it would in embeddings mode.
test('the default router-skip margin only applies in embeddings mode', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
    resetCatalogCacheForTests();
    resetRoutingCacheForTests();
  });

  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;

  await t.test(
    'BM25 mode, no explicit margin: the router is always called, even on a high-margin query',
    async () => {
      resetCatalogCacheForTests();
      resetRoutingCacheForTests();

      const query = 'npm package left-pad maintainers';
      const { margin, stage1 } = await candidatesWithMargin(query, 20, 3);
      assert.equal(stage1, 'bm25');
      assert.ok(
        margin > 0.4,
        `this query needs a margin above the default 0.4 for the test to mean anything (got ${margin})`,
      );

      const router = await startFakeRouter(() => ({
        intent: 'router picked this',
        routes: [{ source: 'depsdev', query: 'left-pad', reason: 'r' }],
      }));
      t.after(() => router.close());
      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
      delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;

      const planned = await planRoute(query, { maxSources: 3 });
      assert.equal(planned.stage1, 'bm25');
      assert.equal(planned.stage2, 'llm', 'BM25 mode never skips on the default margin alone');
      assert.equal(router.systemPrompts.length, 1);

      delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
      delete process.env.ALEXANDRIA_ROUTER_API_KEY;
    },
  );

  await t.test(
    'BM25 mode, an explicit margin: the skip is honoured, same as embeddings mode',
    async () => {
      resetCatalogCacheForTests();
      resetRoutingCacheForTests();

      const query = 'npm package left-pad maintainers';
      const router = await startFakeRouter(() => ({
        intent: 'should never be called',
        routes: [{ source: 'depsdev', query: 'x', reason: 'r' }],
      }));
      t.after(() => router.close());
      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
      process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN = '0.4'; // explicit opt-in

      const planned = await planRoute(query, { maxSources: 3 });
      assert.equal(planned.stage1, 'bm25');
      assert.equal(planned.stage2, 'skipped', 'an explicit margin opts in even in BM25 mode');
      assert.equal(router.systemPrompts.length, 0);

      delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
      delete process.env.ALEXANDRIA_ROUTER_API_KEY;
      delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;
    },
  );

  await t.test(
    'embeddings mode, no explicit margin: the skip is honoured above the default',
    async () => {
      // A fake embedding server that puts the query and exactly one
      // catalog entry ("arxiv: ...") on the same vector and everything
      // else orthogonal, so the margin is deterministically 1 - well
      // above the default 0.4 - regardless of real embedding semantics.
      const embedServer = await startFakeEmbeddingServer(
        (text) => text === 'DOMINANT_QUERY_MARKER' || text.startsWith('arxiv:'),
      );
      t.after(() => embedServer.close());

      const cacheDir = mkdtempSync(path.join(tmpdir(), 'alexandria-libraryask-embed-cache-'));
      t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

      process.env.ALEXANDRIA_EMBEDDINGS_BASE_URL = embedServer.url;
      process.env.ALEXANDRIA_EMBEDDINGS_API_KEY = 'test-key';
      process.env.ALEXANDRIA_CATALOG_CACHE = path.join(cacheDir, 'catalog-embeddings.json');
      resetCatalogCacheForTests();
      resetRoutingCacheForTests();

      const router = await startFakeRouter(() => ({
        intent: 'should never be called',
        routes: [{ source: 'arxiv', query: 'x', reason: 'r' }],
      }));
      t.after(() => router.close());
      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
      delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;

      const planned = await planRoute('DOMINANT_QUERY_MARKER', { maxSources: 3 });
      assert.equal(planned.stage1, 'embeddings');
      assert.equal(planned.stage2, 'skipped', 'the default margin applies in embeddings mode');
      assert.equal(router.systemPrompts.length, 0);
      assert.ok(planned.routes.some((r) => r.source === 'arxiv'));

      delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
      delete process.env.ALEXANDRIA_ROUTER_API_KEY;
      delete process.env.ALEXANDRIA_EMBEDDINGS_BASE_URL;
      delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
      delete process.env.ALEXANDRIA_CATALOG_CACHE;
    },
  );
});

// Final wave, A2: routingCacheKey now folds in stage1ModeHint() (plus the
// effective skip margin and router model), so a decision the routing
// cache stored while running BM25-only must not be replayed once the
// process is configured with embeddings - the two modes can legitimately
// pick different sources for the identical query text.
test('a routing decision cached under one stage-1 mode is a cache miss under another', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
    resetCatalogCacheForTests();
    resetRoutingCacheForTests();
  });

  const query = 'npm package left-pad maintainers';

  // First call: BM25 mode (no embeddings configured), routed to depsdev
  // and cached under stage1ModeHint()==='bm25'.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.ALEXANDRIA_ROUTER_SKIP_MARGIN;
  resetCatalogCacheForTests();
  resetRoutingCacheForTests();

  const bm25Router = await startFakeRouter(() => ({
    intent: 'bm25 decision',
    routes: [{ source: 'depsdev', query: 'left-pad', reason: 'r' }],
  }));
  t.after(() => bm25Router.close());
  process.env.ALEXANDRIA_ROUTER_BASE_URL = bm25Router.url;
  process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

  const bm25Planned = await planRoute(query, { maxSources: 3 });
  assert.equal(bm25Planned.stage1, 'bm25');
  assert.equal(bm25Router.systemPrompts.length, 1, 'first call is a genuine cache miss');

  delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
  delete process.env.ALEXANDRIA_ROUTER_API_KEY;

  // Second call, same query, same maxSources, routing cache untouched:
  // switch to embeddings mode. If the cache keyed only on query+maxSources
  // (pre-A2 behavior), this would replay the BM25 decision verbatim - no
  // router call, and a stage1 that lies about how the result was produced.
  // Every text (query and every catalog entry alike) gets the identical
  // vector, so every candidate ties on cosine similarity: the stage-1
  // margin is 0, below the skip threshold, so this exercises the real
  // stage-2 router call rather than a margin-skip.
  const embedServer = await startFakeEmbeddingServer(() => false);
  t.after(() => embedServer.close());

  const cacheDir = mkdtempSync(path.join(tmpdir(), 'alexandria-libraryask-mode-flip-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  process.env.ALEXANDRIA_EMBEDDINGS_BASE_URL = embedServer.url;
  process.env.ALEXANDRIA_EMBEDDINGS_API_KEY = 'test-key';
  process.env.ALEXANDRIA_CATALOG_CACHE = path.join(cacheDir, 'catalog-embeddings.json');
  resetCatalogCacheForTests();

  const embedRouter = await startFakeRouter(() => ({
    intent: 'embeddings decision',
    routes: [{ source: 'arxiv', query: 'left-pad', reason: 'r' }],
  }));
  t.after(() => embedRouter.close());
  process.env.ALEXANDRIA_ROUTER_BASE_URL = embedRouter.url;
  process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

  const embeddingsPlanned = await planRoute(query, { maxSources: 3 });
  assert.equal(
    embeddingsPlanned.stage1,
    'embeddings',
    'the BM25-cached entry must not be replayed once running in embeddings mode',
  );
  assert.equal(
    embedRouter.systemPrompts.length,
    1,
    'a real stage-1/stage-2 pass ran again instead of replaying the other mode cached decision',
  );

  delete process.env.ALEXANDRIA_ROUTER_BASE_URL;
  delete process.env.ALEXANDRIA_ROUTER_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_BASE_URL;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.ALEXANDRIA_CATALOG_CACHE;
});
