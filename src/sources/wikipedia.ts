// Wikipedia (English): the REST search API for search(), the page summary
// plus the mobile-html rendition (through fetchAsText, SSRF-guarded) for
// read(). Wikimedia asks for a contact User-Agent identifying the caller;
// CONTACT_EMAIL is optional (the source still works without it, same as
// openalex's polite pool) but is folded in when set.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { stripHtml } from '../utils/text-clean.ts';
import { fetchAsText } from '../web/fetchTier.ts';
import { register, truncateText } from './registry.ts';

const SEARCH_BASE = 'https://en.wikipedia.org/w/rest.php/v1/search/page';
const SUMMARY_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const MOBILE_HTML_BASE = 'https://en.wikipedia.org/api/rest_v1/page/mobile-html';

function headers(): Record<string, string> {
  const email = process.env.CONTACT_EMAIL;
  return {
    'User-Agent': `alexandria-mcp/10 (${email ? `mailto:${email}` : 'https://github.com/The-40-Thieves/alexandria-mcp'})`,
  };
}

interface WPSearchPage {
  id: number;
  key: string;
  title: string;
  excerpt?: string;
  description?: string;
}
interface WPSearchResponse {
  pages: WPSearchPage[];
}
interface WPSummary {
  title: string;
  description?: string;
  extract?: string;
}

export function normalizeWikipediaPage(page: WPSearchPage): LibraryResult {
  return {
    id: page.key,
    source: 'wikipedia',
    title: page.title,
    authors: [],
    subjects: page.description ? [page.description] : undefined,
    hasFullText: true,
    previewUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
    description: page.excerpt ? stripHtml(page.excerpt).slice(0, 300) : undefined,
  };
}

export async function wikipediaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const data = await fetchJSON<WPSearchResponse>(`${SEARCH_BASE}?${params}`, {
    headers: headers(),
  });
  return (data.pages ?? []).map(normalizeWikipediaPage);
}

// Reads the page summary (for title) and the mobile-html rendition (for
// full article text, via the fetch tier's defuddle extraction) in
// parallel-ish sequence; if the full-text fetch fails for any reason
// (rare, but third-party HTML extraction can), falls back to the
// summary's short extract rather than failing the whole read, the same
// degrade-on-failure convention as nhk.ts/peps.ts.
export async function wikipediaRead(title: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
}> {
  const summary = await fetchJSON<WPSummary>(`${SUMMARY_BASE}/${encodeURIComponent(title)}`, {
    headers: headers(),
  });
  try {
    const page = await fetchAsText(`${MOBILE_HTML_BASE}/${encodeURIComponent(title)}`);
    return { text: page.text, title: summary.title, authors: [], language: 'en' };
  } catch {
    return {
      text: summary.extract || `No extract available for "${title}".`,
      title: summary.title,
      authors: [],
      language: 'en',
    };
  }
}

register('wikipedia', {
  description:
    'Wikipedia (English): full-text page search plus full article read (summary + mobile-html extraction). CC BY-SA text: attribution is a license condition, not optional. Works keyless; set CONTACT_EMAIL for a compliant contact User-Agent.',
  supportsIngest: true,
  // Wikipedia content is CC BY-SA: attribution is a license condition, not
  // optional (see src/sources/ingestPolicy.ts).
  ingestPolicy: 'attribution',
  kind: 'rest',
  cluster: 'web',
  freshness: 'daily',
  homepage: 'https://en.wikipedia.org',
  verifiedAt: '2026-09-03',
  optionalEnv: ['CONTACT_EMAIL'],
  timeoutMs: 20000,
  search: wikipediaSearch,
  async read(id): Promise<ReadResult> {
    const raw = await wikipediaRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
