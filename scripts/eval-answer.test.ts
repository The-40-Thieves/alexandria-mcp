import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import '../src/sources/all.ts';
import { listSources } from '../src/sources/registry.ts';
import { type DnsLookupAll, dnsResolver } from '../src/web/fetchTier.ts';
import {
  checkResolvable,
  fraction,
  loadAnswerGolden,
  type QueryJudgments,
  resolvabilityTarget,
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

// checkResolvable is now a thin wrapper over src/utils/liveness.ts's
// checkUrlLiveness (Task 9 moved the guarded-and-pinned HEAD/GET
// implementation there so library_answer's Citation.resolves wiring and
// this script share one copy instead of two). The exhaustive
// guarded-fetch-pinning suite that used to live here (2xx/404/405/private-
// address cases, with a request log proving the pin actually worked) now
// lives in src/utils/liveness.test.ts against checkUrlLiveness directly;
// this is a thin end-to-end check that the delegation itself is wired up.
test('checkResolvable', async (t) => {
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });
  process.env.ALEXANDRIA_ALLOW_LOOPBACK = '1';
  dnsResolver.lookup = (async () => [{ address: '127.0.0.1', family: 4 }]) satisfies DnsLookupAll;

  await t.test('resolves true for a live 2xx target', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((res) => server.close(() => res(undefined))));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const resolvable = await checkResolvable(`http://eval-checkresolvable-ok.invalid:${port}/`);
    assert.equal(resolvable, true);
  });

  await t.test('resolves false for a guard-rejected private address', async () => {
    const resolvable = await checkResolvable('http://10.1.2.3/');
    assert.equal(resolvable, false);
  });
});

// Final wave (E4): a corpus-cache citation's `url` falls back to its
// source's HOMEPAGE when the chunk predates ChunkMetadata.url (see
// corpusSearch.ts), and "the homepage resolved" measures nothing. Such a
// citation is scored on its own DOI when it has one, and otherwise left
// out of the resolvability sample rather than counted as a free pass.
test('resolvabilityTarget', async (t) => {
  const base = { n: 1, title: 'A Title' };

  await t.test('an ordinary citation is scored on its url', () => {
    assert.equal(
      resolvabilityTarget({ ...base, source: 'arxiv', id: '2401.00001', url: 'https://a.test/x' }),
      'https://a.test/x',
    );
  });

  await t.test('an ordinary citation with no url falls back to its DOI', () => {
    assert.equal(
      resolvabilityTarget({ ...base, source: 'crossref', id: '10.1234/abc' }),
      'https://doi.org/10.1234/abc',
    );
  });

  await t.test('a corpus citation is scored on its DOI, never its homepage url', () => {
    assert.equal(
      resolvabilityTarget({
        ...base,
        source: 'crossref',
        id: '10.1234/abc',
        url: 'https://www.crossref.org/',
        via: 'corpus',
      }),
      'https://doi.org/10.1234/abc',
    );
  });

  await t.test('a corpus citation with no DOI is left out of the sample', () => {
    assert.equal(
      resolvabilityTarget({
        ...base,
        source: 'gutenberg',
        id: '1342',
        url: 'https://www.gutenberg.org/',
        via: 'corpus',
      }),
      undefined,
    );
  });
});
