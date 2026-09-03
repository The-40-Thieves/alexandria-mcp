import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractTitle, normalizeLegislationScot } from '../legislationscot.ts';

const atom = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/legislationscot-search.xml'),
  'utf8',
);
const dataXml = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/legislationscot-read.xml'),
  'utf8',
);

test('normalizeLegislationScot', async (t) => {
  await t.test('parses <entry> elements from the asp+ssi Atom feed', () => {
    const out = normalizeLegislationScot(atom);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'id/ssi/2020/281');
    assert.equal(
      out[0].title,
      'The Climate Change (Duties of Public Bodies: Reporting Requirements) (Scotland) Amendment Order 2020',
    );
    assert.equal(out[0].year, 2023);
    assert.equal(out[0].hasFullText, true);
    assert.equal(out[0].previewUrl, 'http://www.legislation.gov.uk/id/ssi/2020/281');
  });

  await t.test('tags an ssi id as Scottish Statutory Instruments', () => {
    const out = normalizeLegislationScot(atom);
    assert.deepEqual(out[0].subjects, ['Scottish Statutory Instruments']);
  });

  // Real ids always come back prefixed "id/..." (e.g. "id/asp/2020/1")
  // after the leading "https://www.legislation.gov.uk/" is stripped, so
  // `id.startsWith('asp')` never actually matches on live data, so every
  // real entry falls through to "Scottish Statutory Instruments" even for
  // an Act of Scottish Parliament. That's a pre-existing quirk in the
  // original regex code, unrelated to this migration and left as-is; this
  // asserts the *reachable* branch, an id with no "id/" segment at all.
  await t.test('tags an id starting with "asp" as Acts of Scottish Parliament', () => {
    const out = normalizeLegislationScot(
      '<feed><entry><id>http://www.legislation.gov.uk/asp/2020/1</id><title>An Act</title></entry></feed>',
    );
    assert.deepEqual(out[0].subjects, ['Acts of Scottish Parliament']);
  });

  await t.test('handles an empty feed', () => {
    assert.deepEqual(normalizeLegislationScot('<feed></feed>'), []);
  });

  await t.test('drops an entry with no id', () => {
    const out = normalizeLegislationScot('<feed><entry><title>No id here</title></entry></feed>');
    assert.deepEqual(out, []);
  });

  // Final wave, A4: same fix as legislation.ts - cleanField now routes
  // through the shared textOf() instead of a bare `(s ?? '').trim()`, so
  // an attribute on id/title/updated (which fast-xml-parser turns into an
  // object, not a string) no longer crashes with "s.trim is not a
  // function".
  await t.test('an attributed leaf (id/title/updated with an attribute) does not crash', () => {
    const out = normalizeLegislationScot(
      '<feed><entry>' +
        '<id xml:lang="en">http://www.legislation.gov.uk/id/asp/2024/1</id>' +
        '<title type="main">An Act with an attributed title</title>' +
        '<updated tz="Z">2024-01-01T00:00:00Z</updated>' +
        '</entry></feed>',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'id/asp/2024/1');
    assert.equal(out[0].title, 'An Act with an attributed title');
    assert.equal(out[0].year, 2024);
  });
});

test('extractTitle', async (t) => {
  await t.test('pulls dc:title out of a real data.xml document', () => {
    assert.equal(
      extractTitle(dataXml),
      'The A76 Trunk Road (Sanquhar) (Temporary Prohibition on Waiting, Loading and Unloading) Order 2023',
    );
  });

  await t.test('falls back to a plain Title element when there is no dc:title', () => {
    assert.equal(
      extractTitle('<Legislation><Title>Old Schema Title</Title></Legislation>'),
      'Old Schema Title',
    );
  });

  await t.test('returns an empty string when neither is present', () => {
    assert.equal(extractTitle('<Legislation></Legislation>'), '');
  });
});
