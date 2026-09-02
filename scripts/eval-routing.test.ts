import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/sources/all.ts';
import { listSources } from '../src/sources/registry.ts';
import {
  type GoldenQuery,
  loadGolden,
  ndcgAt5,
  recallAt5,
  recallAt20,
  score,
} from './eval-routing.ts';

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

test('recallAt20', async (t) => {
  await t.test('finds an expected item beyond rank 5 but within rank 20', () => {
    const ranked = ['x', 'x', 'x', 'x', 'x', 'x', 'a'];
    assert.equal(recallAt5(ranked, new Set(['a'])), 0, 'sanity: recall@5 misses it');
    assert.equal(recallAt20(ranked, new Set(['a'])), 1);
  });

  await t.test('ignores anything past rank 20', () => {
    const ranked = Array(20).fill('x').concat('a');
    assert.equal(recallAt20(ranked, new Set(['a'])), 0);
  });
});

test('score (hidden-expected fairness)', async (t) => {
  const clusterByName = new Map([
    ['visible1', 'developer'],
    ['visible2', 'developer'],
    ['hidden1', 'developer'],
    ['hidden2', 'security'],
  ]);

  await t.test('drops a hidden expected source and still scores the visible ones', () => {
    const golden: GoldenQuery[] = [{ query: 'q1', expected: ['visible1', 'hidden1'] }];
    const hiddenNames = new Set(['hidden1']);
    const result = score(golden, clusterByName, hiddenNames, () => ['visible1'], {
      includeRecall20: true,
    });
    assert.equal(result.overall.ndcg.length, 1, 'the query is still scored');
    assert.equal(
      result.overall.ndcg[0],
      1,
      'visible1 ranked first against the visible-only expected set',
    );
    assert.equal(result.overall.skippedHiddenExpected, 1);
    assert.equal(result.overall.skippedQueries, 0);
  });

  await t.test('excludes a query entirely when every expected source is hidden', () => {
    const golden: GoldenQuery[] = [{ query: 'q2', expected: ['hidden2'] }];
    const hiddenNames = new Set(['hidden2']);
    const result = score(golden, clusterByName, hiddenNames, () => ['visible1'], {
      includeRecall20: true,
    });
    assert.equal(result.overall.ndcg.length, 0, 'excluded from the averages, not scored as a miss');
    assert.equal(result.overall.recall5.length, 0);
    assert.equal(result.overall.skippedHiddenExpected, 1);
    assert.equal(result.overall.skippedQueries, 1);
  });

  await t.test('a query with no hidden sources scores and counts normally', () => {
    const golden: GoldenQuery[] = [{ query: 'q3', expected: ['visible1', 'visible2'] }];
    const hiddenNames = new Set(['hidden1', 'hidden2']);
    const result = score(golden, clusterByName, hiddenNames, () => ['visible1', 'visible2'], {
      includeRecall20: true,
    });
    assert.equal(result.overall.ndcg.length, 1);
    assert.equal(result.overall.skippedHiddenExpected, 0);
    assert.equal(result.overall.skippedQueries, 0);
  });

  await t.test('per-cluster counts match the overall totals', () => {
    const golden: GoldenQuery[] = [
      { query: 'q1', expected: ['visible1', 'hidden1'] }, // developer
      { query: 'q2', expected: ['hidden2'] }, // security
    ];
    const hiddenNames = new Set(['hidden1', 'hidden2']);
    const result = score(golden, clusterByName, hiddenNames, () => ['visible1'], {
      includeRecall20: false,
    });
    assert.equal(result.byCluster.get('developer')?.skippedHiddenExpected, 1);
    assert.equal(result.byCluster.get('developer')?.skippedQueries, 0);
    assert.equal(result.byCluster.get('security')?.skippedHiddenExpected, 1);
    assert.equal(result.byCluster.get('security')?.skippedQueries, 1);
    assert.equal(result.overall.skippedHiddenExpected, 2);
    assert.equal(result.overall.skippedQueries, 1);
  });

  await t.test('recall20 is only populated when includeRecall20 is true', () => {
    const golden: GoldenQuery[] = [{ query: 'q1', expected: ['visible1'] }];
    const withIt = score(golden, clusterByName, new Set(), () => ['visible1'], {
      includeRecall20: true,
    });
    const withoutIt = score(golden, clusterByName, new Set(), () => ['visible1'], {
      includeRecall20: false,
    });
    assert.equal(withIt.overall.recall20.length, 1);
    assert.equal(withoutIt.overall.recall20.length, 0);
  });
});
