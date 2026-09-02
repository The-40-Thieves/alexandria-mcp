import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeOpenFda } from '../openfda.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/openfda-enforcement.json'), 'utf8'),
);

test('normalizeOpenFda', async (t) => {
  await t.test('maps a recall result to a LibraryResult', () => {
    const out = normalizeOpenFda(fixture.results[0]);
    assert.ok(out);
    assert.equal(out?.id, 'D-0277-2026');
    assert.equal(out?.source, 'openfda');
    assert.ok(out?.title.includes('TYLENOL'));
    assert.equal(out?.year, 2026);
    assert.ok(out?.description?.includes('CGMP Deviations'));
    assert.equal(out?.published, '20260121');
  });

  await t.test('drops a result with no recall_number', () => {
    assert.equal(normalizeOpenFda({ recall_number: '' }), null);
  });
});
