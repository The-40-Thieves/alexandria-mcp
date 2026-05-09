import { XMLParser } from 'fast-xml-parser';
import { fetchText } from '../utils/http.js';
import { normaliseWhitespace } from '../utils/text-clean.js';
import type { LibraryResult } from '../types.js';
import { register, truncateText } from './registry.js';

// Perseus CTS API — Tufts University
const CTS = 'http://www.perseus.tufts.edu/hopper/CTS';
const MAX_PASSAGES = 50; // cap to avoid hundreds of API calls

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Well-known URN prefixes for search simulation (CTS has no keyword search API)
const PERSEUS_CATALOG: Array<{
  id: string; title: string; authors: string[]; language: string;
  subjects: string[]; urn: string;
}> = [
  { id: 'iliad', title: 'Iliad', authors: ['Homer'], language: 'grc', subjects: ['Epic poetry', 'Greek literature'], urn: 'urn:cts:greekLit:tlg0012.tlg001' },
  { id: 'odyssey', title: 'Odyssey', authors: ['Homer'], language: 'grc', subjects: ['Epic poetry', 'Greek literature'], urn: 'urn:cts:greekLit:tlg0012.tlg002' },
  { id: 'republic', title: 'Republic', authors: ['Plato'], language: 'grc', subjects: ['Philosophy', 'Political theory'], urn: 'urn:cts:greekLit:tlg0059.tlg030' },
  { id: 'apology', title: 'Apology', authors: ['Plato'], language: 'grc', subjects: ['Philosophy', 'Socrates'], urn: 'urn:cts:greekLit:tlg0059.tlg002' },
  { id: 'nicomachean-ethics', title: 'Nicomachean Ethics', authors: ['Aristotle'], language: 'grc', subjects: ['Ethics', 'Philosophy'], urn: 'urn:cts:greekLit:tlg0086.tlg010' },
  { id: 'poetics', title: 'Poetics', authors: ['Aristotle'], language: 'grc', subjects: ['Literary theory', 'Drama'], urn: 'urn:cts:greekLit:tlg0086.tlg034' },
  { id: 'aeneid', title: 'Aeneid', authors: ['Virgil'], language: 'lat', subjects: ['Epic poetry', 'Roman literature'], urn: 'urn:cts:latinLit:phi0690.phi003' },
  { id: 'meditations', title: 'Meditations', authors: ['Marcus Aurelius'], language: 'grc', subjects: ['Stoicism', 'Philosophy'], urn: 'urn:cts:greekLit:tlg0558.tlg001' },
  { id: 'histories-herodotus', title: 'Histories', authors: ['Herodotus'], language: 'grc', subjects: ['History', 'Persia', 'Greece'], urn: 'urn:cts:greekLit:tlg0016.tlg001' },
  { id: 'peloponnesian-war', title: 'History of the Peloponnesian War', authors: ['Thucydides'], language: 'grc', subjects: ['History', 'Athens', 'Sparta'], urn: 'urn:cts:greekLit:tlg0003.tlg001' },
  { id: 'de-rerum-natura', title: 'De Rerum Natura', authors: ['Lucretius'], language: 'lat', subjects: ['Epicureanism', 'Physics'], urn: 'urn:cts:latinLit:phi0550.phi001' },
  { id: 'antigone', title: 'Antigone', authors: ['Sophocles'], language: 'grc', subjects: ['Drama', 'Tragedy'], urn: 'urn:cts:greekLit:tlg0011.tlg001' },
  { id: 'oedipus-rex', title: 'Oedipus Rex', authors: ['Sophocles'], language: 'grc', subjects: ['Drama', 'Tragedy'], urn: 'urn:cts:greekLit:tlg0011.tlg004' },
  { id: 'enchiridion', title: 'Enchiridion', authors: ['Epictetus'], language: 'grc', subjects: ['Stoicism', 'Philosophy'], urn: 'urn:cts:greekLit:tlg0557.tlg002' },
];

function idToUrn(id: string): string | null {
  return PERSEUS_CATALOG.find(e => e.id === id)?.urn ?? null;
}

export function perseusSearch(query: string, limit: number): LibraryResult[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);

  return PERSEUS_CATALOG
    .filter(e => {
      const haystack = [e.title, ...e.authors, ...e.subjects, e.language].join(' ').toLowerCase();
      return terms.some(t => haystack.includes(t));
    })
    .slice(0, limit)
    .map(e => ({
      id: e.id,
      source: 'perseus' as const,
      title: e.title,
      authors: e.authors,
      language: e.language,
      subjects: e.subjects,
      hasFullText: true,
      previewUrl: `http://www.perseus.tufts.edu/hopper/text?doc=${e.urn}`,
    }));
}

export async function perseusRead(id: string): Promise<{
  text: string; title: string; authors: string[]; language?: string;
}> {
  const urn = idToUrn(id);
  if (!urn) {
    const ids = PERSEUS_CATALOG.map(e => e.id).join(', ');
    throw new Error(`Unknown Perseus ID: "${id}". Valid IDs: ${ids}`);
  }

  const entry = PERSEUS_CATALOG.find(e => e.id === id)!;

  // Get top-level passages (books/sections)
  const refsXml = await fetchText(
    `${CTS}?request=GetValidReff&urn=${urn}&level=1`
  );
  const refsDoc = parser.parse(refsXml) as Record<string, unknown>;

  // Extract URNs from the XML response
  const reffText = JSON.stringify(refsDoc);
  const urnMatches = [...reffText.matchAll(/"(urn:cts:[^"]+)"/g)].map(m => m[1]);
  const passages = urnMatches.filter(u => u !== urn).slice(0, MAX_PASSAGES);

  if (passages.length === 0) {
    // Try fetching the whole text as one passage
    await new Promise(r => setTimeout(r, 500));
    const xml = await fetchText(`${CTS}?request=GetPassage&urn=${urn}`);
    const text = extractText(xml);
    return { text: normaliseWhitespace(text), title: entry.title, authors: entry.authors, language: entry.language };
  }

  const parts: string[] = [];
  for (const passageUrn of passages) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const xml = await fetchText(`${CTS}?request=GetPassage&urn=${passageUrn}`);
      const text = extractText(xml);
      if (text.length > 50) parts.push(text);
    } catch { /* skip bad passage */ }
  }

  return {
    text: normaliseWhitespace(parts.join('\n\n')),
    title: entry.title,
    authors: entry.authors,
    language: entry.language,
  };
}

function extractText(xml: string): string {
  // Strip XML/TEI tags, keep text content
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{3,}/g, ' ')
    .trim();
}

register('perseus', {
  description: 'Perseus Digital Library — classical Greek, Latin, and Arabic texts with translations.',
  supportsIngest: true,
  search: (query, limit) => Promise.resolve(perseusSearch(query, limit)),
  async read(id) {
    const raw = await perseusRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
