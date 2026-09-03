import assert from 'node:assert/strict';
import test from 'node:test';
import { plosRead, plosSearch } from '../plos.ts';
import { getAdapter } from '../registry.ts';

const DOC = {
  id: '10.1371/journal.pone.0000308',
  title: 'A PLOS Article',
  author: ['A. Author'],
  publication_date: '2007-03-21T00:00:00Z',
  abstract: ['An abstract of the article.'],
};

test('plosSearch maps docs, using the PLOS id as a DOI in previewUrl', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ response: { docs: [DOC], numFound: 1 } }), {
      status: 200,
    })) as typeof fetch;
  try {
    const out = await plosSearch('malaria', 5);
    assert.equal(out[0].id, '10.1371/journal.pone.0000308');
    assert.equal(out[0].previewUrl, 'https://doi.org/10.1371/journal.pone.0000308');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plosRead: PLOS article ids ARE DOIs, so doi mirrors the id', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ response: { docs: [DOC], numFound: 1 } }), {
      status: 200,
    })) as typeof fetch;
  try {
    const result = await plosRead('10.1371/journal.pone.0000308');
    assert.equal(result.title, 'A PLOS Article');
    assert.equal(result.doi, '10.1371/journal.pone.0000308');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plos adapter is registered', () => {
  assert.ok(getAdapter('plos'));
});
