import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeCoingecko } from '../coingecko.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/coingecko-search.json'), 'utf8'),
);

test('normalizeCoingecko', async (t) => {
  await t.test('maps a search coin to a LibraryResult', () => {
    const out = normalizeCoingecko(fixture.coins[0]);
    assert.equal(out.id, 'bitcoin');
    assert.equal(out.source, 'coingecko');
    assert.equal(out.title, 'Bitcoin (BTC)');
    assert.equal(out.hasFullText, true);
  });
});
