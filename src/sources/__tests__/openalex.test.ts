import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeOpenAlex, openalexSearch } from '../openalex.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/openalex-search.json'), 'utf8'),
);

test('normalizeOpenAlex', async (t) => {
  await t.test('maps works[] and reconstructs the abstract from the inverted index', () => {
    const out = normalizeOpenAlex(fixture);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'W2101234009');
    assert.equal(out[0].title, 'Scikit-learn: Machine Learning in Python');
    assert.ok(out[0].authors.length > 0);
  });
});

test('openalexSearch uses api_key when set, otherwise falls back to mailto', async () => {
  const savedKey = process.env.OPENALEX_API_KEY;
  const savedMail = process.env.CONTACT_EMAIL;
  process.env.OPENALEX_API_KEY = 'test-key';
  delete process.env.CONTACT_EMAIL;

  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = (async (url: string | URL | Request) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as typeof fetch;

  try {
    await openalexSearch('machine learning', 2);
    assert.match(capturedUrl, /api_key=test-key/);
    assert.doesNotMatch(capturedUrl, /mailto=/);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey !== undefined) process.env.OPENALEX_API_KEY = savedKey;
    else delete process.env.OPENALEX_API_KEY;
    if (savedMail !== undefined) process.env.CONTACT_EMAIL = savedMail;
  }
});
