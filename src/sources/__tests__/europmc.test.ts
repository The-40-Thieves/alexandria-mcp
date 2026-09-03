import assert from 'node:assert/strict';
import test from 'node:test';
import { europmcRead, europmcSearch } from '../europmc.ts';
import { getAdapter } from '../registry.ts';

const RESULT = {
  id: '12345',
  source: 'MED',
  pmid: '12345',
  title: 'A Europe PMC Article',
  authorString: 'Author A, Author B',
  pubYear: '2021',
  abstractText: 'An abstract of the article.',
  doi: '10.1234/epmc.5678',
};

test('europmcSearch maps results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ resultList: { result: [RESULT] } }), {
      status: 200,
    })) as typeof fetch;
  try {
    const out = await europmcSearch('malaria', 5);
    assert.equal(out[0].id, 'MED:12345');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('europmcRead carries the doi through on the abstract-only path', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('fullTextXML')) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ resultList: { result: [RESULT] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await europmcRead('MED:12345');
    assert.equal(result.title, 'A Europe PMC Article');
    assert.equal(result.doi, '10.1234/epmc.5678');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('europmc adapter is registered', () => {
  assert.ok(getAdapter('europmc'));
});
