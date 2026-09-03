import assert from 'node:assert/strict';
import test from 'node:test';
import { doajRead, doajSearch } from '../doaj.ts';
import { getAdapter } from '../registry.ts';

const BIBJSON = {
  title: 'A DOAJ Article',
  author: [{ name: 'A. Author' }],
  year: '2020',
  abstract: 'An abstract of the article.',
  identifier: [
    { id: '10.3390/idr12030022', type: 'doi' },
    { id: '2036-7449', type: 'eissn' },
  ],
};

test('doajSearch maps results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results: [{ id: 'abc123', bibjson: BIBJSON }] }), {
      status: 200,
    })) as typeof fetch;
  try {
    const out = await doajSearch('malaria', 5);
    assert.equal(out[0].id, 'abc123');
    assert.equal(out[0].title, 'A DOAJ Article');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('doajRead extracts the doi from bibjson.identifier (type: doi)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'abc123', bibjson: BIBJSON }), {
      status: 200,
    })) as typeof fetch;
  try {
    const result = await doajRead('abc123');
    assert.equal(result.title, 'A DOAJ Article');
    assert.equal(result.doi, '10.3390/idr12030022');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('doajRead leaves doi undefined when bibjson has no doi identifier', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: 'abc123', bibjson: { ...BIBJSON, identifier: [] } }), {
      status: 200,
    })) as typeof fetch;
  try {
    const result = await doajRead('abc123');
    assert.equal(result.doi, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('doaj adapter is registered', () => {
  assert.ok(getAdapter('doaj'));
});
