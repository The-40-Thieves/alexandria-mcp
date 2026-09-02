import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hathitrustSearch, normalizeHathiTrustBrief } from '../hathitrust.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/hathitrust-read.json'), 'utf8'),
);

test('hathitrust', async (t) => {
  await t.test(
    'search always returns [] (the Data API keyword-search endpoint was retired)',
    async () => {
      assert.deepEqual(await hathitrustSearch('anything', 10), []);
    },
  );

  await t.test('normalizes a brief-volumes response by OCLC lookup', () => {
    const out = normalizeHathiTrustBrief(fixture, 'oclc:424023');
    assert.equal(out.title, 'Infinite series');
    assert.equal(out.year, 1962);
    assert.equal(out.metadataOnly, true);
    assert.equal(out.externalUrl, 'https://babel.hathitrust.org/cgi/pt?id=mdp.39015025315527');
    assert.match(out.note, /rights: ic/);
  });

  await t.test('throws when neither records nor items are present', () => {
    assert.throws(() => normalizeHathiTrustBrief({}, 'oclc:0'), /No HathiTrust record found/);
  });
});
