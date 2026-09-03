// World Bank Indicators API v2: 29.5k+ development indicators across every
// country. The indicator listing endpoint's `q`/query parameters are
// silently ignored (verified live 2026-09-03: identical `total` count
// regardless of `q`) - there is no server-side search. Unlike bioRxiv's
// windowed scan, the whole catalog fits in one response with a large
// enough per_page (~29.5k indicators, one page at per_page=30000), so
// search() filters the complete catalog client-side rather than a capped
// subset. A hand-written register() (not defineRest) because the limit
// needs to be applied after client-side filtering, which defineRest's
// per-item normalize() has no access to (it only sees the query, not the
// requested limit).
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const INDICATOR_LIST_URL = 'https://api.worldbank.org/v2/indicator?format=json&per_page=30000';
const LIST_TIMEOUT_MS = 30000; // the full catalog response is ~15 MB

interface WBIndicator {
  id: string;
  name: string;
  sourceNote?: string;
  topics?: Array<{ value?: string }>;
}
type WBIndicatorListResponse = [{ total?: number }, WBIndicator[] | null];

interface WBObservation {
  indicator: { id: string; value: string };
  country: { id: string; value: string };
  date: string;
  value: number | null;
}
type WBSeriesResponse = [{ total?: number }, WBObservation[] | null];

// The ~15 MB catalog is downloaded once per process and reused by every
// search() call, the same lazy-cached-promise convention as
// peps.ts/w3c.ts/census.ts for a source with no server-side search: without
// this, two distinct queries in the same process each re-download the whole
// catalog. Reset on rejection so a failed download doesn't poison every
// later call in the process.
let cachedIndicators: Promise<WBIndicator[]> | undefined;

function downloadIndicators(): Promise<WBIndicator[]> {
  if (!cachedIndicators) {
    cachedIndicators = fetchJSON<WBIndicatorListResponse>(INDICATOR_LIST_URL, {}, LIST_TIMEOUT_MS)
      .then((data) => data[1] ?? [])
      .catch((err) => {
        cachedIndicators = undefined;
        throw err;
      });
  }
  return cachedIndicators;
}

export function matchesIndicator(item: WBIndicator, query: string): boolean {
  const haystack = `${item.name} ${item.sourceNote ?? ''}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => haystack.includes(t));
}

export function normalizeWorldbankIndicator(item: WBIndicator): LibraryResult {
  return {
    id: item.id,
    source: 'worldbank',
    title: item.name,
    authors: [],
    subjects: (item.topics ?? []).map((t) => t.value).filter((v): v is string => Boolean(v)),
    hasFullText: true,
    previewUrl: `https://data.worldbank.org/indicator/${item.id}`,
    description: item.sourceNote?.slice(0, 300),
  };
}

export async function worldbankSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const indicators = await downloadIndicators();
  const matched = indicators.filter((item) => matchesIndicator(item, query));
  return matched.slice(0, limit).map(normalizeWorldbankIndicator);
}

export async function worldbankRead(
  id: string,
): Promise<{ text: string; title: string; authors: string[] }> {
  const data = await fetchJSON<WBSeriesResponse>(
    `https://api.worldbank.org/v2/country/all/indicator/${encodeURIComponent(id)}?format=json&mrv=10&per_page=5000`,
  );
  const rows = (data[1] ?? []).filter((r) => r.value !== null);
  if (rows.length === 0) throw new Error(`World Bank indicator not found or has no data: ${id}`);
  const title = rows[0].indicator.value;
  const text = rows.map((r) => `${r.country.value} (${r.date}): ${r.value}`).join('\n');
  return { title, authors: [], text };
}

register('worldbank', {
  description:
    'World Bank Indicators API v2: 29.5k+ development indicators (GDP, poverty, health, education, and more) across every country. No server-side search - search() filters the full indicator catalog client-side by name/description match. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'static',
  homepage: 'https://data.worldbank.org',
  verifiedAt: '2026-09-03',
  timeoutMs: LIST_TIMEOUT_MS,
  search: worldbankSearch,
  async read(id): Promise<ReadResult> {
    const raw = await worldbankRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
