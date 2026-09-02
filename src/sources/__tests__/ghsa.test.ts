import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeGhsa } from '../ghsa.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/ghsa-search.json'), 'utf8'),
);

test('normalizeGhsa', async (t) => {
  await t.test('maps a GHSA advisory to a LibraryResult', () => {
    const out = normalizeGhsa(fixture[0]);
    assert.equal(out.id, 'GHSA-5hrf-vhf5-vjmc');
    assert.equal(out.source, 'ghsa');
    assert.ok(out.title.length > 0);
    assert.ok(out.description);
    assert.ok(typeof out.year === 'number');
    assert.ok(out.previewUrl?.startsWith('https://github.com/advisories/'));
  });
});
