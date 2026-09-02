import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeHn } from '../hn.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/hn-search.json'), 'utf8'),
);

test('normalizeHn', async (t) => {
  await t.test('maps a story hit to a LibraryResult', () => {
    const out = normalizeHn(fixture.hits[0]);
    assert.equal(out.id, '26406989');
    assert.equal(out.source, 'hn');
    assert.equal(out.title, "Why asynchronous Rust doesn't work");
    assert.deepEqual(out.authors, ['tazjin']);
    assert.equal(out.year, 2021);
    assert.equal(out.url, 'https://theta.eu.org/2021/03/08/async-rust-2.html');
  });

  await t.test('falls back to the HN item page when the story has no external url', () => {
    const out = normalizeHn({ ...fixture.hits[0], url: null });
    assert.equal(out.url, 'https://news.ycombinator.com/item?id=26406989');
  });
});
