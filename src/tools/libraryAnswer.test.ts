import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { register } from '../sources/registry.js';
import { resetCatalogCacheForTests } from '../utils/catalogIndex.js';
import { dropDanglingCitations, extractCitationNumbers, libraryAnswer } from './libraryAnswer.js';

interface FakeServer {
  url: string;
  requests: Array<{ messages: Array<{ role: string; content: string }> }>;
  close(): Promise<void>;
}

type ChatHandler = (body: { messages: Array<{ role: string; content: string }> }) => unknown;

// A fake OpenAI-compatible /v1/chat/completions endpoint. One instance
// stands in for the router role, another for the synth role, matching the
// pattern src/tools/libraryAsk.test.ts and src/utils/providers.test.ts use.
function startFakeChatServer(decide: ChatHandler): Promise<FakeServer> {
  const requests: FakeServer['requests'] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const content = decide(body);
        const contentText = typeof content === 'string' ? content : JSON.stringify(content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 0,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: contentText },
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
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

// A very unusual token so BM25's stage-1 catalog narrowing reliably puts
// these two fake sources in the top-20 shortlist regardless of what else is
// registered, without needing an embeddings key.
const TOKEN = 'zzftestcorpus';

function registerFakeSources(): void {
  register('zzftest_full', {
    description: `Test source about ${TOKEN} changes`,
    supportsIngest: true,
    async search() {
      return [
        {
          id: 'a1',
          source: 'zzftest_full',
          title: 'Full Text Item',
          authors: [],
          hasFullText: true,
        },
      ];
    },
    async read() {
      return {
        title: 'Full Text Item',
        authors: [],
        text: `The ${TOKEN} API added rate limiting in November 2025. This document has real content.`,
      };
    },
  });

  register('zzftest_meta', {
    description: `Test metadata-only source about ${TOKEN} changes`,
    supportsIngest: false,
    async search() {
      return [
        {
          id: 'b1',
          source: 'zzftest_meta',
          title: 'Metadata Only Item',
          authors: [],
          hasFullText: false,
          externalUrl: 'https://example.test/b1',
        },
      ];
    },
    async read() {
      return {
        title: 'Metadata Only Item',
        authors: [],
        metadataOnly: true,
        externalUrl: 'https://example.test/b1',
      };
    },
  });
}

test('extractCitationNumbers / dropDanglingCitations', async (t) => {
  await t.test('a 4+ digit bracketed number (e.g. a year) is not a citation marker', () => {
    assert.deepEqual(extractCitationNumbers('The year was [2024].'), []);
    assert.equal(
      dropDanglingCitations('The year was [2024].', 1),
      'The year was [2024].',
      'a sentence with only prose in brackets is never dropped',
    );
  });

  await t.test(
    'a marker beyond sourceCount (but <= 99) is dangling and the sentence is dropped',
    () => {
      assert.deepEqual(extractCitationNumbers('This has [3].'), [3]);
      assert.equal(dropDanglingCitations('This has [3].', 2), '');
    },
  );

  await t.test('a comma-separated marker list validates against sourceCount', () => {
    assert.deepEqual(extractCitationNumbers('Cites two sources [1, 2].'), [1, 2]);
    assert.equal(
      dropDanglingCitations('Cites two sources [1, 2].', 2),
      'Cites two sources [1, 2].',
    );
  });

  await t.test('two adjacent single markers both validate', () => {
    assert.deepEqual(extractCitationNumbers('Cites two sources [1][2].'), [1, 2]);
    assert.equal(
      dropDanglingCitations('Cites two sources [1][2].', 2),
      'Cites two sources [1][2].',
    );
  });
});

test('libraryAnswer', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
    resetCatalogCacheForTests();
  });

  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;
  delete process.env.ALEXANDRIA_EMBEDDINGS_API_KEY;
  delete process.env.KNOWLEDGE_MCP_URL;

  await t.test(
    'rejects cleanly with no synth key configured, before doing any other work',
    async () => {
      delete process.env.ALEXANDRIA_SYNTH_API_KEY;
      delete process.env.ALEXANDRIA_ROUTER_API_KEY;

      await assert.rejects(
        () => libraryAnswer(`${TOKEN} question`),
        /library_answer requires a synth model: set OPENAI_API_KEY or ALEXANDRIA_SYNTH_API_KEY$/,
      );
    },
  );

  await t.test(
    'reads the top full-text result, skips metadata-only, cites and drops dangling markers',
    async () => {
      registerFakeSources();
      resetCatalogCacheForTests();

      const router = await startFakeChatServer(() => ({
        intent: `find info about ${TOKEN}`,
        routes: [
          { source: 'zzftest_full', query: TOKEN, reason: 'full text match' },
          { source: 'zzftest_meta', query: TOKEN, reason: 'metadata match' },
        ],
      }));
      t.after(() => router.close());

      const synth = await startFakeChatServer(
        () =>
          `The ${TOKEN} API added rate limiting in November 2025 [1]. This sentence has a bad citation and must be dropped [2].`,
      );
      t.after(() => synth.close());

      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
      process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
      process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

      const result = await libraryAnswer(`what changed in ${TOKEN}`, {
        maxSources: 5,
        resultsPerSource: 5,
        readTop: 4,
      });

      assert.equal(result.citations.length, 1, 'only the full-text source is read and cited');
      assert.deepEqual(result.citations[0], {
        n: 1,
        source: 'zzftest_full',
        id: 'a1',
        title: 'Full Text Item',
        url: undefined,
      });

      assert.match(result.answer, /rate limiting in November 2025 \[1\]/);
      assert.doesNotMatch(result.answer, /bad citation/, 'the dangling [2] sentence was dropped');
      assert.deepEqual(result.warnings, [], 'at least one sentence survived with a valid citation');

      const sources = result.results.map((r) => r.source);
      assert.ok(sources.includes('zzftest_full'));
      assert.ok(sources.includes('zzftest_meta'), 'metadata-only source still appears in results');

      assert.deepEqual(result.routing.map((r) => r.source).sort(), [
        'zzftest_full',
        'zzftest_meta',
      ]);
    },
  );

  await t.test('warns and keeps the raw answer when the model cites nothing at all', async () => {
    registerFakeSources();
    resetCatalogCacheForTests();

    const router = await startFakeChatServer(() => ({
      intent: `find info about ${TOKEN}`,
      routes: [{ source: 'zzftest_full', query: TOKEN, reason: 'full text match' }],
    }));
    t.after(() => router.close());

    const uncitedAnswer = `The ${TOKEN} API changed in November 2025, but no source is cited here.`;
    const synth = await startFakeChatServer(() => uncitedAnswer);
    t.after(() => synth.close());

    process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
    process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
    process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

    const result = await libraryAnswer(`what changed in ${TOKEN}`, { readTop: 4 });

    assert.equal(result.answer, uncitedAnswer, 'the raw answer is kept, nothing to drop');
    assert.deepEqual(result.citations, [], 'no markers means no referenced citations');
    assert.deepEqual(result.warnings, ['answer contains no citation markers']);
  });

  await t.test(
    'warns and falls back to a source listing when every sentence is dropped as uncited',
    async () => {
      registerFakeSources();
      resetCatalogCacheForTests();

      const router = await startFakeChatServer(() => ({
        intent: `find info about ${TOKEN}`,
        routes: [{ source: 'zzftest_full', query: TOKEN, reason: 'full text match' }],
      }));
      t.after(() => router.close());

      // Only one source is read (sourceCount === 1), so [5] is dangling and
      // this single sentence is the entire answer: dropping it empties the
      // whole thing.
      const synth = await startFakeChatServer(
        () => 'This claim cites a source that does not exist [5].',
      );
      t.after(() => synth.close());

      process.env.ALEXANDRIA_ROUTER_BASE_URL = router.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
      process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
      process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

      const result = await libraryAnswer(`what changed in ${TOKEN}`, { readTop: 4 });

      assert.match(result.answer, /^Sources: \[1\] Full Text Item$/);
      assert.deepEqual(result.citations, [], 'nothing surviving references any source');
      assert.deepEqual(result.warnings, [
        'all sentences were dropped as uncited; returning the sources without a synthesized answer',
      ]);
    },
  );
});
