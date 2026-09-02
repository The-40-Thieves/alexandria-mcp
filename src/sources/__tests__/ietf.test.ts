import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeIetf } from '../ietf.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/ietf-search.json'), 'utf8'),
);

test('normalizeIetf', async (t) => {
  await t.test('maps an RFC document to a LibraryResult', () => {
    const out = normalizeIetf(fixture.objects[0]);
    assert.equal(out.id, 'rfc9147');
    assert.equal(out.source, 'ietf');
    assert.ok(out.title.includes('Datagram Transport Layer Security'));
    assert.equal(out.year, 2026);
    assert.equal(out.previewUrl, 'https://www.rfc-editor.org/rfc/rfc9147');
  });
});
