import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeOsv, osvSearch } from '../osv.js';

function fixture(name: string) {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8'));
}

test('normalizeOsv', async (t) => {
  await t.test('maps an OSV vuln to a LibraryResult', () => {
    const vuln = fixture('osv-vuln.json');
    const out = normalizeOsv(vuln);
    assert.equal(out.id, 'GHSA-29mw-wpgm-hmr9');
    assert.equal(out.source, 'osv');
    assert.ok(out.title.length > 0);
    assert.ok(out.description && out.description.length > 0);
    assert.equal(out.year, 2025);
    assert.equal(out.previewUrl, 'https://osv.dev/vulnerability/GHSA-29mw-wpgm-hmr9');
  });
});

test('osvSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('does a direct GET lookup when the query is an advisory id', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(fixture('osv-vuln.json')), { status: 200 });
    }) as typeof fetch;
    const out = await osvSearch('GHSA-29mw-wpgm-hmr9', 5);
    assert.equal(calledUrl, 'https://api.osv.dev/v1/vulns/GHSA-29mw-wpgm-hmr9');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'GHSA-29mw-wpgm-hmr9');
  });

  await t.test('POSTs a package query when the query is ecosystem:name', async () => {
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      calledInit = init;
      return new Response(JSON.stringify(fixture('osv-query.json')), { status: 200 });
    }) as typeof fetch;
    const out = await osvSearch('npm:lodash', 5);
    assert.equal(calledInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calledInit?.body)), {
      package: { name: 'lodash', ecosystem: 'npm' },
    });
    assert.equal(out.length, 2);
  });

  await t.test('returns [] for a plain word with no ecosystem prefix and no id shape', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const out = await osvSearch('openssl', 5);
    assert.equal(out.length, 0);
    assert.equal(called, false);
  });
});
