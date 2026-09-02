import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeLoc } from '../loc.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/loc-search.json'), 'utf8'),
);

test('normalizeLoc', async (t) => {
  await t.test('maps loc.gov/search/ results', () => {
    const out = normalizeLoc(fixture, 10);
    assert.equal(out.length, 2);
    assert.equal(out[1].title, '[History of A Buffalo Hunter]');
    assert.deepEqual(out[1].authors, ['brown, lorin w.', 'tejada, simeon']);
    assert.equal(out[1].year, 1939);
    assert.equal(out[1].hasFullText, true);
  });

  await t.test('handles a null contributor/date', () => {
    const out = normalizeLoc(fixture, 10);
    assert.deepEqual(out[0].authors, []);
    assert.equal(out[0].year, undefined);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeLoc(fixture, 1).length, 1);
  });
});
