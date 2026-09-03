import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { type DnsLookupAll, dnsResolver } from '../../web/fetchTier.ts';
import { getAdapter } from '../registry.ts';
import { normalizeSecHit, secedgarRead, secedgarSearch } from '../secedgar.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/secedgar-search.json'), 'utf8'),
);

const FILING_HTML = `<!doctype html><html><head><title>10-K Filing</title></head><body><article><p>${'Risk factors and financial disclosures. '.repeat(20)}</p></article></body></html>`;

test('normalizeSecHit', () => {
  const out = normalizeSecHit(fixture.hits.hits[1]);
  assert.ok(out);
  assert.equal(out?.source, 'secedgar');
  assert.match(out?.title ?? '', /CARNIVAL CORP/);
  assert.equal(out?.year, 2023);
  assert.equal(
    out?.previewUrl,
    'https://www.sec.gov/Archives/edgar/data/815097/000081509723000012/ccl-20221130.htm',
  );
  // id round-trips through decodeId (exercised via secedgarRead below).
  assert.equal(out?.id, '815097::000081509723000012::ccl-20221130.htm');
});

test('secedgarSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.CONTACT_EMAIL;
  process.env.CONTACT_EMAIL = 'test@example.org';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.CONTACT_EMAIL;
    else process.env.CONTACT_EMAIL = originalEnv;
  });

  await t.test('sends the required identifying User-Agent', async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      assert.match(headers['User-Agent'], /test@example\.org/);
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await secedgarSearch('climate risk', 2);
    assert.equal(out.length, 2);
  });

  await t.test('throws "secedgar requires CONTACT_EMAIL" when unset', async () => {
    delete process.env.CONTACT_EMAIL;
    await assert.rejects(
      () => secedgarSearch('climate risk', 2),
      /^Error: secedgar requires CONTACT_EMAIL$/,
    );
  });
});

test('secedgarRead', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dnsResolver.lookup;
  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) satisfies DnsLookupAll;
  t.after(() => {
    globalThis.fetch = originalFetch;
    dnsResolver.lookup = originalLookup;
  });

  await t.test('fetches the filing document via the fetch tier', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(
        String(url),
        'https://www.sec.gov/Archives/edgar/data/815097/000081509723000012/ccl-20221130.htm',
      );
      return new Response(FILING_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch;
    const result = await secedgarRead('815097::000081509723000012::ccl-20221130.htm');
    assert.equal(result.metadataOnly, undefined);
    assert.match(result.text ?? '', /Risk factors and financial disclosures/);
  });

  await t.test('degrades to metadata-only when the fetch fails', async () => {
    globalThis.fetch = (async () => new Response('error', { status: 500 })) as typeof fetch;
    const result = await secedgarRead('815097::000081509723000012::ccl-20221130.htm');
    assert.equal(result.metadataOnly, true);
    assert.match(result.note ?? '', /Full-text fetch failed/);
  });
});

test('secedgar adapter is registered', () => {
  assert.ok(getAdapter('secedgar'));
});
