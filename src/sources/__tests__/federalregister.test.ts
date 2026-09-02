import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeFederalRegister } from '../federalregister.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/federalregister-documents.json'), 'utf8'),
);

test('normalizeFederalRegister', async (t) => {
  await t.test('maps a document to a LibraryResult', () => {
    const out = normalizeFederalRegister(fixture.results[0]);
    assert.equal(out.id, '2026-08979');
    assert.equal(out.source, 'federalregister');
    assert.equal(out.title, 'Privacy Act Regulations');
    assert.equal(out.year, 2026);
    assert.ok(out.description?.includes('Insider Risk Program'));
    assert.equal(
      out.url,
      'https://www.federalregister.gov/documents/2026/05/06/2026-08979/privacy-act-regulations',
    );
  });
});
