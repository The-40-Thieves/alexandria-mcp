import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeDataGov } from '../datagov.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/datagov-search.json'), 'utf8'),
);

test('normalizeDataGov', async (t) => {
  await t.test('maps catalog.data.gov results', () => {
    const out = normalizeDataGov(fixture, 10);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'nyc-climate-budgeting-report-climate-alignment-assessment-and-capital-climate-investments');
    assert.equal(out[0].hasFullText, false);
    assert.equal(out[0].year, 2025);
    assert.equal(out[0].previewUrl, 'https://data.cityofnewyork.us/d/c99a-c5ux');
    assert.deepEqual(out[0].authors, ['data.cityofnewyork.us']);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeDataGov(fixture, 1).length, 1);
  });

  await t.test('handles both results and hits keys', () => {
    assert.equal(normalizeDataGov({ hits: fixture.results }, 10).length, 3);
    assert.deepEqual(normalizeDataGov({}, 10), []);
  });
});
