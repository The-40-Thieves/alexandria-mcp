// Crossref REST API: authoritative DOI metadata for 160M+ scholarly
// records. read() combines the work's own metadata (incl. its reference
// list) with a BibTeX citation fetched via DOI content negotiation
// (Accept: application/x-bibtex on doi.org) - two sequential fetches, so
// this is a hand-written register() rather than defineRest (whose
// read.normalize is a single synchronous pass over one fetched response).
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.crossref.org';

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}
interface CrossrefDateParts {
  'date-parts'?: Array<Array<number | null>>;
}
interface CrossrefReference {
  key: string;
  DOI?: string;
  unstructured?: string;
  'article-title'?: string;
}
interface CrossrefWork {
  DOI: string;
  title?: string[];
  author?: CrossrefAuthor[];
  issued?: CrossrefDateParts;
  'container-title'?: string[];
  abstract?: string;
  URL?: string;
  language?: string;
  reference?: CrossrefReference[];
  'reference-count'?: number;
}
interface CrossrefSearchResponse {
  message: { items: CrossrefWork[] };
}
interface CrossrefWorkResponse {
  message: CrossrefWork;
}

// mailto identifies the request for Crossref's polite pool (higher rate
// limit); omitted entirely (not an empty param) when CONTACT_EMAIL isn't
// set, since Crossref rate-limits an invalid/empty mailto more harshly
// than none at all. Returns bare "mailto=..." (no leading separator) so
// call sites can join it with whichever separator their URL needs.
function mailtoQuery(): string {
  const email = process.env.CONTACT_EMAIL;
  return email ? `mailto=${encodeURIComponent(email)}` : '';
}

function authorNames(authors?: CrossrefAuthor[]): string[] {
  return (authors ?? [])
    .map((a) => a.name || [a.given, a.family].filter(Boolean).join(' '))
    .filter((n): n is string => Boolean(n));
}

function issuedYear(work: CrossrefWork): number | undefined {
  const year = work.issued?.['date-parts']?.[0]?.[0];
  return typeof year === 'number' ? year : undefined;
}

// Crossref abstracts are wrapped in JATS markup (<jats:p>...</jats:p>).
function stripJats(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCrossref(work: CrossrefWork): LibraryResult {
  return {
    id: work.DOI,
    source: 'crossref',
    title: work.title?.[0] || 'Untitled',
    authors: authorNames(work.author),
    year: issuedYear(work),
    language: work.language ?? undefined,
    subjects: work['container-title']?.length ? [work['container-title'][0]] : undefined,
    hasFullText: false,
    previewUrl: work.URL || `https://doi.org/${work.DOI}`,
    description: work.abstract ? stripJats(work.abstract).slice(0, 300) : undefined,
  };
}

export async function crossrefSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const mailto = mailtoQuery();
  const data = await fetchJSON<CrossrefSearchResponse>(
    `${BASE}/works?query=${encodeURIComponent(query)}&rows=${limit}${mailto ? `&${mailto}` : ''}`,
  );
  return (data.message.items ?? []).map(normalizeCrossref);
}

export async function crossrefRead(doi: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
  doi: string;
}> {
  const mailto = mailtoQuery();
  const data = await fetchJSON<CrossrefWorkResponse>(
    `${BASE}/works/${encodeURIComponent(doi)}${mailto ? `?${mailto}` : ''}`,
  );
  const work = data.message;

  const refs = (work.reference ?? [])
    .slice(0, 30)
    .map((r, i) => `${i + 1}. ${r.unstructured || r['article-title'] || r.DOI || r.key}`)
    .join('\n');

  // BibTeX is optional: doi.org content negotiation is a separate service
  // from the Crossref API itself and can be slow or unavailable without
  // failing the whole read.
  let bibtex = '';
  try {
    bibtex = await fetchText(`https://doi.org/${encodeURIComponent(doi)}`, {
      headers: { Accept: 'application/x-bibtex' },
    });
  } catch {
    /* optional */
  }

  const abstract = work.abstract ? stripJats(work.abstract) : '';
  const sections = [abstract || `No abstract available for ${doi}.`];
  if (refs) {
    sections.push(
      `\nReferences (${work['reference-count'] ?? work.reference?.length ?? 0}):\n${refs}`,
    );
  }
  if (bibtex.trim()) sections.push(`\nBibTeX:\n${bibtex.trim()}`);

  return {
    text: sections.join('\n'),
    title: work.title?.[0] || doi,
    authors: authorNames(work.author),
    year: issuedYear(work),
    language: work.language ?? undefined,
    doi: work.DOI || doi,
  };
}

register('crossref', {
  description:
    'Crossref: authoritative DOI metadata for 160M+ scholarly records, including reference lists and a BibTeX citation. Works keyless; set CONTACT_EMAIL for the polite pool (higher rate limit).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://www.crossref.org',
  verifiedAt: '2026-09-03',
  optionalEnv: ['CONTACT_EMAIL'],
  // Crossref rate-limits list/query requests at 1 rps public / 3 rps
  // polite (since 2026-07-21); paced conservatively at the polite rate.
  pacing: { minIntervalMs: 334 },
  search: crossrefSearch,
  async read(id): Promise<ReadResult> {
    const raw = await crossrefRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
