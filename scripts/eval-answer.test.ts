import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import '../src/sources/all.ts';
import { listSources } from '../src/sources/registry.ts';
import { type DnsLookupAll, dnsResolver } from '../src/web/fetchTier.ts';
import {
  checkResolvable,
  fraction,
  loadAnswerGolden,
  type QueryJudgments,
  scoreAnswerQuery,
} from './eval-answer.ts';

test('answer-golden.yaml', async (t) => {
  await t.test('parses to a non-empty list of {query, expected_nuggets, expected_sources}', () => {
    const golden = loadAnswerGolden();
    assert.ok(golden.length >= 20, `expected at least 20 entries, got ${golden.length}`);
    for (const entry of golden) {
      assert.ok(entry.query.length > 0);
      assert.ok(
        entry.expected_nuggets.length >= 3 && entry.expected_nuggets.length <= 6,
        entry.query,
      );
      assert.ok(entry.expected_sources.length >= 1, entry.query);
    }
  });

  await t.test('every expected source exists (hidden sources count, via listSources())', () => {
    const golden = loadAnswerGolden();
    const names = new Set(listSources().map((s) => s.name));
    for (const entry of golden) {
      for (const source of entry.expected_sources) {
        assert.ok(names.has(source), `"${entry.query}" names unknown source "${source}"`);
      }
    }
  });
});

test('fraction', async (t) => {
  await t.test('is null for an empty list (nothing to judge)', () => {
    assert.equal(fraction([]), null);
  });

  await t.test('is 1 when every result is true', () => {
    assert.equal(fraction([true, true]), 1);
  });

  await t.test('is 0 when every result is false (a real 0, not "nothing to judge")', () => {
    assert.equal(fraction([false, false]), 0);
  });

  await t.test('is fractional for a mix', () => {
    assert.equal(fraction([true, false, true, false]), 0.5);
  });
});

test('scoreAnswerQuery', async (t) => {
  await t.test('citation precision and resolvability are null with nothing to judge', () => {
    const judgments: QueryJudgments = {
      citationEntailed: [],
      nuggetCovered: [true, false, true],
      resolved: [],
    };
    const score = scoreAnswerQuery(judgments);
    assert.equal(score.citationPrecision, null);
    assert.equal(score.resolvability, null);
    assert.ok(Math.abs(score.nuggetRecall - 2 / 3) < 1e-9);
  });

  await t.test('citation precision is the fraction of entailed cited sentences', () => {
    const judgments: QueryJudgments = {
      citationEntailed: [true, true, false, true],
      nuggetCovered: [true, true],
      resolved: [true],
    };
    const score = scoreAnswerQuery(judgments);
    assert.equal(score.citationPrecision, 0.75);
    assert.equal(score.nuggetRecall, 1);
    assert.equal(score.resolvability, 1);
  });

  await t.test('every cited sentence unwarranted scores precision 0, not null', () => {
    const judgments: QueryJudgments = {
      citationEntailed: [false, false],
      nuggetCovered: [false, false, false],
      resolved: [false],
    };
    const score = scoreAnswerQuery(judgments);
    assert.equal(score.citationPrecision, 0);
    assert.equal(score.nuggetRecall, 0);
    assert.equal(score.resolvability, 0);
  });

  await t.test('nugget recall falls back to 0 for a fixture with no nuggets at all', () => {
    // Real golden entries always have 3-6 nuggets (loadAnswerGolden
    // enforces it); this only exercises scoreAnswerQuery's own defensive
    // fallback for an empty nuggetCovered array.
    const judgments: QueryJudgments = { citationEntailed: [], nuggetCovered: [], resolved: [] };
    assert.equal(scoreAnswerQuery(judgments).nuggetRecall, 0);
  });
});

// A local http.Server bound to 127.0.0.1, tracking which method reached
// each route. Deliberately bound to a literal loopback address rather than
// used through 'localhost': the point of these tests is to prove
// checkResolvable pins the connection for an ORDINARY HOSTNAME target
// (real citation URLs are hostnames, e.g. https://en.wikipedia.org/...),
// which is exactly the case guardedDispatcher's connect.lookup fails
// closed on without a pin in scope - a literal-IP URL would skip
// connect.lookup entirely and never exercise the bug this guards against.
interface ResolvabilityServer {
  port: number;
  // Every request actually received, in order - used to prove a `false`
  // result came from a real HTTP response (a 404, say) and not from the
  // guarded fetch failing to reach the server at all (e.g. the pinning bug
  // this suite regression-tests for: without a pin, guardedDispatcher
  // refuses the connection outright, which also surfaces as `false` and
  // would otherwise make a "404 means unresolvable" assertion pass for the
  // wrong reason).
  requests: string[];
  close(): Promise<void>;
}
function startResolvabilityServer(): Promise<ResolvabilityServer> {
  const requests: string[] = [];
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === '/ok') {
        res.writeHead(200);
        res.end(req.method === 'HEAD' ? undefined : 'ok');
        return;
      }
      if (req.url === '/notfound') {
        res.writeHead(404);
        res.end(req.method === 'HEAD' ? undefined : 'not found');
        return;
      }
      if (req.url === '/head-blocked') {
        if (req.method === 'HEAD') {
          res.writeHead(405);
          res.end();
        } else {
          res.writeHead(200);
          res.end('ok via get');
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, requests, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

test('checkResolvable', async (t) => {
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });
  // The stubbed hostname below resolves to 127.0.0.1, which classifies as
  // loopback - allowed here the same way fetchTier.test.ts's own guarded-
  // fetch tests allow it, via ALEXANDRIA_ALLOW_LOOPBACK=1.
  process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
  dnsResolver.lookup = (async () => [{ address: '127.0.0.1', family: 4 }]) satisfies DnsLookupAll;

  await t.test('a 2xx response counts as resolvable', async () => {
    const server = await startResolvabilityServer();
    t.after(() => server.close());
    const resolvable = await checkResolvable(`http://resolvable-ok.invalid:${server.port}/ok`);
    assert.equal(resolvable, true);
    assert.deepEqual(
      server.requests,
      ['HEAD /ok'],
      'the guarded fetch must actually have reached the server (proves the pin worked)',
    );
  });

  await t.test('a 404 response does not count as resolvable', async () => {
    const server = await startResolvabilityServer();
    t.after(() => server.close());
    const resolvable = await checkResolvable(
      `http://resolvable-404.invalid:${server.port}/notfound`,
    );
    assert.equal(resolvable, false);
    // Both methods must have reached the server (a 404 falls back from
    // HEAD to GET, and both come back 404) - this is what distinguishes
    // "the server said 404" from "the connection never reached the server
    // at all" (which also reads as `false`, but for the wrong reason - the
    // exact way this test would have passed against the pinning bug this
    // suite regression-tests for, without this assertion).
    assert.deepEqual(server.requests, ['HEAD /notfound', 'GET /notfound']);
  });

  await t.test('a HEAD 405 falls back to a GET, which counts as resolvable', async () => {
    const server = await startResolvabilityServer();
    t.after(() => server.close());
    const resolvable = await checkResolvable(
      `http://resolvable-head405.invalid:${server.port}/head-blocked`,
    );
    assert.equal(resolvable, true);
    assert.deepEqual(server.requests, ['HEAD /head-blocked', 'GET /head-blocked']);
  });

  await t.test(
    'the guard rejecting a private address counts as unresolvable, without throwing',
    async () => {
      // A literal RFC 1918 address: always blocked, no ALEXANDRIA_ALLOW_LOOPBACK
      // override applies (that only ever covers loopback). No server is
      // started - resolveFetchTarget must reject before any fetch is
      // attempted, and checkResolvable must turn that rejection into
      // `false` rather than letting it propagate.
      const resolvable = await checkResolvable('http://10.1.2.3/');
      assert.equal(resolvable, false);
    },
  );
});
