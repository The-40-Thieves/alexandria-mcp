import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { LibraryAnswerResult } from './libraryAnswer.js';
import { libraryResearch } from './libraryResearch.js';

interface FakeServer {
  url: string;
  systemPrompts: string[];
  close(): Promise<void>;
}

type Decide = (system: string, user: string) => unknown;

// A fake OpenAI-compatible /v1/chat/completions endpoint. `decide` inspects
// the system prompt to route between the loop's several distinct chatJSON
// calls (generateQueries / extractLearnings / writeReport / checkCitations
// all share one role each, distinguished only by prompt content, same as
// the real chatJSON caller does not distinguish them structurally either).
// `delayMs` lets the time-budget test make each round take a known amount
// of wall-clock time.
function startFakeChatServer(decide: Decide, delayMs = 0): Promise<FakeServer> {
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
        const user = body.messages[1].content as string;
        systemPrompts.push(system);
        const respond = () => {
          const content = JSON.stringify(decide(system, user));
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
                  message: { role: 'assistant', content },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
        };
        if (delayMs > 0) setTimeout(respond, delayMs);
        else respond();
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

function decideResearch(system: string): unknown {
  if (system.includes('planning a research pass')) {
    const match = system.match(/up to (\d+) focused/);
    const n = match ? Number(match[1]) : 1;
    return { queries: Array.from({ length: n }, (_, i) => `query ${i + 1}`) };
  }
  if (system.includes('extract structured learnings')) {
    return { learnings: ['a learning'], followUps: [] };
  }
  if (system.includes('write a research report')) {
    return { report: 'Report body about the topic [1].' };
  }
  throw new Error(`unexpected research prompt: ${system.slice(0, 80)}`);
}

function decideSynthNoop(): unknown {
  return { unsupported: [] };
}

function fakeAnswer(citationId: string, n: number): LibraryAnswerResult {
  return {
    answer: `Answer text citing a source [1].`,
    citations: [{ n: 1, source: 'fake', id: citationId, title: `Title ${n}` }],
    results: [],
    routing: [],
  };
}

test('libraryResearch', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_API_KEY;

  await t.test('rejects cleanly with no research/synth key configured', async () => {
    delete process.env.ALEXANDRIA_RESEARCH_API_KEY;
    delete process.env.ALEXANDRIA_SYNTH_API_KEY;
    await assert.rejects(
      () => libraryResearch('a topic'),
      /library_research requires a research model: set OPENAI_API_KEY or ALEXANDRIA_RESEARCH_API_KEY/,
    );
  });

  await t.test('stops at depth 0 and halves breadth each round', async () => {
    const research = await startFakeChatServer(decideResearch);
    t.after(() => research.close());
    const synth = await startFakeChatServer(decideSynthNoop);
    t.after(() => synth.close());

    process.env.ALEXANDRIA_RESEARCH_BASE_URL = research.url;
    process.env.ALEXANDRIA_RESEARCH_API_KEY = 'test-key';
    process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
    process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

    let counter = 0;
    const answerFn = async (): Promise<LibraryAnswerResult> => {
      counter += 1;
      return fakeAnswer(`unique-${counter}`, counter);
    };

    const result = await libraryResearch(
      'deep research topic',
      { depth: 3, breadth: 4, maxMinutes: 6 },
      undefined,
      { answerFn },
    );

    assert.equal(result.rounds.length, 3, 'stops once depth reaches 0');
    assert.deepEqual(
      result.rounds.map((r) => r.queries.length),
      [4, 2, 1],
      'breadth halves (ceil) each round',
    );
    assert.equal(result.citations.length, 7, '4 + 2 + 1 unique sources collected');
    assert.equal(result.citations[0].n, 1);
    assert.equal(result.citations[6].n, 7);
    assert.match(result.report, /Report body about the topic/);
  });

  await t.test('stops when a round finds no new sources', async () => {
    const research = await startFakeChatServer(decideResearch);
    t.after(() => research.close());
    const synth = await startFakeChatServer(decideSynthNoop);
    t.after(() => synth.close());

    process.env.ALEXANDRIA_RESEARCH_BASE_URL = research.url;
    process.env.ALEXANDRIA_RESEARCH_API_KEY = 'test-key';
    process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
    process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

    // Every call returns the same source id, so round 2 finds nothing new.
    const answerFn = async (): Promise<LibraryAnswerResult> => fakeAnswer('same-id-always', 1);

    const result = await libraryResearch(
      'a topic that exhausts fast',
      { depth: 5, breadth: 4, maxMinutes: 6 },
      undefined,
      { answerFn },
    );

    assert.equal(result.rounds.length, 2, 'stops well short of depth 5');
    assert.equal(result.rounds[0].newSources, 1);
    assert.equal(result.rounds[1].newSources, 0);
    assert.equal(result.citations.length, 1);
  });

  await t.test('stops when the time budget is exhausted', async () => {
    // 30ms per LLM call: one round's generateQueries + several sequential
    // extractLearnings calls already exceeds a 60ms (0.001 min) budget, so
    // the loop should stop after round 1 despite a depth of 10.
    const research = await startFakeChatServer(decideResearch, 30);
    t.after(() => research.close());
    const synth = await startFakeChatServer(decideSynthNoop);
    t.after(() => synth.close());

    process.env.ALEXANDRIA_RESEARCH_BASE_URL = research.url;
    process.env.ALEXANDRIA_RESEARCH_API_KEY = 'test-key';
    process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
    process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

    let counter = 0;
    const answerFn = async (): Promise<LibraryAnswerResult> => {
      counter += 1;
      return fakeAnswer(`unique-${counter}`, counter);
    };

    const result = await libraryResearch(
      'a topic with a tight time budget',
      { depth: 10, breadth: 4, maxMinutes: 0.001 },
      undefined,
      { answerFn },
    );

    assert.ok(result.rounds.length < 10, 'the time budget cut the loop off well short of depth 10');
    assert.ok(result.rounds.length >= 1);
  });

  await t.test('emits a progress notification per round', async () => {
    const research = await startFakeChatServer(decideResearch);
    t.after(() => research.close());
    const synth = await startFakeChatServer(decideSynthNoop);
    t.after(() => synth.close());

    process.env.ALEXANDRIA_RESEARCH_BASE_URL = research.url;
    process.env.ALEXANDRIA_RESEARCH_API_KEY = 'test-key';
    process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
    process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

    const answerFn = async (): Promise<LibraryAnswerResult> => fakeAnswer('id', 1);
    const progressEvents: Array<{ round: number; message: string }> = [];

    await libraryResearch(
      'progress topic',
      { depth: 1, breadth: 1, maxMinutes: 6 },
      (info) => {
        progressEvents.push(info);
      },
      { answerFn },
    );

    assert.ok(progressEvents.length > 0);
    assert.equal(progressEvents[0].round, 1);
  });
});
