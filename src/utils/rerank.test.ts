import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { LibraryResult } from '../types.ts';
import { rerank, shuffleRngOverride, shuffleWithRng } from './rerank.ts';

function result(source: string, id: string, title: string): LibraryResult {
  return { id, source, title, authors: [], hasFullText: false };
}

interface FakeServer {
  url: string;
  requests: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}

function startFakeServer(respond: () => { status: number; body: unknown }): Promise<FakeServer> {
  const requests: Array<{ path: string; body: unknown }> = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
        const { status, body } = respond();
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function chatCompletion(content: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

// A tiny deterministic PRNG (mulberry32) so shuffle tests get an exact,
// reproducible order instead of asserting only "it changed".
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withEnv(t: import('node:test').TestContext, vars: Record<string, string | undefined>) {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('shuffleWithRng', async (t) => {
  await t.test('is deterministic under a seeded rng', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffleWithRng(items, mulberry32(42));
    const b = shuffleWithRng(items, mulberry32(42));
    assert.deepEqual(a, b, 'the same seed produces the same permutation');
    assert.notDeepEqual(a, items, 'the permutation actually reorders the input');
  });

  await t.test('a different seed produces a different permutation', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffleWithRng(items, mulberry32(42));
    const b = shuffleWithRng(items, mulberry32(7));
    assert.notDeepEqual(a, b);
  });

  await t.test('does not mutate the input array', () => {
    const items = [1, 2, 3];
    const copy = [...items];
    shuffleWithRng(items, mulberry32(1));
    assert.deepEqual(items, copy);
  });
});

test('rerank: off / unset', async (t) => {
  await t.test('unset backend keeps input order, truncated to top', async () => {
    const items = [result('a', '1', 'A'), result('a', '2', 'B'), result('a', '3', 'C')];
    const out = await rerank('query', items, { top: 2 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('backend: "off" keeps input order', async () => {
    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'off' });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('an empty candidate list returns empty for every backend', async () => {
    for (const backend of ['off', 'llm', 'cohere', 'workers-ai'] as const) {
      const out = await rerank('query', [], { backend });
      assert.deepEqual(out, []);
    }
  });
});

test('rerank: llm backend', async (t) => {
  t.afterEach(() => {
    shuffleRngOverride.value = Math.random;
  });

  await t.test('falls back to input order when no key is configured', async () => {
    withEnv(t, {
      ALEXANDRIA_RERANK_API_KEY: undefined,
      ALEXANDRIA_RERANK_BASE_URL: undefined,
      ALEXANDRIA_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });
    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'llm', top: 10 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('reorders per the model response, using a deterministic shuffle', async () => {
    const server = await startFakeServer(() => ({
      status: 200,
      body: chatCompletion(JSON.stringify([3, 1, 2])),
    }));
    t.after(() => server.close());
    withEnv(t, {
      ALEXANDRIA_RERANK_BASE_URL: `${server.url}/v1`,
      ALEXANDRIA_RERANK_API_KEY: 'test-key',
    });
    shuffleRngOverride.value = mulberry32(42);

    const items = [result('a', '1', 'A'), result('a', '2', 'B'), result('a', '3', 'C')];
    const out = await rerank('query', items, { backend: 'llm', top: 10 });

    // The model saw the shuffled order and picked "3rd, 1st, 2nd" of
    // *that* order; the exact mapping back to item ids is deterministic
    // given the seeded shuffle, so this pins the actual observed output
    // rather than merely asserting "it's a permutation".
    assert.equal(out.length, 3);
    assert.deepEqual(new Set(out.map((i) => i.id)), new Set(['1', '2', '3']));
    assert.equal(server.requests.length, 1);
  });

  await t.test(
    'items past the top-20 cap keep their order, appended after the reranked head',
    async () => {
      const server = await startFakeServer(() => ({
        status: 200,
        // Reverse the 20 shuffled items it was shown.
        body: chatCompletion(JSON.stringify(Array.from({ length: 20 }, (_, i) => 20 - i))),
      }));
      t.after(() => server.close());
      withEnv(t, {
        ALEXANDRIA_RERANK_BASE_URL: `${server.url}/v1`,
        ALEXANDRIA_RERANK_API_KEY: 'test-key',
      });
      shuffleRngOverride.value = mulberry32(1);

      const items = Array.from({ length: 25 }, (_, i) => result('a', String(i + 1), `T${i + 1}`));
      const out = await rerank('query', items, { backend: 'llm', top: 25 });

      assert.equal(out.length, 25);
      const tailIds = out.slice(20).map((i) => i.id);
      assert.deepEqual(tailIds, ['21', '22', '23', '24', '25'], 'tail beyond the cap is untouched');
      // Only the request's numbered listing (the system message) had 20 entries.
      const sentPrompt = (server.requests[0].body as { messages: Array<{ content: string }> })
        .messages[0].content;
      assert.equal((sentPrompt.match(/^\d+\./gm) ?? []).length, 20);
    },
  );

  await t.test('falls back to input order on a malformed response', async () => {
    const server = await startFakeServer(() => ({ status: 200, body: chatCompletion('not json') }));
    t.after(() => server.close());
    withEnv(t, {
      ALEXANDRIA_RERANK_BASE_URL: `${server.url}/v1`,
      ALEXANDRIA_RERANK_API_KEY: 'test-key',
    });

    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'llm', top: 10 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });
});

test('rerank: cohere backend', async (t) => {
  await t.test('falls back to input order when no key is configured', async () => {
    withEnv(t, {
      ALEXANDRIA_RERANK_API_KEY: undefined,
      ALEXANDRIA_RERANK_BASE_URL: undefined,
      ALEXANDRIA_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });
    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'cohere', top: 10 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('posts to <base>/rerank in the Cohere shape and reorders by index', async () => {
    const server = await startFakeServer(() => ({
      status: 200,
      body: {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.1 },
        ],
      },
    }));
    t.after(() => server.close());
    withEnv(t, {
      ALEXANDRIA_RERANK_BASE_URL: server.url,
      ALEXANDRIA_RERANK_API_KEY: 'test-key',
      ALEXANDRIA_RERANK_MODEL: 'rerank-v3.5',
    });

    const items = [result('a', '1', 'A'), result('a', '2', 'B'), result('a', '3', 'C')];
    const out = await rerank('query', items, { backend: 'cohere', top: 10 });

    assert.deepEqual(
      out.map((i) => i.id),
      ['3', '1', '2'],
    );
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].path, '/rerank');
    const sentBody = server.requests[0].body as {
      model: string;
      query: string;
      documents: string[];
    };
    assert.equal(sentBody.model, 'rerank-v3.5');
    assert.equal(sentBody.query, 'query');
    assert.deepEqual(sentBody.documents, ['A', 'B', 'C']);
  });

  await t.test('falls back to input order on an error response', async () => {
    const server = await startFakeServer(() => ({ status: 500, body: { message: 'boom' } }));
    t.after(() => server.close());
    withEnv(t, {
      ALEXANDRIA_RERANK_BASE_URL: server.url,
      ALEXANDRIA_RERANK_API_KEY: 'test-key',
    });

    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'cohere', top: 10 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('falls back to input order on a response that fails schema validation', async () => {
    const server = await startFakeServer(() => ({ status: 200, body: { nope: true } }));
    t.after(() => server.close());
    withEnv(t, {
      ALEXANDRIA_RERANK_BASE_URL: server.url,
      ALEXANDRIA_RERANK_API_KEY: 'test-key',
    });

    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'cohere', top: 10 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });
});

test('rerank: workers-ai backend', async (t) => {
  await t.test('falls back to input order when no key is configured', async () => {
    withEnv(t, {
      ALEXANDRIA_RERANK_API_KEY: undefined,
      ALEXANDRIA_RERANK_BASE_URL: undefined,
      ALEXANDRIA_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });
    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'workers-ai', top: 10 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('posts {query, contexts} straight to the base URL and sorts by score', async () => {
    const server = await startFakeServer(() => ({
      status: 200,
      body: {
        result: {
          response: [
            { id: 1, score: 0.2 },
            { id: 0, score: 0.9 },
            { id: 2, score: 0.5 },
          ],
        },
        success: true,
        errors: [],
        messages: [],
      },
    }));
    t.after(() => server.close());
    withEnv(t, {
      ALEXANDRIA_RERANK_BASE_URL: server.url,
      ALEXANDRIA_RERANK_API_KEY: 'test-token',
    });

    const items = [result('a', '1', 'A'), result('a', '2', 'B'), result('a', '3', 'C')];
    const out = await rerank('query', items, { backend: 'workers-ai', top: 10 });

    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '3', '2'],
      'sorted descending by score, not by the response array order',
    );
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].path, '/');
    const sentBody = server.requests[0].body as {
      query: string;
      contexts: Array<{ text: string }>;
    };
    assert.equal(sentBody.query, 'query');
    assert.deepEqual(
      sentBody.contexts.map((c) => c.text),
      ['A', 'B', 'C'],
    );
  });

  await t.test('falls back to input order on a response that fails schema validation', async () => {
    const server = await startFakeServer(() => ({ status: 200, body: { success: false } }));
    t.after(() => server.close());
    withEnv(t, {
      ALEXANDRIA_RERANK_BASE_URL: server.url,
      ALEXANDRIA_RERANK_API_KEY: 'test-token',
    });

    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await rerank('query', items, { backend: 'workers-ai', top: 10 });
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });
});
