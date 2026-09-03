import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/sources/all.ts';
import { listSources } from '../src/sources/registry.ts';
import {
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
