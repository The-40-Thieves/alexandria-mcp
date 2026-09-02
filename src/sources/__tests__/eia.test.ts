import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeEiaRoute, normalizeEiaSeries } from '../eia.ts';
import { getAdapter } from '../registry.ts';

const routes = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/eia-routes.json'), 'utf8'),
);
const series = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/eia-seriesid.json'), 'utf8'),
);

test('normalizeEiaRoute', async (t) => {
  await t.test('maps a route to a LibraryResult', () => {
    const out = normalizeEiaRoute(routes.response.routes[0]);
    assert.equal(out.id, 'coal');
    assert.equal(out.source, 'eia');
    assert.equal(out.title, 'Coal');
    assert.equal(out.description, 'EIA coal energy data');
  });
});

test('normalizeEiaSeries', async (t) => {
  await t.test('maps series data points to a single LibraryResult from the latest point', () => {
    const out = normalizeEiaSeries('PET.MCRFPUS2.M', series.response.data);
    assert.equal(out.id, 'PET.MCRFPUS2.M');
    assert.equal(out.source, 'eia');
    assert.ok(out.title.includes('Field Production of Crude Oil'));
    assert.ok(out.description?.includes('13792'));
    assert.equal(out.hasFullText, true);
  });
});

test('eia requires EIA_API_KEY', async (t) => {
  const originalEnv = process.env.EIA_API_KEY;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalEnv;
  });

  await t.test('throws "eia requires EIA_API_KEY" when the env is absent', async () => {
    delete process.env.EIA_API_KEY;
    await assert.rejects(
      () => getAdapter('eia').search('coal', 5),
      /^Error: eia requires EIA_API_KEY$/,
    );
  });
});
