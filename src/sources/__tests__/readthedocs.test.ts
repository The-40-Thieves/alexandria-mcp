import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { type DnsLookupAll, dnsResolver } from '../../web/fetchTier.ts';
import { normalizeReadthedocs, readthedocsRead, readthedocsSearch } from '../readthedocs.ts';
import { getAdapter } from '../registry.ts';

const searchFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/readthedocs-search.json'), 'utf8'),
);

const PAGE_HTML = `<!doctype html><html><head><title>Authentication</title></head><body><article><p>${'This document discusses using various kinds of authentication with Requests. '.repeat(10)}</p></article></body></html>`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizeReadthedocs', () => {
  const out = normalizeReadthedocs(searchFixture.results[0]);
  assert.equal(out.id, 'https://requests.readthedocs.io/en/latest/user/authentication/');
  assert.equal(out.source, 'readthedocs');
  assert.equal(out.title, 'Authentication');
  assert.deepEqual(out.subjects, ['requests']);
  assert.equal(out.hasFullText, true);
  assert.ok(!out.description?.includes('<span'));
  assert.match(out.description ?? '', /authentication/i);
});

test('readthedocsSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('sends q/page_size and maps results', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('q'), 'project:requests authentication');
      assert.equal(parsed.searchParams.get('page_size'), '2');
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    const out = await readthedocsSearch('project:requests authentication', 2);
    assert.equal(out.length, 2);
  });
});

test('readthedocsRead', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLookup = dnsResolver.lookup;
  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) satisfies DnsLookupAll;
  t.after(() => {
    globalThis.fetch = originalFetch;
    dnsResolver.lookup = originalLookup;
  });

  await t.test('fetches the doc page via the fetch tier', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), 'https://requests.readthedocs.io/en/latest/user/authentication/');
      return new Response(PAGE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch;
    const result = await readthedocsRead(
      'https://requests.readthedocs.io/en/latest/user/authentication/',
    );
    assert.equal(result.metadataOnly, undefined);
    assert.match(result.text ?? '', /various kinds of authentication/);
  });

  await t.test('degrades to metadata-only when the fetch fails', async () => {
    globalThis.fetch = (async () => new Response('error', { status: 500 })) as typeof fetch;
    const result = await readthedocsRead(
      'https://requests.readthedocs.io/en/latest/user/authentication/',
    );
    assert.equal(result.metadataOnly, true);
    assert.match(result.note ?? '', /Full-text fetch failed/);
  });
});

test('readthedocs adapter is registered', () => {
  assert.ok(getAdapter('readthedocs'));
});
