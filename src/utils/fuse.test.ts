import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { LibraryResult } from '../types.js';
import { llmRerank, rrf } from './fuse.js';

function result(source: string, id: string, title: string): LibraryResult {
  return { id, source, title, authors: [], hasFullText: false };
}

interface FakeServer {
  url: string;
  requests: unknown[];
  close(): Promise<void>;
}

function startFakeChatServer(
  respond: () => { status: number; body: unknown },
): Promise<FakeServer> {
  const requests: unknown[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push(JSON.parse(raw));
        const { status, body } = respond();
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
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

function chatCompletion(content: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

test('rrf', async (t) => {
  await t.test('an item near the top of two lists outranks one at the top of only one', () => {
    const a = result('arxiv', '1', 'Attention Is All You Need');
    const b = result('semanticscholar', '2', 'Deep Residual Learning');
    const c = result('arxiv', '3', 'Only In One List');

    const fused = rrf([
      [a, b],
      [b, c],
    ]);

    assert.equal(fused[0].id, '2', 'b is ranked in both lists and should score highest');
    assert.ok(fused[0].score > fused[1].score);
    assert.ok(fused[1].score > fused[2].score);
  });

  await t.test('every item carries a score and the list is sorted descending', () => {
    const items = [result('arxiv', '1', 'A'), result('arxiv', '2', 'B'), result('arxiv', '3', 'C')];
    const fused = rrf([items]);
    assert.equal(fused.length, 3);
    for (const item of fused) assert.equal(typeof item.score, 'number');
    for (let i = 1; i < fused.length; i++) {
      assert.ok(fused[i - 1].score >= fused[i].score);
    }
  });

  await t.test('dedupes by normalized title, keeping the highest-scoring representative', () => {
    const a = result('arxiv', '1', 'Attention Is All You Need!');
    const b = result('semanticscholar', '2', 'attention is all you need');

    const fused = rrf([
      [b, a], // b ranks 1st here and again below: b should outscore a
      [b],
    ]);

    assert.equal(fused.length, 1, 'same normalized title collapses to one entry');
    assert.equal(fused[0].source, 'semanticscholar', 'the higher-scoring duplicate survives');
  });

  await t.test('a lower k gives earlier ranks a larger score boost', () => {
    const items = [result('arxiv', '1', 'A'), result('arxiv', '2', 'B')];
    const lowK = rrf([items], 1);
    const highK = rrf([items], 1000);
    // With a small k, rank 1 vs rank 2 differ by a lot; with a huge k, they
    // barely differ, since 1/(k+1) ~= 1/(k+2) as k grows.
    const lowGap = lowK[0].score - lowK[1].score;
    const highGap = highK[0].score - highK[1].score;
    assert.ok(lowGap > highGap);
  });

  await t.test('an empty list of lists returns an empty result', () => {
    assert.deepEqual(rrf([]), []);
  });
});

test('llmRerank', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('is off by default: returns input order truncated to top', async () => {
    delete process.env.ALEXANDRIA_RERANK;
    const items = [result('a', '1', 'A'), result('a', '2', 'B'), result('a', '3', 'C')];
    const out = await llmRerank('query', items, 2);
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('when enabled, reorders per the model response', async () => {
    const server = await startFakeChatServer(() => ({
      status: 200,
      body: chatCompletion(JSON.stringify([3, 1, 2])),
    }));
    t.after(() => server.close());

    process.env.ALEXANDRIA_RERANK = 'llm';
    process.env.ALEXANDRIA_RERANK_BASE_URL = server.url;
    process.env.ALEXANDRIA_RERANK_API_KEY = 'test-key';

    const items = [result('a', '1', 'A'), result('a', '2', 'B'), result('a', '3', 'C')];
    const out = await llmRerank('query', items, 10);
    assert.deepEqual(
      out.map((i) => i.id),
      ['3', '1', '2'],
    );
  });

  await t.test('falls back to input order on a malformed response', async () => {
    const server = await startFakeChatServer(() => ({
      status: 200,
      body: chatCompletion('not json'),
    }));
    t.after(() => server.close());

    process.env.ALEXANDRIA_RERANK = 'llm';
    process.env.ALEXANDRIA_RERANK_BASE_URL = server.url;
    process.env.ALEXANDRIA_RERANK_API_KEY = 'test-key';

    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await llmRerank('query', items, 10);
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });

  await t.test('falls back to input order when no key is configured', async () => {
    process.env.ALEXANDRIA_RERANK = 'llm';
    delete process.env.OPENAI_API_KEY;
    delete process.env.ALEXANDRIA_RERANK_API_KEY;
    delete process.env.ALEXANDRIA_RERANK_BASE_URL;
    delete process.env.ALEXANDRIA_API_KEY;

    const items = [result('a', '1', 'A'), result('a', '2', 'B')];
    const out = await llmRerank('query', items, 10);
    assert.deepEqual(
      out.map((i) => i.id),
      ['1', '2'],
    );
  });
});
