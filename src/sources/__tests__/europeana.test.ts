import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { europeanaSearch, normalizeEuropeana } from '../europeana.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/europeana-search.json'), 'utf8'),
);

test('normalizeEuropeana', async (t) => {
  await t.test('maps Europeana search.json items (recorded with the public api2demo key)', () => {
    const out = normalizeEuropeana(fixture, 10);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, '/2048441/item_ZWLIOSHYKPBTPNMN46QRDD5GJKJ4EU2L');
    assert.equal(out[0].title, 'Science');
    assert.deepEqual(out[0].authors, ['Ziche, Paul', 'Ziche, Paul', 'Ziche, Paul']);
    assert.equal(out[0].language, 'eng');
    assert.equal(out[0].hasFullText, false);
    assert.match(out[0].previewUrl ?? '', /^https:\/\/www\.europeana\.eu\/item\/2048441\//);
  });

  await t.test('parses a year when present', () => {
    const out = normalizeEuropeana(fixture, 10);
    assert.equal(out[2].year, 2007);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeEuropeana(fixture, 1).length, 1);
  });
});

test('europeanaSearch throws a clear "requires EUROPEANA_API_KEY" error when unconfigured', async () => {
  const saved = process.env.EUROPEANA_API_KEY;
  delete process.env.EUROPEANA_API_KEY;
  try {
    await assert.rejects(europeanaSearch('history', 5), /requires EUROPEANA_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.EUROPEANA_API_KEY = saved;
  }
});
