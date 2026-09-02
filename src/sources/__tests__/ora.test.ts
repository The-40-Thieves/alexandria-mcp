import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeOra, oraRead } from '../ora.js';

function fixture(name: string) {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}.json`), 'utf8'),
  );
}

test('normalizeOra', async (t) => {
  const search = fixture('ora-search');

  await t.test('maps ora.ox.ac.uk objects.json (JSON:API document_value wrappers)', () => {
    const out = normalizeOra(search, 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'uuid:8e985971-f0d9-4a7e-8be1-70a9c531dc52');
    assert.equal(out[0].title, 'Exploring science capital with primary-school-aged children');
    assert.deepEqual(out[0].authors, ['Milarski, MR']);
    assert.equal(out[0].year, 2021);
    assert.equal(
      out[0].previewUrl,
      'https://ora.ox.ac.uk/objects/uuid:8e985971-f0d9-4a7e-8be1-70a9c531dc52',
    );
  });

  await t.test('handles a null document_value (missing rights_copyright_date)', () => {
    const out = normalizeOra(search, 10);
    assert.equal(out[1].year, undefined);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeOra(search, 1).length, 1);
  });
});

test('oraRead pulls title/abstract from the single-object JSON', async () => {
  // oraRead calls fetchJSON internally; exercise it via the recorded fixture
  // by monkeypatching global fetch for this one call.
  const readFixture = fixture('ora-read');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(readFixture), { status: 200 })) as typeof fetch;
  try {
    const out = await oraRead('uuid:8e985971-f0d9-4a7e-8be1-70a9c531dc52');
    assert.equal(out.title, 'Exploring science capital with primary-school-aged children');
    assert.match(out.text, /science capital/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
