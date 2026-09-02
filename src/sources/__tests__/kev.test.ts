import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeKev } from '../kev.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/kev-catalog.json'), 'utf8'),
);

test('normalizeKev', async (t) => {
  await t.test('maps a KEV catalog entry to a LibraryResult', () => {
    const out = normalizeKev(fixture.vulnerabilities[0]);
    assert.equal(out.id, 'CVE-2026-82078');
    assert.equal(out.source, 'kev');
    assert.equal(out.title, 'PaperCut NG/MF Unsafe Reflection Vulnerability');
    assert.ok(out.description);
    assert.equal(out.previewUrl, 'https://nvd.nist.gov/vuln/detail/CVE-2026-82078');
  });
});
