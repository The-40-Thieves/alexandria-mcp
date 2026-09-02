import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.openalex.org';

function authParam(): string {
  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) return `api_key=${encodeURIComponent(apiKey)}`;
  const mailto = process.env.CONTACT_EMAIL || '';
  if (!mailto) console.warn('CONTACT_EMAIL environment variable is not set');
  return `mailto=${encodeURIComponent(mailto)}`;
}

interface OAWork {
  id: string;
  title?: string;
  authorships?: Array<{ author: { display_name: string } }>;
  publication_year?: number;
  language?: string;
  concepts?: Array<{ display_name: string; level: number }>;
  open_access?: { is_oa?: boolean; oa_url?: string };
  doi?: string;
  abstract_inverted_index?: Record<string, number[]>;
  cited_by_count?: number;
}

interface OAMeta {
  count: number;
  cost_usd?: number;
}

interface OAResponse {
  results: OAWork[];
  meta?: OAMeta;
}

// OpenAlex stores abstracts as inverted index — reconstruct
function invertedToAbstract(inv?: Record<string, number[]>): string {
  if (!inv) return '';
  const words: [string, number][] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const pos of positions) words.push([word, pos]);
  }
  words.sort((a, b) => a[1] - b[1]);
  return words.map((w) => w[0]).join(' ');
}

export function normalizeOpenAlex(data: OAResponse): LibraryResult[] {
  return (data.results || []).map((w) => ({
    id: w.id.replace('https://openalex.org/', ''),
    source: 'openalex' as const,
    title: w.title || 'Untitled',
    authors: (w.authorships || []).map((a) => a.author.display_name),
    year: w.publication_year,
    language: w.language,
    subjects: (w.concepts || []).filter((c) => c.level <= 1).map((c) => c.display_name),
    hasFullText: Boolean(w.open_access?.oa_url),
    previewUrl:
      w.open_access?.oa_url ||
      (w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : undefined),
    description: invertedToAbstract(w.abstract_inverted_index).substring(0, 300) || undefined,
  }));
}

function logCost(meta: OAMeta | undefined, context: string): void {
  // The paid api_key tier bills $0.001/search against a $1/day allowance
  // (pacing.dailyCap:900 below approximates that ceiling); surface the
  // per-call cost so it's visible without adding a metrics dependency.
  if (meta?.cost_usd !== undefined && process.env.DEBUG) {
    console.error(`[openalex] ${context} cost_usd=${meta.cost_usd}`);
  }
}

export async function openalexSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<OAResponse>(
    `${BASE}/works?search=${encodeURIComponent(query)}&per_page=${limit}&${authParam()}`,
  );
  logCost(data.meta, `search("${query}")`);
  return normalizeOpenAlex(data);
}

export async function openalexRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const w = await fetchJSON<OAWork>(`${BASE}/works/${id}?${authParam()}`);
  const abstract = invertedToAbstract(w.abstract_inverted_index);
  return {
    text: abstract || `No abstract available for OpenAlex work ${id}`,
    title: w.title || id,
    authors: (w.authorships || []).map((a) => a.author.display_name),
    year: w.publication_year,
    language: w.language,
  };
}

register('openalex', {
  description:
    'OpenAlex: 200M+ scholarly works. Free replacement for Scopus/Web of Science. Covers all disciplines. No API key required (set CONTACT_EMAIL for the polite pool, or OPENALEX_API_KEY for the paid tier).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://openalex.org',
  verifiedAt: '2026-09-01',
  // Either raises OpenAlex priority (premium key, or the polite pool via a contact email); neither is required.
  optionalEnv: ['OPENALEX_API_KEY', 'CONTACT_EMAIL'],
  pacing: { dailyCap: 900 },
  search: openalexSearch,
  async read(id) {
    const raw = await openalexRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
