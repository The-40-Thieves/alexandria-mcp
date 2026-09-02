import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeMdn } from '../mdn.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/mdn-search.json'), 'utf8'),
);

test('normalizeMdn', async (t) => {
  await t.test('maps a search document to a LibraryResult with an absolute URL', () => {
    const out = normalizeMdn(fixture.documents[0]);
    assert.equal(out.id, '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array');
    assert.equal(out.source, 'mdn');
    assert.equal(out.title, 'Array');
    assert.ok(out.description?.includes('Array object'));
    assert.equal(
      out.url,
      'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
    );
  });
});
