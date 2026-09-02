import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeCircl } from '../circl.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/circl-search.json'), 'utf8'),
);

test('normalizeCircl', async (t) => {
  await t.test('maps a CIRCL fulltext item to a LibraryResult', () => {
    const out = normalizeCircl(fixture.data[0]);
    assert.ok(out);
    assert.equal(out?.id, 'CVE-2011-4121');
    assert.equal(out?.source, 'circl');
    assert.ok(out?.title.startsWith('CVE-2011-4121:'));
    assert.ok(out?.description?.includes('OpenSSL extension of Ruby'));
    assert.equal(out?.year, 2019);
    assert.equal(out?.previewUrl, 'https://vulnerability.circl.lu/vuln/CVE-2011-4121');
    assert.equal(out?.hasFullText, true);
  });

  await t.test('drops an item with no cveMetadata.cveId', () => {
    const out = normalizeCircl({
      cveMetadata: { cveId: '' },
      containers: {},
    } as never);
    assert.equal(out, null);
  });
});
