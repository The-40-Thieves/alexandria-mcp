import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeNhk } from '../nhk.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/nhk-search.json'), 'utf8'),
);

test('normalizeNhk', async (t) => {
  await t.test('maps data[] items with an absolute URL and ISO published date', () => {
    const out = normalizeNhk(fixture);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'https://www3.nhk.or.jp/nhkworld/en/news/20260902_N03/');
    assert.equal(out[0].url, 'https://www3.nhk.or.jp/nhkworld/en/news/20260902_N03/');
    assert.equal(out[0].title, 'US announces new military strikes on Iran');
    assert.equal(out[0].source, 'nhk');
    assert.equal(out[0].hasFullText, false);
    assert.equal(out[0].published, new Date(1788311064000).toISOString());
  });
});
