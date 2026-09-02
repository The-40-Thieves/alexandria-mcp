import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { naraSearch, normalizeNara } from '../nara.js';

// Trimmed from NARA's own documented example response (see the
// "_source_note" field in the fixture): NARA_API_KEY is required to call
// this endpoint live and NARA offers no public demo key.
const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/nara-search.json'), 'utf8'),
);

test('normalizeNara', async (t) => {
  await t.test('maps body.hits.hits[]._source.record', () => {
    const out = normalizeNara(fixture, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '417180915');
    assert.equal(out[0].title, 'Tape 677, Conversation 010 (677-010)');
    assert.equal(out[0].year, 1972);
    assert.equal(out[0].hasFullText, true);
    assert.equal(out[0].previewUrl, 'https://catalog.archives.gov/id/417180915');
    assert.deepEqual(out[0].subjects, ['item', 'Sound Recordings']);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeNara(fixture, 0).length, 0);
  });

  await t.test('handles a response with no hits', () => {
    assert.deepEqual(normalizeNara({}, 10), []);
  });
});

test('naraSearch throws a clear "requires NARA_API_KEY" error when unconfigured', async () => {
  const saved = process.env.NARA_API_KEY;
  delete process.env.NARA_API_KEY;
  try {
    await assert.rejects(naraSearch('nixon', 5), /requires NARA_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.NARA_API_KEY = saved;
  }
});
