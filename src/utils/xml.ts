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
