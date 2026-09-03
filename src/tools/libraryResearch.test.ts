import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { Citation, LibraryAnswerResult } from './libraryAnswer.ts';
import { checkCitations, libraryResearch } from './libraryResearch.ts';

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
    warnings: [],
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
    assert.deepEqual(
      result.rounds.map((r) => r.truncated),
      [false, false, false],
      'a generous time budget never truncates a round',
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

  await t.test(
    'checks the deadline per query, truncating a round instead of overrunning by a full round',
    async () => {
      // Each answerFn call takes 300ms; concurrency is 3, so the first
      // batch of 3 (of 6) queries starts immediately and is well underway
      // before the 150ms deadline. The second batch only gets a turn once
      // the first batch's slots free up (~300ms in), by which point the
      // deadline has long passed, so those queries must be skipped rather
      // than started, and the round marked truncated.
      const research = await startFakeChatServer(decideResearch);
      t.after(() => research.close());
      const synth = await startFakeChatServer(decideSynthNoop);
      t.after(() => synth.close());

      process.env.ALEXANDRIA_RESEARCH_BASE_URL = research.url;
      process.env.ALEXANDRIA_RESEARCH_API_KEY = 'test-key';
      process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
      process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

      let calls = 0;
      const answerFn = async (): Promise<LibraryAnswerResult> => {
        calls += 1;
        const n = calls;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fakeAnswer(`slow-${n}`, n);
      };

      const result = await libraryResearch(
        'a topic with a mid-round deadline',
        { depth: 1, breadth: 6, maxMinutes: 150 / 60_000 },
        undefined,
        { answerFn },
      );

      assert.equal(result.rounds.length, 1);
      assert.equal(result.rounds[0].truncated, true, 'the round is marked truncated');
      assert.ok(calls < 6, 'not every query reached answerFn before the deadline');
      assert.ok(calls >= 1, 'the first in-flight batch still ran before the deadline hit');
    },
  );

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

// checkCitations removes flagged sentences from the report itself rather
// than trusting the model to self-edit. Doing that with split/join on
// whatever string the model returned shredded the report when the model
// answered with a one-word "sentence": every incidental occurrence of that
// word vanished. Removal is now bounded by a length floor and an
// exactly-once match, with anything else kept and warned about.
test('checkCitations', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  const citations: Citation[] = [
    { n: 1, source: 'zzr_a', id: 'a1', title: 'Source A', url: undefined },
  ];

  async function runWith(report: string, unsupported: string[]) {
    const synth = await startFakeChatServer(() => ({ unsupported }));
    try {
      process.env.ALEXANDRIA_SYNTH_BASE_URL = synth.url;
      process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';
      return await checkCitations(report, citations);
    } finally {
      await synth.close();
    }
  }

  await t.test('removes a long claim that occurs exactly once', async () => {
    const report = 'The API added rate limiting in 2025 [1]. Latency fell by half [1].';
    const out = await runWith(report, ['Latency fell by half [1].']);
    assert.equal(out.report, 'The API added rate limiting in 2025 [1].');
    assert.deepEqual(out.warnings, []);
  });

  await t.test('keeps a one-word claim instead of shredding the report', async () => {
    const report = 'Yes. The API added rate limiting in 2025 [1]. Yes, latency fell [1].';
    const out = await runWith(report, ['Yes.']);
    assert.equal(out.report, report, 'the report must come back untouched');
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /too short to remove safely \(4 chars\)/);
  });

  await t.test('keeps a claim that matches more than once', async () => {
    const repeated = 'This claim is repeated verbatim in the report.';
    const report = `${repeated} Something else [1]. ${repeated}`;
    const out = await runWith(report, [repeated]);
    assert.equal(out.report, report);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /matched 2 times/);
  });

  await t.test('keeps a claim that matches zero times', async () => {
    const report = 'The API added rate limiting in 2025 [1].';
    const out = await runWith(report, ['A sentence that is not in the report at all.']);
    assert.equal(out.report, report);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /matched 0 times/);
  });

  await t.test('an empty unsupported list returns the report and no warnings', async () => {
    const report = 'The API added rate limiting in 2025 [1].';
    const out = await runWith(report, []);
    assert.equal(out.report, report);
    assert.deepEqual(out.warnings, []);
  });
});

// Task 9: library_research re-grades its final union citations' chainSupported
// signal (src/utils/citationGrade.ts) once checkCitations has run, using
// whatever a citation's originating libraryAnswer() call already computed
// for its other signals - no new network calls, just a tier recompute.
test('libraryResearch: chainSupported wiring after checkCitations', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  const draftReport =
    'Fact A occurred due to substantial evidence [1]. Fact B happened due to overwhelming evidence [2].';
  const unsupportedSentence = 'Fact B happened due to overwhelming evidence [2].';

  function decide(system: string): unknown {
    if (system.includes('planning a research pass')) return { queries: ['a single query'] };
    if (system.includes('extract structured learnings')) return { learnings: [], followUps: [] };
    if (system.includes('write a research report')) return { report: draftReport };
    if (system.includes('fact-check')) return { unsupported: [unsupportedSentence] };
    throw new Error(`unexpected prompt: ${system.slice(0, 80)}`);
  }

  const server = await startFakeChatServer(decide);
  t.after(() => server.close());
  process.env.ALEXANDRIA_RESEARCH_BASE_URL = server.url;
  process.env.ALEXANDRIA_RESEARCH_API_KEY = 'test-key';
  process.env.ALEXANDRIA_SYNTH_BASE_URL = server.url;
  process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

  const answerFn = async (): Promise<LibraryAnswerResult> => ({
    answer: 'Answer text citing sources [1][2].',
    citations: [
      {
        n: 1,
        source: 'fake',
        id: 'a',
        title: 'A',
        grade: { tier: 'A', signals: { sourceTier: 1, fullTextVerified: true } },
      },
      {
        n: 2,
        source: 'fake',
        id: 'b',
        title: 'B',
        grade: { tier: 'B', signals: { sourceTier: 2, fullTextVerified: true } },
      },
    ],
    results: [],
    routing: [],
    warnings: [],
  });

  const result = await libraryResearch(
    'a topic',
    { depth: 1, breadth: 1, maxMinutes: 6 },
    undefined,
    { answerFn },
  );

  assert.equal(result.citations.length, 2);
  const [citationA, citationB] = result.citations;

  // Citation 1's sentence survived the fact-check pass: still cited in the
  // final report, so chainSupported is true and its tier is unchanged (A).
  assert.equal(citationA.grade?.signals.chainSupported, true);
  assert.equal(citationA.grade?.tier, 'A');

  // Citation 2's sole supporting sentence was removed as unsupported: no
  // longer cited in the final report, so chainSupported is false and its
  // tier (B, sourceTier 2) downgrades one step to C.
  assert.equal(citationB.grade?.signals.chainSupported, false);
  assert.equal(citationB.grade?.tier, 'C');
  assert.doesNotMatch(result.report, /Fact B/);
});
