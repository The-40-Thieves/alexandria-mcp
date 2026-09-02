import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeGdelt } from '../gdelt.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/gdelt-doc.json'), 'utf8'),
);

test('normalizeGdelt', async (t) => {
  await t.test('maps an article to a LibraryResult', () => {
    const out = normalizeGdelt(fixture.articles[0]);
    assert.ok(out);
    assert.equal(out?.id, 'https://example.com/news/ukraine-ceasefire-talks');
    assert.equal(out?.source, 'gdelt');
    assert.ok(out?.title.includes('ceasefire'));
    assert.equal(out?.year, 2026);
    assert.equal(out?.description, 'example.com');
  });

  await t.test('drops an article with no url', () => {
    assert.equal(normalizeGdelt({ url: '', title: 'x' }), null);
  });
});
