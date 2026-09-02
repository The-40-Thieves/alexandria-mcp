import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getAdapter } from '../registry.js';
import { normalizeRentcast } from '../rentcast.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/rentcast-market.json'), 'utf8'),
);

test('normalizeRentcast', async (t) => {
  await t.test('maps a market response to a LibraryResult', () => {
    const out = normalizeRentcast(fixture);
    assert.ok(out);
    assert.equal(out?.id, '75001');
    assert.equal(out?.source, 'rentcast');
    assert.ok(out?.description?.includes('1875'));
  });

  await t.test('drops a response with no zipCode', () => {
    assert.equal(normalizeRentcast({ zipCode: '' }), null);
  });
});

test('rentcast requires RENTCAST_API_KEY', async (t) => {
  const originalEnv = process.env.RENTCAST_API_KEY;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.RENTCAST_API_KEY;
    else process.env.RENTCAST_API_KEY = originalEnv;
  });

  await t.test('throws "rentcast requires RENTCAST_API_KEY" when the env is absent', async () => {
    delete process.env.RENTCAST_API_KEY;
    await assert.rejects(
      () => getAdapter('rentcast').search('75001', 5),
      /^Error: rentcast requires RENTCAST_API_KEY$/,
    );
  });
});
