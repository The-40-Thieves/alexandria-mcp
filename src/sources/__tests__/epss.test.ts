import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { epssSearch, normalizeEpss } from '../epss.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/epss-score.json'), 'utf8'),
);

test('normalizeEpss', async (t) => {
  await t.test('maps an EPSS score to a LibraryResult', () => {
    const out = normalizeEpss(fixture.data[0]);
    assert.equal(out.id, 'CVE-2021-44228');
    assert.equal(out.source, 'epss');
    assert.equal(out.title, 'CVE-2021-44228 EPSS 0.999990000 percentile 1.000000000');
    assert.ok(out.description?.includes('0.999990000'));
  });
});

test('epssSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('fetches a score when the query is a CVE id', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch;
    const out = await epssSearch('CVE-2021-44228', 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'CVE-2021-44228');
  });

  await t.test('returns [] without calling fetch when the query is not a CVE id', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const out = await epssSearch('log4j', 5);
    assert.equal(out.length, 0);
    assert.equal(called, false);
  });
});
