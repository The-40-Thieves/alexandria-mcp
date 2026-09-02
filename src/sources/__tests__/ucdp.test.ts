import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeUcdp } from '../ucdp.js';
import { getAdapter } from '../registry.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/ucdp-gedevents.json'), 'utf8'),
);

test('normalizeUcdp', async (t) => {
  await t.test('maps a GED event to a LibraryResult', () => {
    const out = normalizeUcdp(fixture.Result[0]);
    assert.equal(out.id, '512345');
    assert.equal(out.source, 'ucdp');
    assert.ok(out.title.includes('State-based violence'));
    assert.ok(out.title.includes('Government of Ukraine vs Government of Russia'));
    assert.equal(out.year, 2026);
    assert.ok(out.description?.includes('Ukraine'));
  });
});

test('ucdp requires UCDP_TOKEN', async (t) => {
  const originalEnv = process.env.UCDP_TOKEN;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.UCDP_TOKEN;
    else process.env.UCDP_TOKEN = originalEnv;
  });

  await t.test('throws "ucdp requires UCDP_TOKEN" when the env is absent', async () => {
    delete process.env.UCDP_TOKEN;
    await assert.rejects(
      () => getAdapter('ucdp').search('Ukraine', 5),
      /^Error: ucdp requires UCDP_TOKEN$/,
    );
  });
});
