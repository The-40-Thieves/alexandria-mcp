import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeDbnomics } from '../dbnomics.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/dbnomics-search.json'), 'utf8'),
);

test('normalizeDbnomics', async (t) => {
  await t.test('maps a search doc to a LibraryResult', () => {
    const out = normalizeDbnomics(fixture.results.docs[0]);
    assert.equal(out.id, 'OECD/DSD_EAG_LSO_EA@DF_LSO_NEAC_ALL');
    assert.equal(out.source, 'dbnomics');
    assert.ok(out.title.includes('NEAC'));
    assert.equal(out.description, 'Organisation for Economic Co-operation and Development');
  });
});
