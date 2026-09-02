import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeChroniclingAmerica } from '../chroniclingamerica.ts';

// Tests always run from the repo root (npm test / npx tsx --test), so a
// cwd-relative path avoids import.meta (invalid once tsc emits CommonJS,
// since this package.json has no "type": "module").
const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/chroniclingamerica-search.json'), 'utf8'),
);

test('normalizeChroniclingAmerica', async (t) => {
  await t.test('maps results from the loc.gov collections API', () => {
    const out = normalizeChroniclingAmerica(fixture, 10);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'http://www.loc.gov/resource/sn96075050/1917-09-06/ed-1/?sp=8');
    assert.equal(out[0].previewUrl, out[0].id);
    assert.equal(out[0].url, out[0].id);
    assert.equal(out[0].year, 1917);
    assert.equal(out[0].hasFullText, true);
    assert.match(out[0].title, /independent-reporter/);
  });

  await t.test('respects limit', () => {
    const out = normalizeChroniclingAmerica(fixture, 1);
    assert.equal(out.length, 1);
  });

  await t.test('handles a missing results array', () => {
    assert.deepEqual(normalizeChroniclingAmerica({}, 10), []);
  });
});
