import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractTitle, normalizeLegislation } from '../legislation.ts';

const atom = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/legislation-search.xml'),
  'utf8',
);
const dataXml = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/legislation-read.xml'),
  'utf8',
);

test('normalizeLegislation', async (t) => {
  await t.test('parses <entry> elements from the Atom feed', () => {
    const out = normalizeLegislation(atom);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, 'id/uksi/2012/1976');
    // The fixture's title carries a literal U+00A0 (non-breaking space)
    // before "2012", not a regular space, so match with \s (which covers
    // U+00A0 too) rather than typing the exact character here.
    assert.match(
      out[0].title,
      /^The Climate Change Agreements \(Administration\) Regulations\s2012$/,
    );
    assert.equal(out[0].year, 2026);
    assert.equal(out[0].hasFullText, true);
    assert.equal(out[0].previewUrl, 'http://www.legislation.gov.uk/id/uksi/2012/1976');
  });

  // legislation.gov.uk's real feed emits <category term="..."/> self-closing
  // (no separate closing tag with inner text), which the pre-migration regex
  // (`<category[^>]*>([\s\S]*?)</category>`) could never match either, so
  // subjects come back empty on real data both before and after migration.
  await t.test('self-closing category tags do not populate subjects', () => {
    const out = normalizeLegislation(atom);
    assert.deepEqual(out[0].subjects, []);
  });

  await t.test('handles an empty feed', () => {
    assert.deepEqual(normalizeLegislation('<feed></feed>'), []);
  });

  await t.test('drops an entry with no id', () => {
    const out = normalizeLegislation('<feed><entry><title>No id here</title></entry></feed>');
    assert.deepEqual(out, []);
  });
});

test('extractTitle', async (t) => {
  await t.test('pulls dc:title out of a real data.xml document', () => {
    assert.equal(
      extractTitle(dataXml),
      'The Non-Domestic Rating (Demand Notices) (Wales) (Amendment) Regulations 2023',
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
