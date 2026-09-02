import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { comtradeSearch, normalizeComtrade } from '../comtrade.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/comtrade-preview.json'), 'utf8'),
);

test('normalizeComtrade', async (t) => {
  await t.test('maps a preview row to a LibraryResult', () => {
    const out = normalizeComtrade(fixture.data[0]);
    assert.ok(out);
    assert.equal(out?.id, '68-152-0101-2024');
    assert.equal(out?.source, 'comtrade');
    assert.ok(out?.title.includes('HS 0101'));
    assert.equal(out?.year, 2024);
    assert.ok(out?.description?.includes('11072'));
  });

  await t.test('drops a row with no cmdCode', () => {
    assert.equal(normalizeComtrade({ period: '2024' }), null);
  });
});

test('comtradeSearch returns [] for a non-HS-code query', async (t) => {
  await t.test('a free-text query is not an HS code', async () => {
    assert.deepEqual(await comtradeSearch('electronics', 5), []);
  });
});
