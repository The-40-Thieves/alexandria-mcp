import { XMLParser } from 'fast-xml-parser';

// One shared fast-xml-parser configuration for every adapter that parses an
// XML API response. Attributes are kept (under `@_`-prefixed keys) rather
// than dropped, since SRU/Atom/RDF feeds routinely carry the field you want
// (an id, a namespace-qualified value) as an attribute rather than text.
export interface ParseXmlOptions {
  // Tag names that must always come back as an array, even when the
  // document has exactly one of them (a single-result feed, a
  // single-author entry). Anything not listed here comes back as a plain
  // object when there is one, an array when there are several: pass the
  // result through asArray() before iterating.
  isArray?: string[];
  // Strips namespace prefixes from tag and attribute names ("srw:record"
  // parses as "record"), so differently-prefixed documents that use the
  // same underlying schema map to the same keys.
  removeNSPrefix?: boolean;
}

// Parses an XML string into a plain JS object/array tree. No schema
// validation and no fixed return shape: callers type the result as loosely
// or as tightly as they need via the generic parameter.
export function parseXml<T = unknown>(text: string, opts: ParseXmlOptions = {}): T {
  const arrayTags = opts.isArray;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: true,
    removeNSPrefix: opts.removeNSPrefix ?? false,
    // fast-xml-parser treats a present-but-undefined isArray as "always
    // false", not "unset", so only pass the key when there are tags to force.
    ...(arrayTags ? { isArray: (tagName: string) => arrayTags.includes(tagName) } : {}),
  });
  return parser.parse(text) as T;
}

// Normalises a fast-xml-parser value that may come back as a single item or
// an array (depending on how many times the tag occurred, and whether it
// was named in `isArray`) into an array.
export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// The value shape fast-xml-parser hands back for any node in a parsed
// document: a leaf comes back as a bare string (or a number, when the text
// looks numeric, fast-xml-parser's default parseTagValue behaviour), a tag
// with attributes and/or children as an object keyed by child tag name plus
// any '@_'-prefixed attributes and a '#text' entry for the tag's own text,
// and a repeated tag as an array of either.
export type XmlNode = string | number | boolean | XmlNode[] | { [key: string]: XmlNode };

// First value for `key` found anywhere under `node`, depth-first in
// document order: SRU/RDF/dcndl/Atom-style records nest the field you want
// at varying depths (and can repeat a near-empty stub element), so a
// document-wide search for the first real occurrence is more robust than a
// fixed path. `node` takes `unknown` (not `XmlNode`) because callers
// usually have a `parseXml<T>()` result typed as something looser, like
// `Record<string, unknown>`, rather than the full `XmlNode` union.
export function findDeep(node: unknown, key: string): XmlNode | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, XmlNode>;
  if (key in record) return record[key];
  for (const v of Object.values(record)) {
    const found = findDeep(Array.isArray(v) ? v[0] : v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// A tag with attributes (e.g. <dcterms:issued rdf:datatype="...">2017</...>)
// or a self-closing attribute-only tag (e.g. <category term="x"/>) parses to
// an object keyed on '#text' (present only when there's text content) plus
// any '@_'-prefixed attributes, rather than a plain string. textOf()
// extracts the text content from either shape, returning '' when there is
// none (a self-closing tag with only attributes, an empty leaf, or a value
// that isn't parseable as text at all, e.g. an array of child elements).
export function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && !Array.isArray(node) && '#text' in (node as object)) {
    return String((node as Record<string, unknown>)['#text']);
  }
  return '';
}
