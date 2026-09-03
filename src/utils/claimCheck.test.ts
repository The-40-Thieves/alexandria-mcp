import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { Citation } from '../tools/libraryAnswer.ts';
import { checkClaims } from './claimCheck.ts';

interface FakeServer {
  url: string;
  requests: Array<{ messages: Array<{ role: string; content: string }> }>;
  close(): Promise<void>;
}

type ChatHandler = (body: { messages: Array<{ role: string; content: string }> }) => unknown;

// Mirrors src/tools/libraryAnswer.test.ts's own fake OpenAI-compatible
// fixture (same fake /v1/chat/completions shape), pointed at the `verify`
// role's own env vars rather than `synth`'s.
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

function citation(n: number, overrides: Partial<Citation> = {}): Citation {
  return { n, source: 'test', id: `id-${n}`, title: `Title ${n}`, ...overrides };
}

test('checkClaims', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });
  process.env.ALEXANDRIA_VERIFY_BASE_URL = '';
  process.env.ALEXANDRIA_VERIFY_API_KEY = 'verify-key';
  process.env.ALEXANDRIA_VERIFY_JSON_MODE = '1';

  await t.test('an uncited sentence produces no verdict at all', async () => {
    const server = await startFakeChatServer(() => {
      throw new Error('should not call the verify role for an uncited sentence');
    });
    t.after(() => server.close());
    process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

    const verdicts = await checkClaims('Plain prose with no citation marker.', [], []);
    assert.deepEqual(verdicts, []);
    assert.equal(server.requests.length, 0);
  });

  await t.test('a cited sentence with evidence is judged via one batched call', async () => {
    const server = await startFakeChatServer((body) => {
      assert.match(body.messages[1].content, /CLAIM 0:/);
      assert.match(body.messages[1].content, /SOURCE TEXT 0:/);
      return { results: [{ index: 0, supported: true, strengthWarranted: true }] };
    });
    t.after(() => server.close());
    process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

    const citations = [citation(1)];
    const chunks = [{ n: 1, text: 'The API added rate limiting in 2025.' }];
    const verdicts = await checkClaims(
      'The API added rate limiting in 2025 [1].',
      citations,
      chunks,
    );

    assert.equal(server.requests.length, 1);
    assert.deepEqual(verdicts, [
      {
        sentence: 'The API added rate limiting in 2025 [1].',
        citations: [1],
        supported: true,
        strengthWarranted: true,
      },
    ]);
  });

  await t.test(
    'an unsupported verdict is reported as such, without altering the sentence text',
    async () => {
      const server = await startFakeChatServer(() => ({
        results: [{ index: 0, supported: false, strengthWarranted: false, note: 'not mentioned' }],
      }));
      t.after(() => server.close());
      process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

      const citations = [citation(1)];
      const chunks = [{ n: 1, text: 'Completely unrelated text.' }];
      const verdicts = await checkClaims(
        'The API added rate limiting in 2025 [1].',
        citations,
        chunks,
      );

      assert.equal(verdicts[0].supported, false);
      assert.equal(verdicts[0].strengthWarranted, false);
      assert.equal(verdicts[0].note, 'not mentioned');
    },
  );

  await t.test(
    'supported but over-strength: strengthWarranted false, supported stays true',
    async () => {
      const server = await startFakeChatServer(() => ({
        results: [{ index: 0, supported: true, strengthWarranted: false, note: 'overgeneralized' }],
      }));
      t.after(() => server.close());
      process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

      const citations = [citation(1)];
      const chunks = [{ n: 1, text: 'A study of one dataset found X.' }];
      const verdicts = await checkClaims('X is universally true [1].', citations, chunks);

      assert.equal(verdicts[0].supported, true);
      assert.equal(verdicts[0].strengthWarranted, false);
    },
  );

  await t.test(
    'a model claiming supported: false but strengthWarranted: true is normalized to false',
    async () => {
      const server = await startFakeChatServer(() => ({
        results: [{ index: 0, supported: false, strengthWarranted: true }],
      }));
      t.after(() => server.close());
      process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

      const citations = [citation(1)];
      const chunks = [{ n: 1, text: 'Some text.' }];
      const verdicts = await checkClaims('A claim [1].', citations, chunks);
      assert.equal(verdicts[0].supported, false);
      assert.equal(verdicts[0].strengthWarranted, false);
    },
  );

  await t.test(
    'a citation with no available chunk text fails closed without calling the model',
    async () => {
      const server = await startFakeChatServer(() => {
        throw new Error('should not be called when no chunk text exists for the citation');
      });
      t.after(() => server.close());
      process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

      const citations = [citation(1)];
      const verdicts = await checkClaims('A claim with a dangling reference [1].', citations, []);

      assert.equal(server.requests.length, 0);
      assert.equal(verdicts[0].supported, false);
      assert.equal(verdicts[0].strengthWarranted, false);
      assert.match(verdicts[0].note ?? '', /no source text available/);
    },
  );

  await t.test(
    'a citation marker referencing an unknown n is ignored (not treated as cited)',
    async () => {
      const server = await startFakeChatServer(() => {
        throw new Error('should not be called - the only marker points at an unknown citation');
      });
      t.after(() => server.close());
      process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

      const verdicts = await checkClaims('A claim citing nothing real [9].', [], []);
      assert.deepEqual(verdicts, []);
      assert.equal(server.requests.length, 0);
    },
  );

  await t.test('more than 8 cited sentences are split across multiple batched calls', async () => {
    const server = await startFakeChatServer((body) => {
      const claimCount = (body.messages[1].content.match(/CLAIM \d+:/g) ?? []).length;
      const results = Array.from({ length: claimCount }, (_, i) => ({
        index: i,
        supported: true,
        strengthWarranted: true,
      }));
      return { results };
    });
    t.after(() => server.close());
    process.env.ALEXANDRIA_VERIFY_BASE_URL = server.url;

    const citations = [citation(1)];
    const chunks = [{ n: 1, text: 'Shared evidence text.' }];
    const sentences = Array.from({ length: 10 }, (_, i) => `Claim number ${i} happened [1].`);
    const verdicts = await checkClaims(sentences.join(' '), citations, chunks);

    assert.equal(verdicts.length, 10);
    assert.ok(verdicts.every((v) => v.supported && v.strengthWarranted));
    assert.equal(server.requests.length, 2, 'batches of 8 -> ceil(10/8) = 2 calls');
  });
});
