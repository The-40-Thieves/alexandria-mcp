import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mapPaper, s2Read, s2Search } from '../semanticscholar.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/semanticscholar-search.json'), 'utf8'),
);

test('mapPaper', async (t) => {
  await t.test('maps a Graph API paper to a LibraryResult', () => {
    const out = mapPaper(fixture.data[0]);
    assert.equal(out.id, '13c6de882218ba6c689ca5c035708b1b0e6f6b9c');
    assert.equal(out.title, 'Deep Learning');
    assert.deepEqual(out.authors, ['Yann LeCun', 'Yoshua Bengio', 'Geoffrey Hinton']);
    assert.equal(out.hasFullText, true);
    assert.equal(out.previewUrl, 'https://example.org/deep-learning.pdf');
  });

  await t.test('falls back to a DOI link when there is no OA PDF', () => {
    const out = mapPaper(fixture.data[1]);
    assert.equal(out.previewUrl, undefined);
    assert.equal(out.hasFullText, false);
  });
});

test('s2Search retries once after a 429 (sleeping on Retry-After, or 1s default)', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('{"message":"Too Many Requests","code":"429"}', {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as typeof fetch;

  try {
    const out = await s2Search('machine learning', 2);
    assert.equal(out.length, 2);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('s2Search throws with a clear HTTP message on a second consecutive 429', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(s2Search('x', 2), /HTTP 429/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('s2Search fails fast (no sleep, no retry) when Retry-After exceeds the cap', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 429, headers: { 'retry-after': '86400' } });
  }) as typeof fetch;

  const t0 = Date.now();
  try {
    await assert.rejects(
      s2Search('x', 2),
      /semanticscholar rate-limited; upstream asked to wait 86400s/,
    );
    assert.equal(calls, 1); // no retry attempted
    assert.ok(Date.now() - t0 < 500); // no 24h sleep leaked
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('s2Read carries externalIds.DOI through as doi', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(fixture.data[0]), { status: 200 })) as typeof fetch;
  try {
    const result = await s2Read('13c6de882218ba6c689ca5c035708b1b0e6f6b9c');
    assert.equal(result.title, 'Deep Learning');
    assert.equal(result.doi, fixture.data[0].externalIds.DOI);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
