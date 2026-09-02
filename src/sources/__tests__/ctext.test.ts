import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeCtextSearch } from '../ctext.js';

function fixture(name: string) {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}.json`), 'utf8'));
}

test('normalizeCtextSearch', async (t) => {
  const search = fixture('ctext-search');

  await t.test('maps api.ctext.org books[] to ctp: URN ids', () => {
    const out = normalizeCtextSearch(search, 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'ctp:analects');
    assert.equal(out[0].title, '論語');
    assert.equal(out[0].language, 'zh');
    assert.equal(out[0].previewUrl, 'https://ctext.org/analects');
    assert.equal(out[0].hasFullText, true);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeCtextSearch(search, 0).length, 0);
  });

  await t.test('handles an empty response', () => {
    assert.deepEqual(normalizeCtextSearch({}, 10), []);
  });
});

test('ctext gettextinfo/gettext live shapes (recorded 2026-09-01)', async (t) => {
  await t.test('gettextinfo for a top-level urn carries no chapter list', () => {
    const info = fixture('ctext-info');
    assert.equal(info.topurn, 'ctp:analects');
    assert.equal('chapters' in info, false);
    assert.equal('books' in info, false);
  });

  await t.test('gettext without auth returns an ERR_REQUIRES_AUTHENTICATION error body', () => {
    const err = fixture('ctext-gettext-error');
    assert.equal(err.error.code, 'ERR_REQUIRES_AUTHENTICATION');
  });
});
