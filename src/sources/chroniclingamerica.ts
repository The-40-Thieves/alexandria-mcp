import { fetchJSON, fetchText } from '../utils/http.js';
import { normaliseWhitespace } from '../utils/text-clean.js';
import type { LibraryResult } from '../types.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://chroniclingamerica.loc.gov';

interface CAItem {
  url: string;
  title: string;
  date: string;
  edition_sequence: number;
  page: number;
  lccn: string;
  state: string;
  place_of_publication?: string;
}

interface CAResponse {
  totalItems: number;
  itemsPerPage: number;
  startIndex: number;
  endIndex: number;
  items: CAItem[];
}

export async function chroniclingAmericaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    andtext: query,
    format: 'json',
    rows: String(limit),
    sort: 'relevance',
  });

  const data = await fetchJSON<CAResponse>(
    `${BASE}/search/pages/results/?${params}`
  );

  return (data.items ?? []).slice(0, limit).map(item => {
    // Normalize URL: ensure it ends with /
    const pageUrl = item.url.endsWith('/') ? item.url : item.url + '/';

    return {
      id: pageUrl,
      source: 'chroniclingamerica' as const,
      title: `${item.title} — ${item.date} (p. ${item.page})`,
      authors: [item.title], // newspaper name as author
      year: parseInt(item.date.slice(0, 4), 10),
      language: 'en',
      subjects: ['Newspaper', item.state, 'American history'].filter(Boolean),
      hasFullText: true,
      previewUrl: pageUrl,
      downloadUrl: `${pageUrl}ocr.txt`,
    };
  });
}

export async function chroniclingAmericaRead(pageUrl: string): Promise<{
  text: string; title: string; authors: string[]; year?: number;
}> {
  // pageUrl looks like: https://chroniclingamerica.loc.gov/lccn/sn83030214/1865-04-15/ed-1/seq-1/
  const ocrUrl = pageUrl.endsWith('/') ? `${pageUrl}ocr.txt` : `${pageUrl}/ocr.txt`;

  const text = await fetchText(ocrUrl);
  if (!text || text.length < 50) {
    throw new Error(
      `No OCR text found for ${pageUrl}. ` +
      `The page may not have been digitized with text recognition.`
    );
  }

  // Extract date and paper name from URL for metadata
  const dateMatch = pageUrl.match(/\/(\d{4}-\d{2}-\d{2})\//);
  const year = dateMatch ? parseInt(dateMatch[1], 10) : undefined;

  return {
    text: normaliseWhitespace(text),
    title: `Chronicling America — ${pageUrl}`,
    authors: [],
    year,
  };
}

// For ingest: fetch multiple pages from a search and concatenate.
// This allows ingesting a topic across many newspaper pages.
export async function chroniclingAmericaReadTopic(query: string, maxPages = 10): Promise<{
  text: string; title: string; authors: string[]; year?: number;
}> {
  const results = await chroniclingAmericaSearch(query, maxPages);
  const parts: string[] = [];

  for (const r of results) {
    await new Promise(res => setTimeout(res, 500));
    try {
      const page = await chroniclingAmericaRead(r.id);
      if (page.text.length > 100) {
        parts.push(`--- ${r.title} ---\n\n${page.text}`);
      }
    } catch { /* skip failed OCR */ }
  }

  return {
    text: parts.join('\n\n'),
    title: `Chronicling America: "${query}" — ${results.length} pages`,
    authors: [],
  };
}

register('chroniclingamerica', {
  description: 'Chronicling America (LOC) — full OCR text of US newspapers 1770–1963. Search returns individual pages; ingest via page URL or search query.',
  supportsIngest: true,
  search: chroniclingAmericaSearch,
  async read(id) {
    // If id looks like a search query (no LOC URL structure), aggregate topic pages
    if (!id.includes('chroniclingamerica.loc.gov') && !id.includes('/lccn/')) {
      const raw = await chroniclingAmericaReadTopic(id);
      return { ...raw, ...truncateText(raw.text) };
    }
    const raw = await chroniclingAmericaRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
