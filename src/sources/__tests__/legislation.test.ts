import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractTitle, legislationSearch, normalizeLegislation } from '../legislation.ts';

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

  // Final wave, A4: an attribute on <id>/<title>/<updated> makes
  // fast-xml-parser return an object ({'@_lang': 'en', '#text': '...'})
  // instead of a plain string, which used to crash cleanField's bare
  // `(s ?? '').trim()` with "s.trim is not a function". cleanField now
  // routes through the shared textOf(), which handles both shapes.
  await t.test('an attributed leaf (id/title/updated with an attribute) does not crash', () => {
    const out = normalizeLegislation(
      '<feed><entry>' +
        '<id xml:lang="en">http://www.legislation.gov.uk/id/ukpga/2024/1</id>' +
        '<title type="main">An Act with an attributed title</title>' +
        '<updated tz="Z">2024-01-01T00:00:00Z</updated>' +
        '</entry></feed>',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'id/ukpga/2024/1');
    assert.equal(out[0].title, 'An Act with an attributed title');
    assert.equal(out[0].year, 2024);
  });
});

// Final wave, A4: `/search?q=...` returned the HTML results page (0
// <entry> elements, a silent empty result with no error - see this
// module's comment on legislationSearch). Verified live that
// `/all/data.feed?text=...` returns the Atom feed instead; this pins the
// URL legislationSearch() actually builds so a regression back to the
// HTML endpoint fails a test instead of only showing up as a quiet /health
// false-clean.
test('legislationSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('queries the Atom data.feed endpoint, not the HTML search page', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(atom, { status: 200 });
    }) as typeof fetch;

    const out = await legislationSearch('climate change', 3);
    assert.equal(
      calledUrl,
      'https://www.legislation.gov.uk/all/data.feed?text=climate%20change&results-count=3',
    );
    assert.equal(out.length, 3);
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
