import assert from 'node:assert/strict';
import test from 'node:test';
import { asArray, findDeep, parseXml, textOf } from './xml.ts';

test('parseXml', async (t) => {
  await t.test('parses attributes under the @_ prefix', () => {
    const doc = parseXml<{ item: { '@_id': string; '#text': string } }>(
      '<item id="42">Content</item>',
    );
    assert.equal(doc.item['@_id'], '42');
    assert.equal(doc.item['#text'], 'Content');
  });

  await t.test('a repeated tag not in isArray stays a single object when there is one', () => {
    const doc = parseXml<{ feed: { entry: { title: string } } }>(
      '<feed><entry><title>One</title></entry></feed>',
    );
    assert.equal(doc.feed.entry.title, 'One');
  });

  await t.test('isArray forces a single occurrence into a one-element array', () => {
    const doc = parseXml<{ feed: { entry: Array<{ title: string }> } }>(
      '<feed><entry><title>One</title></entry></feed>',
      { isArray: ['entry'] },
    );
    assert.deepEqual(doc.feed.entry, [{ title: 'One' }]);
  });

  await t.test('isArray leaves multiple occurrences as an array either way', () => {
    const doc = parseXml<{ feed: { entry: Array<{ title: string }> } }>(
      '<feed><entry><title>One</title></entry><entry><title>Two</title></entry></feed>',
    );
    assert.equal(doc.feed.entry.length, 2);
    assert.equal(doc.feed.entry[1].title, 'Two');
  });

  await t.test('decodes XML entities', () => {
    const doc = parseXml<{ item: string }>('<item>Fish &amp; chips &lt;tag&gt;</item>');
    assert.equal(doc.item, 'Fish & chips <tag>');
  });

  await t.test('removeNSPrefix strips namespace prefixes from tags and attributes', () => {
    const doc = parseXml<{ record: { '@_about': string; title: string } }>(
      '<srw:record xmlns:srw="urn:x" rdf:about="x" xmlns:rdf="urn:y"><dc:title xmlns:dc="urn:z">Title</dc:title></srw:record>',
      { removeNSPrefix: true },
    );
    assert.equal(doc.record.title, 'Title');
    assert.equal(doc.record['@_about'], 'x');
  });

  await t.test('without removeNSPrefix, prefixed names are kept verbatim', () => {
    const doc = parseXml<Record<string, unknown>>(
      '<arxiv:primary_category xmlns:arxiv="urn:x" term="cs.CV"/>',
    );
    assert.ok('arxiv:primary_category' in doc);
  });
});

test('asArray', async (t) => {
  await t.test('wraps a single value', () => {
    assert.deepEqual(asArray('a'), ['a']);
  });

  await t.test('leaves an array as-is', () => {
    assert.deepEqual(asArray(['a', 'b']), ['a', 'b']);
  });

  await t.test('returns an empty array for null or undefined', () => {
    assert.deepEqual(asArray(null), []);
    assert.deepEqual(asArray(undefined), []);
  });

  await t.test('returns an empty array for an empty array', () => {
    assert.deepEqual(asArray([]), []);
  });
});

test('findDeep', async (t) => {
  await t.test('finds a key at the top level', () => {
    const doc = parseXml<Record<string, unknown>>('<root><title>Top</title></root>');
    assert.equal(findDeep(doc, 'title'), 'Top');
  });

  await t.test('finds a key nested several levels down, depth-first in document order', () => {
    const doc = parseXml<Record<string, unknown>>(
      '<root><a><b><c><target>Deep</target></c></b></a></root>',
    );
    assert.equal(findDeep(doc, 'target'), 'Deep');
  });

  await t.test('returns the first occurrence when the key repeats at different depths', () => {
    const doc = parseXml<Record<string, unknown>>(
      '<root><a><target>First</target></a><b><target>Second</target></b></root>',
    );
    assert.equal(findDeep(doc, 'target'), 'First');
  });

  await t.test('looks inside the first element of an array-valued sibling', () => {
    // Two <item> siblings parse to an array regardless of isArray; findDeep
    // dereferences to the first element's subtree rather than skipping the
    // branch entirely.
    const doc = parseXml<Record<string, unknown>>(
      '<root><item><target>InArray</target></item><item><target>Skipped</target></item></root>',
    );
    assert.equal(findDeep(doc, 'target'), 'InArray');
  });

  await t.test('returns undefined when the key is nowhere in the document', () => {
    const doc = parseXml<Record<string, unknown>>('<root><a>1</a></root>');
    assert.equal(findDeep(doc, 'missing'), undefined);
  });

  await t.test('returns undefined for a non-object input', () => {
    assert.equal(findDeep('a plain string', 'key'), undefined);
    assert.equal(findDeep(null, 'key'), undefined);
    assert.equal(findDeep(undefined, 'key'), undefined);
  });
});

test('textOf', async (t) => {
  await t.test('returns a plain string leaf as-is', () => {
    assert.equal(textOf('hello'), 'hello');
  });

  await t.test("extracts '#text' from an object with attributes and text", () => {
    assert.equal(textOf({ '@_type': 'html', '#text': 'Hello' }), 'Hello');
  });

  await t.test('returns an empty string for an attribute-only (self-closing) node', () => {
    assert.equal(textOf({ '@_term': 'x' }), '');
  });

  await t.test('returns an empty string for null or undefined', () => {
    assert.equal(textOf(null), '');
    assert.equal(textOf(undefined), '');
  });

  await t.test('returns an empty string for an array (no single text value)', () => {
    assert.equal(textOf(['a', 'b']), '');
  });
});
