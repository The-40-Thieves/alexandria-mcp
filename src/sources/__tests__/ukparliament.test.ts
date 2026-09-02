import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeUkParliament } from '../ukparliament.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/ukparliament-bills.json'), 'utf8'),
);

test('normalizeUkParliament', async (t) => {
  await t.test('maps a bill to a LibraryResult', () => {
    const out = normalizeUkParliament(fixture.items[0]);
    assert.equal(out.id, '970');
    assert.equal(out.source, 'ukparliament');
    assert.ok(out.title.includes('Banking'));
    assert.equal(out.description, 'Currently in the Commons');
    assert.equal(out.url, 'https://bills.parliament.uk/bills/970');
  });
});
