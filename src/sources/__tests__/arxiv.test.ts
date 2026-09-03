import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeArxiv } from '../arxiv.ts';

const xml = readFileSync(path.resolve(process.cwd(), 'eval/fixtures/arxiv-search.xml'), 'utf8');

test('normalizeArxiv', async (t) => {
  await t.test('parses <entry> elements from the Atom feed', () => {
    const out = normalizeArxiv(xml);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '2201.00978');
    assert.match(out[0].title, /PyramidTNT/);
    assert.equal(out[0].previewUrl, 'https://arxiv.org/abs/2201.00978');
    assert.equal(out[0].hasFullText, true);
  });

  await t.test('handles an empty feed', () => {
    assert.deepEqual(normalizeArxiv('<feed></feed>'), []);
  });

  // A <title> (or <id>/<summary>/<published>) leaf that carries an
  // attribute parses to { '@_type': ..., '#text': ... } rather than a bare
  // string; cleanField() must extract the text instead of throwing when it
  // tries to call .trim() on an object.
  await t.test('extracts text from an attributed <title type="html"> element', () => {
    const attributed = `<feed><entry>
      <id>http://arxiv.org/abs/1234.5678v1</id>
      <title type="html">Attributed Title</title>
      <summary>Some summary</summary>
      <published>2020-01-01T00:00:00Z</published>
    </entry></feed>`;
    const out = normalizeArxiv(attributed);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '1234.5678');
    assert.equal(out[0].title, 'Attributed Title');
  });
});
