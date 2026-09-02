import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeNdl } from '../ndl.js';

const xml = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/ndl-search-raw.xml'),
  'utf8',
);

test('normalizeNdl', async (t) => {
  await t.test('maps a dcndl (recordPacking=xml) SRU response', () => {
    const out = normalizeNdl(xml, 10);
    assert.equal(out.length, 1);
    const r = out[0];
    assert.equal(r.id, 'https://ndlsearch.ndl.go.jp/books/R000000004-I028622976');
    assert.equal(r.previewUrl, r.id);
    assert.match(r.title, /アーサー・ヘルプス/);
    assert.deepEqual(r.authors, ['長谷川 勝政']);
    assert.equal(r.year, 2017);
    assert.equal(r.language, 'jpn');
    assert.equal(r.hasFullText, false);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeNdl(xml, 0).length, 0);
  });

  await t.test('handles a response with no records', () => {
    assert.deepEqual(
      normalizeNdl('<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"></searchRetrieveResponse>', 10),
      [],
    );
  });
});
