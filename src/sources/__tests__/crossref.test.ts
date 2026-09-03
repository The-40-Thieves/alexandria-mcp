import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { crossrefRead, crossrefSearch, normalizeCrossref } from '../crossref.ts';
import { getAdapter } from '../registry.ts';

const searchFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/crossref-search.json'), 'utf8'),
);
const workFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/crossref-work.json'), 'utf8'),
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizeCrossref', () => {
  const out = normalizeCrossref(searchFixture.message.items[0]);
  assert.equal(out.id, '10.62311/nesx/68113');
  assert.equal(out.source, 'crossref');
  assert.equal(
    out.title,
    'The CRISPR Code: Gene Editing, Biotechnology, and the Future of Humanity',
  );
  assert.deepEqual(out.authors, ['Murali Krishna Pasupuleti']);
  assert.equal(out.year, 2025);
  // The JATS <jats:p> wrapper is stripped from the abstract.
  assert.ok(!out.description?.includes('<jats:p>'));
  assert.match(out.description ?? '', /CRISPR revolution/);
});

test('crossrefSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.CONTACT_EMAIL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.CONTACT_EMAIL;
    else process.env.CONTACT_EMAIL = originalEnv;
  });

  await t.test('includes mailto when CONTACT_EMAIL is set', async () => {
    process.env.CONTACT_EMAIL = 'test@example.org';
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('mailto'), 'test@example.org');
      assert.equal(parsed.searchParams.get('rows'), '5');
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    const out = await crossrefSearch('CRISPR gene editing', 5);
    assert.equal(out.length, 2);
  });

  await t.test('omits mailto entirely when CONTACT_EMAIL is unset', async () => {
    delete process.env.CONTACT_EMAIL;
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.has('mailto'), false);
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    await crossrefSearch('CRISPR', 5);
  });
});

test('crossrefRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('combines metadata, references, and BibTeX', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.crossref.org/works/')) return jsonResponse(workFixture);
      if (url.startsWith('https://doi.org/')) {
        assert.equal(
          (init?.headers as Record<string, string> | undefined)?.Accept,
          'application/x-bibtex',
        );
        return new Response('@article{Kucsko_2013, title={Nanometre-scale thermometry}}', {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await crossrefRead('10.1038/nature12373');
    assert.equal(result.title, 'Nanometre-scale thermometry in a living cell');
    assert.equal(result.year, 2013);
    assert.match(result.text, /References \(30\)/);
    assert.match(result.text, /BibTeX:/);
    assert.match(result.text, /@article/);
    assert.equal(result.doi, '10.1038/nature12373');
  });

  await t.test('still returns metadata when the BibTeX fetch fails', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.crossref.org/works/')) return jsonResponse(workFixture);
      if (url.startsWith('https://doi.org/')) return new Response('error', { status: 500 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await crossrefRead('10.1038/nature12373');
    assert.equal(result.title, 'Nanometre-scale thermometry in a living cell');
    assert.ok(!result.text.includes('BibTeX:'));
  });

  await t.test('propagates a not-found error', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    await assert.rejects(() => crossrefRead('10.0000/nonexistent'), /HTTP 404/);
  });
});

test('crossref adapter is registered', () => {
  assert.ok(getAdapter('crossref'));
});
