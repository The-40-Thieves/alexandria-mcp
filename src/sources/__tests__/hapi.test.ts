import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeHapiConflictEvent, normalizeHapiLocation, resolveIso3 } from '../hapi.js';
import { getAdapter } from '../registry.js';

const events = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/hapi-conflict-events.json'), 'utf8'),
);
const locations = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/hapi-location.json'), 'utf8'),
);

test('resolveIso3', async (t) => {
  await t.test('resolves a country name to its ISO3 code', () => {
    assert.equal(resolveIso3('Ukraine'), 'UKR');
    assert.equal(resolveIso3('united states'), 'USA');
  });
  await t.test('is case-insensitive and trims whitespace', () => {
    assert.equal(resolveIso3('  UKRAINE  '), 'UKR');
  });
  await t.test('returns undefined for a non-country query', () => {
    assert.equal(resolveIso3('drought risk'), undefined);
  });
});

test('normalizeHapiConflictEvent', async (t) => {
  await t.test('maps a conflict-events row to a LibraryResult', () => {
    const out = normalizeHapiConflictEvent(events.data[0]);
    assert.ok(out);
    assert.equal(out?.source, 'hapi');
    assert.ok(out?.title.includes('Ukraine'));
    assert.ok(out?.description?.includes('142 events'));
    assert.equal(out?.year, 2026);
  });
});

test('normalizeHapiLocation', async (t) => {
  await t.test('maps a location row to a LibraryResult', () => {
    const out = normalizeHapiLocation(locations.data[0]);
    assert.ok(out);
    assert.equal(out?.id, 'UKR');
    assert.equal(out?.title, 'Ukraine');
  });
});

test('hapi requires HDX_APP_IDENTIFIER', async (t) => {
  const originalEnv = process.env.HDX_APP_IDENTIFIER;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.HDX_APP_IDENTIFIER;
    else process.env.HDX_APP_IDENTIFIER = originalEnv;
  });

  await t.test('throws "hapi requires HDX_APP_IDENTIFIER" when the env is absent', async () => {
    delete process.env.HDX_APP_IDENTIFIER;
    await assert.rejects(
      () => getAdapter('hapi').search('Ukraine', 5),
      /^Error: hapi requires HDX_APP_IDENTIFIER$/,
    );
  });
});
