import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeGallica } from '../gallica.ts';

// Recorded shape is transcribed from Gallica's documented SRU/DC response
// (see the fixture's own header comment); the endpoint currently returns
// an ALTCHA bot-check page to this sandbox's egress IP rather than XML.
const xml = readFileSync(path.resolve(process.cwd(), 'eval/fixtures/gallica-search.xml'), 'utf8');

test('normalizeGallica', async (t) => {
  await t.test('parses srw:record/dc:title with removeNSPrefix', () => {
    const out = normalizeGallica(xml, 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'https://gallica.bnf.fr/ark:/12148/bpt6k95207b');
    assert.equal(out[0].title, 'Histoire des sciences mathématiques et physiques');
    assert.deepEqual(out[0].authors, ['Bertrand, Joseph (1822-1900)']);
    assert.equal(out[0].year, 1882);
    assert.equal(out[0].language, 'fre');
    assert.equal(out[0].hasFullText, true);
  });

  await t.test('handles a record with no creator', () => {
    const out = normalizeGallica(xml, 10);
    assert.deepEqual(out[1].authors, []);
    assert.equal(out[1].year, 1665);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeGallica(xml, 1).length, 1);
  });

  await t.test('handles a response with no records', () => {
    assert.deepEqual(
      normalizeGallica(
        '<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/"></srw:searchRetrieveResponse>',
        10,
      ),
      [],
    );
  });
});
