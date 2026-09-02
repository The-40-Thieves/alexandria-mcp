import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeCensus } from '../census.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/census-catalog.json'), 'utf8'),
);

test('normalizeCensus', async (t) => {
  await t.test('maps a dataset entry to a LibraryResult', () => {
    const out = normalizeCensus(fixture.dataset[0]);
    assert.ok(out);
    assert.equal(out?.id, 'nonemp');
    assert.equal(out?.source, 'census');
    assert.ok(out?.title.includes('Nonemployer Statistics'));
    assert.equal(out?.year, 2017);
    assert.equal(out?.previewUrl, 'http://www.census.gov/developer/');
  });

  await t.test('drops a dataset with an empty c_dataset array', () => {
    assert.equal(normalizeCensus({ c_dataset: [], title: 'x' }), null);
  });
});
