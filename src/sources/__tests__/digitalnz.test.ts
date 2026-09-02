import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeDigitalNz } from '../digitalnz.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/digitalnz-search.json'), 'utf8'),
);

test('normalizeDigitalNz', async (t) => {
  await t.test('maps api.digitalnz.org/v3/records.json results.search.results[]', () => {
    const out = normalizeDigitalNz(fixture, 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '35199013');
    assert.match(out[0].title, /Science : assessment results/);
    assert.equal(out[0].year, 2004);
    assert.equal(out[0].language, 'eng');
    assert.equal(out[0].previewUrl, 'http://natlib.govt.nz/records/35199013');
    assert.equal(out[0].hasFullText, false);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeDigitalNz(fixture, 1).length, 1);
  });

  await t.test('handles a response with no search.results', () => {
    assert.deepEqual(normalizeDigitalNz({}, 10), []);
  });
});
