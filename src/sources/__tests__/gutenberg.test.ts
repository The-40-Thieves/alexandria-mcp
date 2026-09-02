import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeGutenberg } from '../gutenberg.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/gutenberg-search.json'), 'utf8'),
);

test('normalizeGutenberg', async (t) => {
  await t.test('maps gutendex.com/books/ results (trailing slash, page_size)', () => {
    const out = normalizeGutenberg(fixture);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '84');
    assert.equal(out[0].title, 'Frankenstein; or, the modern prometheus');
    assert.deepEqual(out[0].authors, ['Shelley, Mary Wollstonecraft']);
    assert.equal(out[0].hasFullText, true);
    assert.ok(out[0].downloadUrl);
  });
});
