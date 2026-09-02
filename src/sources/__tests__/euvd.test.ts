import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeEuvd } from '../euvd.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/euvd-search.json'), 'utf8'),
);

test('normalizeEuvd', async (t) => {
  await t.test('maps an EUVD item to a LibraryResult', () => {
    const out = normalizeEuvd(fixture.items[0]);
    assert.ok(out);
    assert.equal(out?.id, 'EUVD-2026-46255');
    assert.equal(out?.source, 'euvd');
    assert.ok(out?.title.startsWith('EUVD-2026-46255:'));
    assert.ok(out?.description?.includes('libssh'));
    assert.equal(out?.year, 2026);
    assert.equal(out?.previewUrl, 'https://euvd.enisa.europa.eu/vulnerability/EUVD-2026-46255');
  });

  await t.test('drops an item with no id', () => {
    assert.equal(normalizeEuvd({ id: '' }), null);
  });
});
