import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeNasa } from '../nasa.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/nasa-search.json'), 'utf8'),
);

test('normalizeNasa', async (t) => {
  await t.test('maps NTRS citations/search results[]', () => {
    const out = normalizeNasa(fixture);
    assert.ok(out.length >= 1);
    assert.equal(out[0].id, '20070034695');
    assert.equal(out[0].title, 'Cassini-Huygens Mars Exploration Rover');
    assert.deepEqual(out[0].authors, ['Liepack, Otfrid G.']);
    assert.deepEqual(out[0].subjects, ['Cassini', 'Mars Exploration Rover (MER)']);
    assert.equal(out[0].hasFullText, true);
  });
});
