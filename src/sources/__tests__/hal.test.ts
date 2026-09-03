import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeHal } from '../hal.ts';
import { getAdapter } from '../registry.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8'));
}

const searchFixture = fixture('hal-search.json') as { response: { docs: unknown[] } };
const docFixture = fixture('hal-doc.json') as { response: { docs: unknown[] } };

type HalDoc = Parameters<typeof normalizeHal>[0];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizeHal', () => {
  const out = normalizeHal(searchFixture.response.docs[0] as HalDoc);
  assert.equal(out.id, 'hal-04987097');
  assert.equal(out.source, 'hal');
  assert.match(out.title, /Advancing Cybersecurity/);
  assert.deepEqual(out.authors, ['Redeer Avdal Saleh', 'Hajar Maseeh Yasin']);
  assert.equal(out.year, 2025);
  assert.equal(out.hasFullText, true);
  assert.equal(out.downloadUrl, 'https://hal.science/hal-04987097/document');
  assert.equal(out.previewUrl, 'https://hal.science/hal-04987097v1');
  assert.match(out.description ?? '', /machine learning/i);
});

test('hal adapter', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('search() builds the Solr query URL and maps results', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('q'), 'machine learning');
      assert.equal(parsed.searchParams.get('rows'), '5');
      assert.equal(parsed.searchParams.get('wt'), 'json');
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    const out = await getAdapter('hal').search('machine learning', 5);
    assert.equal(out.length, 2);
  });

  await t.test('read() looks a record up by halId and returns the abstract', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.match(String(url), /q=halId_s:hal-04987097/);
      return jsonResponse(docFixture);
    }) as typeof fetch;
    const result = await getAdapter('hal').read('hal-04987097');
    assert.match(result.title, /Advancing Cybersecurity/);
    assert.match(result.text ?? '', /machine learning \(ML\)/);
  });

  await t.test('read() throws for a missing record', async () => {
    globalThis.fetch = (async () => jsonResponse({ response: { docs: [] } })) as typeof fetch;
    await assert.rejects(() => getAdapter('hal').read('hal-nonexistent'), /HAL record not found/);
  });
});

test('hal adapter is registered', () => {
  assert.ok(getAdapter('hal'));
});
