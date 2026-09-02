import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeFred } from '../fred.js';
import { getAdapter } from '../registry.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/fred-search.json'), 'utf8'),
);

test('normalizeFred', async (t) => {
  await t.test('maps a series to a LibraryResult', () => {
    const out = normalizeFred(fixture.seriess[0]);
    assert.equal(out.id, 'UNRATE');
    assert.equal(out.source, 'fred');
    assert.equal(out.title, 'Unemployment Rate');
    assert.equal(out.year, 2026);
    assert.ok(out.description?.includes('unemployed'));
  });
});

test('fred requires FRED_API_KEY', async (t) => {
  const originalEnv = process.env.FRED_API_KEY;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.FRED_API_KEY;
    else process.env.FRED_API_KEY = originalEnv;
  });

  await t.test('throws "fred requires FRED_API_KEY" when the env is absent', async () => {
    delete process.env.FRED_API_KEY;
    await assert.rejects(
      () => getAdapter('fred').search('unemployment', 5),
      /^Error: fred requires FRED_API_KEY$/,
    );
  });
});
