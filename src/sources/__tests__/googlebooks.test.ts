import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { googleBooksSearch, normalizeGoogleBooks } from '../googlebooks.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/googlebooks-search.json'), 'utf8'),
);

test('normalizeGoogleBooks', async (t) => {
  await t.test('maps volumes[] and marks public-domain/ALL_PAGES as full text', () => {
    const out = normalizeGoogleBooks(fixture, 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'wrOQLV6xB-wC');
    assert.equal(out[0].hasFullText, true);
    assert.equal(out[1].hasFullText, false);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeGoogleBooks(fixture, 1).length, 1);
  });
});

test('googleBooksSearch throws a clear "requires GOOGLE_BOOKS_API_KEY" error when unconfigured', async () => {
  const saved = process.env.GOOGLE_BOOKS_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  try {
    await assert.rejects(googleBooksSearch('science', 5), /requires GOOGLE_BOOKS_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.GOOGLE_BOOKS_API_KEY = saved;
  }
});
