import assert from 'node:assert/strict';
import test from 'node:test';
import { osfRead, osfSearch } from '../osf.ts';
import { getAdapter } from '../registry.ts';

const PREPRINT = {
  id: 'abc12',
  attributes: {
    title: 'An OSF Preprint',
    description: 'An abstract of the preprint.',
    date_published: '2022-01-01',
    doi: '10.31219/osf.io/abc12',
  },
};

test('osfSearch maps results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [PREPRINT] }), { status: 200 })) as typeof fetch;
  try {
    const out = await osfSearch('malaria', 5);
    assert.equal(out[0].id, 'abc12');
    assert.equal(out[0].previewUrl, 'https://doi.org/10.31219/osf.io/abc12');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('osfRead carries the doi through', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: PREPRINT }), { status: 200 })) as typeof fetch;
  try {
    const result = await osfRead('abc12');
    assert.equal(result.title, 'An OSF Preprint');
    assert.equal(result.doi, '10.31219/osf.io/abc12');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('osf adapter is registered', () => {
  assert.ok(getAdapter('osf'));
});
