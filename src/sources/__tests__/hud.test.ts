import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeHud } from '../hud.ts';
import { getAdapter } from '../registry.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/hud-fmr.json'), 'utf8'),
);

test('normalizeHud', async (t) => {
  await t.test('maps FMR data to a LibraryResult', () => {
    const out = normalizeHud('75001', fixture);
    assert.ok(out);
    assert.equal(out?.id, '75001:2024');
    assert.equal(out?.source, 'hud');
    assert.ok(out?.title.includes('Addison'));
    assert.equal(out?.year, 2024);
    assert.equal(out?.description, '2BR FMR: $1560');
  });

  await t.test('returns null when there is no basicdata', () => {
    assert.equal(normalizeHud('75001', { data: {} }), null);
  });
});

test('hud requires HUD_API_TOKEN', async (t) => {
  const originalEnv = process.env.HUD_API_TOKEN;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.HUD_API_TOKEN;
    else process.env.HUD_API_TOKEN = originalEnv;
  });

  await t.test('throws "hud requires HUD_API_TOKEN" when the env is absent', async () => {
    delete process.env.HUD_API_TOKEN;
    await assert.rejects(
      () => getAdapter('hud').search('75001', 5),
      /^Error: hud requires HUD_API_TOKEN$/,
    );
  });
});
