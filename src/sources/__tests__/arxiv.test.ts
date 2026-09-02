import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeArxiv } from '../arxiv.js';

const xml = readFileSync(path.resolve(process.cwd(), 'eval/fixtures/arxiv-search.xml'), 'utf8');

test('normalizeArxiv', async (t) => {
  await t.test('parses <entry> elements from the Atom feed', () => {
    const out = normalizeArxiv(xml);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '2201.00978');
    assert.match(out[0].title, /PyramidTNT/);
    assert.equal(out[0].previewUrl, 'https://arxiv.org/abs/2201.00978');
    assert.equal(out[0].hasFullText, true);
  });

  await t.test('handles an empty feed', () => {
    assert.deepEqual(normalizeArxiv('<feed></feed>'), []);
  });
});
