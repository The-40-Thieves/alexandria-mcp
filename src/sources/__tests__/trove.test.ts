import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { recordFullTextRead, resetFullTextWindow, troveRead } from '../trove.ts';

function fixture(name: string) {
  return readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}.json`), 'utf8');
}

test('trove full-text cap', async (t) => {
  await t.test('allows reads up to the cap and rejects the next one', () => {
    const t0 = 1_000_000;
    resetFullTextWindow(t0);
    for (let i = 1; i <= 25; i++) assert.equal(recordFullTextRead(t0 + i), i);
    assert.throws(() => recordFullTextRead(t0 + 26), /cap reached \(25 per session\)/);
  });

  await t.test('resets after the 24-hour window', () => {
    const t0 = 2_000_000;
    resetFullTextWindow(t0);
    for (let i = 1; i <= 25; i++) recordFullTextRead(t0 + i);
    assert.throws(() => recordFullTextRead(t0 + 30));
    assert.equal(recordFullTextRead(t0 + 24 * 60 * 60 * 1000 + 1), 1);
  });
});

test('troveRead', async (t) => {
  await t.test(
    'without TROVE_API_KEY, returns the pre-Stage-2 metadata-only shape with no network calls',
    async () => {
      const saved = process.env.TROVE_API_KEY;
      delete process.env.TROVE_API_KEY;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error('troveRead must not call fetch when TROVE_API_KEY is unset');
      }) as typeof fetch;
      try {
        const out = await troveRead('151678302');
        assert.equal(out.metadataOnly, true);
        assert.equal(out.title, '151678302');
        assert.equal(out.externalUrl, 'https://trove.nla.gov.au/work/151678302');
      } finally {
        globalThis.fetch = originalFetch;
        if (saved !== undefined) process.env.TROVE_API_KEY = saved;
      }
    },
  );

  await t.test(
    'with a key, follows a fulltext newspaper link and returns article text',
    async () => {
      const saved = process.env.TROVE_API_KEY;
      process.env.TROVE_API_KEY = 'test-key';
      resetFullTextWindow();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/work/151678302'))
          return new Response(fixture('trove-work'), { status: 200 });
        if (u.includes('/newspaper/18341291'))
          return new Response(fixture('trove-newspaper-article'), { status: 200 });
        throw new Error(`unexpected fetch: ${u}`);
      }) as typeof fetch;

      try {
        const out = await troveRead('151678302');
        assert.equal(out.metadataOnly, undefined);
        assert.equal(out.title, 'SHIPPING INTELLIGENCE.');
        assert.match(out.text ?? '', /Lying in Owen's Anchorage/);
        assert.equal(out.externalUrl, 'https://trove.nla.gov.au/newspaper/article/18341291');
      } finally {
        globalThis.fetch = originalFetch;
        if (saved !== undefined) process.env.TROVE_API_KEY = saved;
        else delete process.env.TROVE_API_KEY;
      }
    },
  );

  await t.test(
    'with a key, falls back to metadata-only when the work has no fulltext link',
    async () => {
      const saved = process.env.TROVE_API_KEY;
      process.env.TROVE_API_KEY = 'test-key';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ work: { id: 'x', title: 'No Links Here' } }), {
          status: 200,
        })) as typeof fetch;

      try {
        const out = await troveRead('x');
        assert.equal(out.metadataOnly, true);
        assert.equal(out.title, 'No Links Here');
      } finally {
        globalThis.fetch = originalFetch;
        if (saved !== undefined) process.env.TROVE_API_KEY = saved;
        else delete process.env.TROVE_API_KEY;
      }
    },
  );
});
