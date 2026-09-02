import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdapter } from '../registry.js';
import { sacredTextsSearch } from '../sacredtexts.js';
import '../sacredtexts.js';

test('sacredTextsSearch', async (t) => {
  await t.test('matches by title/author/subject/tradition', () => {
    const out = sacredTextsSearch('Rumi', 10);
    assert.ok(out.some((r) => r.id === 'masnavi-whinfield'));
  });

  await t.test('respects limit', () => {
    assert.equal(sacredTextsSearch('poetry', 1).length, 1);
  });

  await t.test('unknown query returns []', () => {
    assert.deepEqual(sacredTextsSearch('nonexistent-xyz', 10), []);
  });
});

test('sacredtexts read() is metadata-only (the live site 403s automated requests)', async () => {
  const out = await getAdapter('sacredtexts').read('tao-te-ching');
  assert.equal(out.metadataOnly, true);
  assert.equal(out.title, 'Tao Te Ching (Legge)');
  assert.match(out.note ?? '', /bot-gated/);
  assert.ok(out.externalUrl);
});

test('sacredtexts read() throws a clear error for an unknown id', async () => {
  await assert.rejects(
    getAdapter('sacredtexts').read('not-a-real-text'),
    /Unknown Sacred Texts ID/,
  );
});
