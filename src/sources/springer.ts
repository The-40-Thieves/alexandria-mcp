import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const META_BASE = 'https://api.springernature.com/meta/v2';
const OA_BASE = 'https://api.springernature.com/openaccess';

function metaKey(): string {
  const k = process.env.SPRINGER_META_API_KEY;
  if (!k)
    throw new Error(
      'SPRINGER_META_API_KEY is not set. Register at https://dev.springernature.com/',
    );
  return k;
}

function oaKey(): string {
  const k = process.env.SPRINGER_OA_API_KEY;
  if (!k)
    throw new Error('SPRINGER_OA_API_KEY is not set. Register at https://dev.springernature.com/');
  return k;
}

interface SpringerCreator {
  creator?: string;
}
interface SpringerURL {
  value?: string;
  format?: string;
  platform?: string;
}
interface SpringerRecord {
  identifier?: string;
  title?: string;
  creators?: SpringerCreator[];
  publicationDate?: string;
  abstract?: string;
  url?: SpringerURL[];
  subject?: string[];
  keywords?: string[];
  language?: string;
  openaccess?: string | boolean;
  doi?: string;
  publicationName?: string;
  contentType?: string;
}

// result is a plain object (not array) per the actual API shape
interface SpringerResponse {
  records?: SpringerRecord[];
  result?: { total?: string; start?: string; pageLength?: string; recordsDisplayed?: string };
}

function pickUrl(urls?: SpringerURL[]): string | undefined {
  return (
    urls?.find((u) => u.format === 'html')?.value ??
    urls?.find((u) => u.format === 'pdf')?.value ??
    urls?.[0]?.value
  );
}

function parseDoi(r: SpringerRecord): string {
  // identifier is "doi:10.xxxx/..." — strip the prefix
  const raw = r.doi || r.identifier?.replace(/^doi:/, '') || '';
  return raw;
}

function toResult(r: SpringerRecord): LibraryResult {
  const doi = parseDoi(r);
  return {
    id: doi,
    source: 'springer' as const,
    title: r.title || 'Untitled',
    authors: (r.creators || []).map((c) => c.creator || '').filter(Boolean),
    year: r.publicationDate ? parseInt(r.publicationDate.substring(0, 4), 10) : undefined,
    language: r.language,
    subjects: [...(r.subject || []), ...(r.keywords || [])],
    hasFullText: Boolean(r.abstract || pickUrl(r.url)),
    previewUrl: pickUrl(r.url) ?? (doi ? `https://doi.org/${doi}` : undefined),
    description: r.abstract?.substring(0, 300),
  };
}

// Search: Meta API — 16M+ records (OA + paywalled), abstracts only
export async function springerSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<SpringerResponse>(
    `${META_BASE}/json?q=${encodeURIComponent(query)}&s=1&p=${limit}&api_key=${metaKey()}`,
  );
  return (data.records || []).map(toResult);
}

// Read: try OA API first (may have full text), fall back to Meta for abstract
export async function springerRead(doi: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const encoded = encodeURIComponent(`doi:${doi}`);

  // Try OA API first
  try {
    const oaData = await fetchJSON<SpringerResponse>(
      `${OA_BASE}/json?q=${encoded}&s=1&p=1&api_key=${oaKey()}`,
    );
    const r = oaData.records?.[0];
    if (r?.abstract) {
      return {
        text: r.abstract,
        title: r.title || doi,
        authors: (r.creators || []).map((c) => c.creator || '').filter(Boolean),
        year: r.publicationDate ? parseInt(r.publicationDate.substring(0, 4), 10) : undefined,
        language: r.language,
      };
    }
  } catch {
    // OA key not set or article not OA — fall through to Meta
  }

  // Fall back to Meta API
  const metaData = await fetchJSON<SpringerResponse>(
    `${META_BASE}/json?q=${encoded}&s=1&p=1&api_key=${metaKey()}`,
  );
  const r = metaData.records?.[0];
  if (!r) throw new Error(`Springer article not found: ${doi}`);
  return {
    text: r.abstract || `No abstract available for Springer article ${doi}`,
    title: r.title || doi,
    authors: (r.creators || []).map((c) => c.creator || '').filter(Boolean),
    year: r.publicationDate ? parseInt(r.publicationDate.substring(0, 4), 10) : undefined,
    language: r.language,
  };
}

register('springer', {
  description:
    'Springer Nature — 16M+ articles via Meta API (all content, abstracts) + OA API (open access full text). Requires SPRINGER_META_API_KEY and SPRINGER_OA_API_KEY (free at dev.springernature.com).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'academic',
  freshness: 'daily',
  homepage: 'https://www.springernature.com',
  verifiedAt: '2026-09-01',
  search: springerSearch,
  async read(id) {
    const raw = await springerRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
