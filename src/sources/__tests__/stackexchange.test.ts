import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeStackExchange } from '../stackexchange.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/stackexchange-search.json'), 'utf8'),
);

test('normalizeStackExchange', async (t) => {
  await t.test('maps a question to a LibraryResult, stripping HTML from the body', () => {
    const out = normalizeStackExchange(fixture.items[0]);
    assert.equal(out.id, '10175812');
    assert.equal(out.source, 'stackexchange');
    assert.ok(out.title.includes('self-signed SSL'));
    assert.ok(out.description);
    assert.ok(!out.description?.includes('<'));
    assert.equal(out.year, 2012);
    assert.ok(out.previewUrl?.startsWith('https://stackoverflow.com/questions/'));
  });
});
