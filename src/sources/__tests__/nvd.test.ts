import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeNvd } from '../nvd.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/nvd-search.json'), 'utf8'),
);

test('normalizeNvd', async (t) => {
  await t.test('maps an NVD vulnerabilities[] entry to a LibraryResult', () => {
    const out = normalizeNvd(fixture.vulnerabilities[0]);
    assert.equal(out.id, 'CVE-1999-0428');
    assert.equal(out.source, 'nvd');
    assert.ok(out.title.startsWith('CVE-1999-0428:'));
    assert.ok(out.description?.includes('OpenSSL'));
    assert.equal(out.year, 1999);
    assert.equal(out.previewUrl, 'https://nvd.nist.gov/vuln/detail/CVE-1999-0428');
  });
});
