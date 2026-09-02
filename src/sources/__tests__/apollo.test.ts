import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeApollo } from '../apollo.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/apollo-search.json'), 'utf8'),
);

test('normalizeApollo', async (t) => {
  await t.test('maps DSpace REST v7 discover/search/objects results', () => {
    const out = normalizeApollo(fixture);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '371d02a7-cc06-40e0-bac7-c7cc5a026391');
    assert.equal(out[0].title, 'Problems and Solutions in Scientific Text');
    assert.deepEqual(out[0].authors, ['Heffernan, K', 'Teufel, Simone']);
    assert.equal(out[0].previewUrl, 'https://www.repository.cam.ac.uk/handle/1810/275065');
    assert.deepEqual(out[0].subjects, ['data']);
  });

  await t.test('handles a response with no embedded objects', () => {
    assert.deepEqual(normalizeApollo({}), []);
  });
});
