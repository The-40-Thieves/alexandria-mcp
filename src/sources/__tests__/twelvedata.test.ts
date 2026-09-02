import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getAdapter } from '../registry.js';
import { normalizeTwelveData } from '../twelvedata.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/twelvedata-search.json'), 'utf8'),
);

test('normalizeTwelveData', async (t) => {
  await t.test('maps a symbol_search item to a LibraryResult', () => {
    const out = normalizeTwelveData(fixture.data[0]);
    assert.ok(out);
    assert.equal(out?.id, 'AAPL:NASDAQ');
    assert.equal(out?.source, 'twelvedata');
    assert.equal(out?.title, 'Apple Inc.');
    assert.equal(out?.description, 'United States');
    assert.equal(out?.hasFullText, true);
  });

  await t.test('drops an item with no symbol', () => {
    assert.equal(normalizeTwelveData({ symbol: '', instrument_name: 'x' }), null);
  });
});

test('twelvedata requires TWELVEDATA_API_KEY', async (t) => {
  const originalEnv = process.env.TWELVEDATA_API_KEY;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.TWELVEDATA_API_KEY;
    else process.env.TWELVEDATA_API_KEY = originalEnv;
  });

  await t.test(
    'throws "twelvedata requires TWELVEDATA_API_KEY" when the env is absent',
    async () => {
      delete process.env.TWELVEDATA_API_KEY;
      await assert.rejects(
        () => getAdapter('twelvedata').search('AAPL', 5),
        /^Error: twelvedata requires TWELVEDATA_API_KEY$/,
      );
    },
  );
});
