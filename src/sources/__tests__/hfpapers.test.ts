import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeHfPapers } from '../hfpapers.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/hfpapers-search.json'), 'utf8'),
);

test('normalizeHfPapers', async (t) => {
  await t.test('maps a search item to a LibraryResult', () => {
    const out = normalizeHfPapers(fixture[0]);
    assert.ok(out);
    assert.equal(out?.id, '2408.04619');
    assert.equal(out?.source, 'hfpapers');
    assert.ok(out?.title.includes('Transformer Explainer'));
    assert.deepEqual(out?.authors, ['Aeree Cho', 'Grace C. Kim', 'Alexander Karpekov']);
    assert.equal(out?.year, 2024);
    assert.equal(out?.url, 'https://huggingface.co/papers/2408.04619');
  });

  await t.test('drops an item with no paper id', () => {
    assert.equal(normalizeHfPapers({ paper: { id: '' } }), null);
  });
});
