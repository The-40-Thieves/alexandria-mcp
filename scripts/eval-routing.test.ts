import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/sources/all.js';
import { listSources } from '../src/sources/registry.js';
import { loadGolden, ndcgAt5, recallAt5 } from './eval-routing.js';

test('routing-golden.yaml', async (t) => {
  await t.test('parses to a non-empty list of {query, expected}', () => {
    const golden = loadGolden();
    assert.ok(golden.length >= 60, `expected at least 60 entries, got ${golden.length}`);
    for (const entry of golden) {
      assert.ok(entry.query.length > 0);
      assert.ok(entry.expected.length >= 1 && entry.expected.length <= 3, entry.query);
    }
  });

  await t.test('every expected source exists (hidden sources count, via listSources())', () => {
    const golden = loadGolden();
    // listSources(), not catalog(): a golden entry may legitimately name a
    // source that's currently hidden (needs an API key not set here), and
    // that's still a real, valid source name, not a typo.
    const names = new Set(listSources().map((s) => s.name));
    for (const entry of golden) {
      for (const source of entry.expected) {
        assert.ok(names.has(source), `"${entry.query}" names unknown source "${source}"`);
      }
    }
  });

  await t.test('covers every cluster the registry declares', () => {
    const golden = loadGolden();
    const clusterByName = new Map(listSources().map((s) => [s.name, s.cluster]));
    const coveredClusters = new Set(golden.map((e) => clusterByName.get(e.expected[0])));
    const allClusters = new Set(listSources().map((s) => s.cluster));
    for (const cluster of allClusters) {
      assert.ok(
        coveredClusters.has(cluster),
        `no golden query's first expected source is in cluster "${cluster}"`,
      );
    }
  });
});

test('ndcgAt5', async (t) => {
  await t.test('is 1 when the single relevant item is ranked first', () => {
    assert.equal(ndcgAt5(['a', 'b', 'c'], new Set(['a'])), 1);
  });

  await t.test('is 0 when no relevant item appears in the top 5', () => {
    assert.equal(ndcgAt5(['a', 'b', 'c', 'd', 'e', 'f'], new Set(['f'])), 0);
  });

  await t.test('penalizes a relevant item ranked lower', () => {
    const first = ndcgAt5(['a', 'b'], new Set(['a']));
    const second = ndcgAt5(['b', 'a'], new Set(['a']));
    assert.ok(second < first);
  });

  await t.test('scores multiple relevant items against the ideal ordering', () => {
    // Both relevant items in the top 2: this is the ideal ordering, so
    // nDCG should be exactly 1.
    assert.equal(ndcgAt5(['a', 'b', 'c'], new Set(['a', 'b'])), 1);
  });
});

test('recallAt5', async (t) => {
  await t.test('is 1 when every expected item is in the top 5', () => {
    assert.equal(recallAt5(['a', 'b', 'c'], new Set(['a', 'b'])), 1);
  });

  await t.test('is fractional when only some expected items are found', () => {
    assert.equal(recallAt5(['a', 'x', 'y', 'z', 'w'], new Set(['a', 'b'])), 0.5);
  });

  await t.test('ignores anything past rank 5', () => {
    assert.equal(recallAt5(['x', 'x', 'x', 'x', 'x', 'a'], new Set(['a'])), 0);
  });
});
