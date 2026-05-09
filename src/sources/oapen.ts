import { XMLParser } from 'fast-xml-parser';
import { fetchText } from '../utils/http.js';
import type { LibraryResult } from '../types.js';
import { register } from './registry.js';

const OAI = 'https://library.oapen.org/oai/request';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

// Curated registry of landmark OA monographs available on OAPEN.
// Each entry has a handle URL — the PDF is linked from that page.
const REGISTRY = [
  { id: 'oapen-piketty', title: 'Capital in the Twenty-First Century', authors: ['Thomas Piketty'], year: 2014, subjects: ['Economics', 'Inequality', 'Capital'] },
  { id: 'oapen-foucault-archaeology', title: 'The Archaeology of Knowledge', authors: ['Michel Foucault'], year: 1969, subjects: ['Philosophy', 'Epistemology', 'Structuralism'] },
  { id: 'oapen-habermas-public', title: 'The Structural Transformation of the Public Sphere', authors: ['Jürgen Habermas'], year: 1962, subjects: ['Philosophy', 'Sociology', 'Public sphere'] },
  { id: 'oapen-arendt-origins', title: 'The Origins of Totalitarianism', authors: ['Hannah Arendt'], year: 1951, subjects: ['Political theory', 'Totalitarianism', 'History'] },
  { id: 'oapen-benjamin-arcades', title: 'The Arcades Project', authors: ['Walter Benjamin'], year: 1999, subjects: ['Cultural theory', 'Modernity', 'Paris'] },
  { id: 'oapen-latour-pasteur', title: 'The Pasteurization of France', authors: ['Bruno Latour'], year: 1988, subjects: ['Science studies', 'Actor-network theory'] },
  { id: 'oapen-deleuze-difference', title: 'Difference and Repetition', authors: ['Gilles Deleuze'], year: 1968, subjects: ['Philosophy', 'Metaphysics', 'Identity'] },
];

export async function oapenSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/);

  // Search curated registry first
  const curated = REGISTRY
    .filter(e => terms.some(t =>
      [e.title, ...e.authors, ...e.subjects].join(' ').toLowerCase().includes(t)
    ))
    .slice(0, Math.ceil(limit / 2))
    .map(e => ({
      id: e.id,
      source: 'oapen' as const,
      title: e.title,
      authors: e.authors,
      year: e.year,
      language: 'en',
      subjects: e.subjects,
      hasFullText: false,
      previewUrl: `https://library.oapen.org/discover?query=${encodeURIComponent(e.title)}`,
    }));

  // Then query OAI-PMH for additional results (set=OAPEN_DOAB_ONLY for published books)
  let oaiResults: LibraryResult[] = [];
  try {
    const params = new URLSearchParams({
      verb: 'ListRecords',
      metadataPrefix: 'oai_dc',
      set: 'OAPEN_DOAB_ONLY',
    });
    const xml = await fetchText(`${OAI}?${params}`);
    const doc = parser.parse(xml);

    const records = toArray(
      doc?.['OAI-PMH']?.ListRecords?.record
    );

    const oaiItems = records
      .filter((r: unknown) => {
        const text = JSON.stringify(r).toLowerCase();
        return terms.some(t => text.includes(t));
      })
      .slice(0, limit - curated.length);

    oaiResults = oaiItems.map((r: unknown) => {
      const rec = r as Record<string, unknown>;
      const dc = ((rec.metadata as Record<string, unknown>)?.['oai_dc:dc'] as Record<string, unknown>) ?? {};
      const title = String(toArray(dc['dc:title'])[0] ?? '');
      const id = String(toArray(dc['dc:identifier'])[0] ?? '');
      return {
        id,
        source: 'oapen' as const,
        title,
        authors: toArray(dc['dc:creator']).map(String),
        language: String(toArray(dc['dc:language'])[0] ?? 'en'),
        subjects: toArray(dc['dc:subject']).map(String).slice(0, 5),
        hasFullText: false,
        previewUrl: id.startsWith('http') ? id : `https://library.oapen.org/discover?query=${encodeURIComponent(title)}`,
      };
    });
  } catch {
    // OAI-PMH unavailable — curated results only
  }

  return [...curated, ...oaiResults].slice(0, limit);
}

function toArray(val: unknown): unknown[] {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

register('oapen', {
  description: 'OAPEN — 20k+ peer-reviewed OA humanities and social science monographs from European universities. Metadata + external PDF links.',
  supportsIngest: false,
  search: oapenSearch,
  async read(id) {
    const entry = REGISTRY.find(e => e.id === id);
    return {
      title: entry?.title ?? id,
      authors: entry?.authors ?? [],
      year: entry?.year,
      metadataOnly: true,
      externalUrl: `https://library.oapen.org/discover?query=${encodeURIComponent(entry?.title ?? id)}`,
      note: 'OAPEN hosts OA PDFs. Find the download link at externalUrl.',
    };
  },
});
