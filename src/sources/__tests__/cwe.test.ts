import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cweSearch, normalizeCwe } from '../cwe.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/cwe-weakness.json'), 'utf8'),
);

test('normalizeCwe', async (t) => {
  await t.test('maps a CWE weakness to a LibraryResult', () => {
    const out = normalizeCwe(fixture.Weaknesses[0]);
    assert.equal(out.id, 'CWE-79');
    assert.equal(out.source, 'cwe');
    assert.ok(out.title.includes('Cross-site Scripting'));
    assert.ok(out.description?.includes('neutralize'));
    assert.equal(out.previewUrl, 'https://cwe.mitre.org/data/definitions/79.html');
  });
});

test('cweSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('fetches a weakness for a bare number or CWE-prefixed id', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await cweSearch('CWE-79', 5);
    assert.equal(calledUrl, 'https://cwe-api.mitre.org/api/v1/cwe/weakness/79');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'CWE-79');
  });

  await t.test('returns [] without calling fetch for a non-numeric query', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const out = await cweSearch('cross-site scripting', 5);
    assert.equal(out.length, 0);
    assert.equal(called, false);
  });
});
