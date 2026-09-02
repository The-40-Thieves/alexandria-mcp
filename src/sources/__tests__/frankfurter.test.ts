import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeFrankfurterCurrency, normalizeFrankfurterRates } from '../frankfurter.js';

const latest = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/frankfurter-latest.json'), 'utf8'),
);
const currencies = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/frankfurter-currencies.json'), 'utf8'),
);

test('normalizeFrankfurterRates', async (t) => {
  await t.test('maps a /latest response to a LibraryResult', () => {
    const out = normalizeFrankfurterRates(latest);
    assert.equal(out.id, 'USD:2026-09-01');
    assert.equal(out.source, 'frankfurter');
    assert.equal(out.title, 'USD rates 2026-09-01');
    assert.ok(out.description?.includes('EUR: 0.86281'));
    assert.equal(out.published, '2026-09-01');
  });
});

test('normalizeFrankfurterCurrency', async (t) => {
  await t.test('maps a currency code/name pair to a LibraryResult', () => {
    const out = normalizeFrankfurterCurrency('EUR', currencies.EUR);
    assert.equal(out.id, 'EUR');
    assert.equal(out.title, 'EUR: Euro');
    assert.equal(out.description, 'Euro');
  });
});
