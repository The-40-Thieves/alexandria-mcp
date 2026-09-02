import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeEpatri } from '../epatri.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/epatri-search.json'), 'utf8'),
);

test('normalizeEpatri', async (t) => {
  await t.test('maps a TRI facility to a LibraryResult', () => {
    const out = normalizeEpatri(fixture[0]);
    assert.ok(out);
    assert.equal(out?.id, '00701CYNMDPRROA');
    assert.equal(out?.source, 'epatri');
    assert.ok(out?.title.includes('BASF'));
    assert.equal(out?.description, 'MANATI, PR');
  });

  await t.test('drops an item with no tri_facility_id', () => {
    assert.equal(normalizeEpatri({ tri_facility_id: '', facility_name: 'x' }), null);
  });
});
