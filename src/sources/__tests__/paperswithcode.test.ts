import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizePapersWithCode } from '../paperswithcode.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/paperswithcode-search.json'), 'utf8'),
);

test('normalizePapersWithCode', async (t) => {
  await t.test('maps a search result to a LibraryResult', () => {
    const out = normalizePapersWithCode(fixture.results[0]);
    assert.equal(out.id, '109717');
    assert.equal(out.source, 'paperswithcode');
    assert.ok(out.title.includes('WeMM-Embedding'));
    assert.deepEqual(out.authors, ['Junjie Zhou', 'Ke Mei', 'Lei LI']);
    assert.equal(out.year, 2026);
    assert.equal(out.url, 'https://arxiv.org/abs/2608.24053');
  });
});
