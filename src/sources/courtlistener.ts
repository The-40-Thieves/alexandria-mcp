import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://www.courtlistener.com/api/rest/v4';

function headers(): Record<string, string> {
  const key = process.env.COURTLISTENER_API_KEY;
  if (!key)
    throw new Error(
      'CourtListener requires COURTLISTENER_API_KEY. Register a free key at: https://www.courtlistener.com/help/api/ ' +
        'then set COURTLISTENER_API_KEY in your environment.',
    );
  return { Authorization: `Token ${key}` };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface CLOpinion {
  id: number;
  absolute_url?: string;
  plain_text?: string;
  html_with_citations?: string;
  cluster?: number;
}

interface CLCluster {
  id: number;
  case_name?: string;
  date_filed?: string;
}

interface CLResult {
  id: number;
  absolute_url?: string;
  caseName?: string;
  case_name?: string;
  dateFiled?: string;
  date_filed?: string;
  snippet?: string;
  court_id?: string;
}

interface CLSearchResponse {
  count: number;
  results: CLResult[];
}

export function normalizeCourtlistener(data: CLSearchResponse): LibraryResult[] {
  return (data.results || []).map((r) => {
    const filed = r.dateFiled || r.date_filed;
    return {
      id: String(r.id),
      source: 'courtlistener' as const,
      title: r.caseName || r.case_name || `Opinion ${r.id}`,
      authors: [],
      year: filed ? parseInt(filed.substring(0, 4), 10) : undefined,
      subjects: r.court_id ? [r.court_id] : [],
      hasFullText: true,
      previewUrl: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : undefined,
      description: r.snippet?.substring(0, 300),
    };
  });
}

export async function courtlistenerSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const data = await fetchJSON<CLSearchResponse>(
    `${BASE}/search/?q=${encodeURIComponent(query)}&type=o&order_by=score+desc&page_size=${limit}`,
    { headers: headers() },
  );
  return normalizeCourtlistener(data);
}

export async function courtlistenerRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
  language?: string;
}> {
  const opinion = await fetchJSON<CLOpinion>(`${BASE}/opinions/${id}/`, { headers: headers() });

  let text = opinion.plain_text || '';
  if (!text && opinion.html_with_citations) text = stripHtml(opinion.html_with_citations);
  if (!text)
    throw new Error(
      `CourtListener opinion ${id} returned no text. Note: 125 req/day limit — check if rate limit is reached.`,
    );

  let title = `Opinion ${id}`;
  let year: number | undefined;
  if (opinion.cluster) {
    try {
      const cluster = await fetchJSON<CLCluster>(`${BASE}/clusters/${opinion.cluster}/`, {
        headers: headers(),
      });
      title = cluster.case_name || title;
      year = cluster.date_filed ? parseInt(cluster.date_filed.substring(0, 4), 10) : undefined;
    } catch {
      /* non-fatal */
    }
  }

  return { text, title, authors: [], year, language: 'en' };
}

register('courtlistener', {
  description:
    'CourtListener: US federal and state court opinions. Free Law Project. Requires free COURTLISTENER_API_KEY (125 req/day authenticated cap since 2026-05-07).',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'law',
  freshness: 'daily',
  homepage: 'https://www.courtlistener.com',
  verifiedAt: '2026-09-01',
  auth: { type: 'header', env: 'COURTLISTENER_API_KEY', header: 'Authorization' },
  pacing: { minIntervalMs: 12000, dailyCap: 120 },
  search: courtlistenerSearch,
  async read(id) {
    const raw = await courtlistenerRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
