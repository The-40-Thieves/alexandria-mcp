import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryResult } from '../types.ts';
import { rrf } from './fuse.ts';

function result(source: string, id: string, title: string): LibraryResult {
  return { id, source, title, authors: [], hasFullText: false };
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
