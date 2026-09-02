import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import '../sources/all.ts';
import { resetCatalogCacheForTests } from '../utils/catalogIndex.ts';
import { detectFreshnessPreference, libraryAsk, runAsk } from './libraryAsk.ts';

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
  });

  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;
  resetCatalogCacheForTests();

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
