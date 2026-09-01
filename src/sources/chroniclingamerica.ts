import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

// Migrated off the retired chroniclingamerica.loc.gov API (2026) to the
// unified loc.gov search/item JSON API. Chronicling America is now one
// collection within loc.gov rather than its own host.
const BASE = 'https://www.loc.gov';

interface CAResultItem {
  id: string;
  title?: string;
  date?: string;
}

interface CASearchResponse {
  results?: CAResultItem[];
}

interface CAItemDetail {
  full_text?: string;
  title?: string;
  date?: string;
}

interface CAReadResponse {
  item?: CAItemDetail;
  results?: CAItemDetail[];
}

export function normalizeChroniclingAmerica(
  data: CASearchResponse,
  limit: number,
): LibraryResult[] {
  return (data.results ?? []).slice(0, limit).map((item) => ({
    id: item.id,
    source: 'chroniclingamerica' as const,
    title: item.title ?? item.id,
    authors: [],
    year: item.date ? parseInt(item.date.slice(0, 4), 10) : undefined,
    hasFullText: true,
    previewUrl: item.id,
    url: item.id,
  }));
}

export async function chroniclingAmericaSearch(
  query: string,
  limit: number,
): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    fo: 'json',
    c: String(limit),
  });
  // loc.gov's collections search is slow (observed 15-33s) — give it a
  // longer per-attempt budget than the shared default and only one retry.
  const data = await fetchJSON<CASearchResponse>(
    `${BASE}/collections/chronicling-america/?${params}`,
    {},
    40000,
    1,
  );
  return normalizeChroniclingAmerica(data, limit);
}

// Appends a query param to a URL that may already carry a query string
// (loc.gov item ids commonly do, e.g. "...?sp=8").
function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

export async function chroniclingAmericaRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  year?: number;
}> {
  const data = await fetchJSON<CAReadResponse>(withParam(id, 'fo', 'json'), {}, 40000, 1);
  const item = data.item;
  const text = item?.full_text ?? data.results?.[0]?.full_text;

  if (text) {
    return {
      text,
      title: item?.title ?? id,
      authors: [],
      year: item?.date ? parseInt(item.date.slice(0, 4), 10) : undefined,
    };
  }

  // Fall back to the LoC text-services overlay when the item JSON itself
  // did not carry a full_text field (common for newspaper page records,
  // which serve OCR through a separate ALTO/word-coordinates service).
  const fallback = await fetchJSON<CAReadResponse>(
    withParam(id, 'st', 'text'),
    {},
    40000,
    1,
  ).catch(() => undefined);
  const fallbackText = fallback?.item?.full_text ?? fallback?.results?.[0]?.full_text;
  if (fallbackText) {
    return {
      text: fallbackText,
      title: fallback?.item?.title ?? item?.title ?? id,
      authors: [],
      year: (fallback?.item?.date ?? item?.date)
        ? parseInt((fallback?.item?.date ?? item?.date ?? '').slice(0, 4), 10)
        : undefined,
    };
  }

  throw new Error(
    `No full text found for Chronicling America item ${id}. ` +
      `The page may not have been digitized with text recognition.`,
  );
}

register('chroniclingamerica', {
  description:
    'Chronicling America (LOC) — full OCR text of US newspapers 1770–1963, now served via the unified loc.gov search/item API.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'archives',
  freshness: 'static',
  homepage: 'https://www.loc.gov/collections/chronicling-america/',
  timeoutMs: 45000,
  search: chroniclingAmericaSearch,
  async read(id) {
    const raw = await chroniclingAmericaRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
