// BLS (Bureau of Labor Statistics) Public Data API v2: US labor and price
// statistics (unemployment, CPI, PPI, wages, productivity, JOLTS). BLS has
// no text-search endpoint over its ~40k series, so search() matches a
// bundled list of the most commonly requested series ids/names (the same
// shape brief 06 asks for) rather than querying anything live. read()
// POSTs to the v2 timeseries endpoint for the requested series.
//
// Verified live 2026-09-03: the v2 endpoint answers a `registrationkey`-
// less POST with the same shape and data as with one (BLS's public-facing
// v1 endpoint is functionally the same request without the v2-only
// optional fields) - so this always POSTs to v2, folding in
// BLS_API_KEY's registrationkey only when set, rather than also
// maintaining a separate v1 code path for the keyless case.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const TIMESERIES_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';

// A representative slice of BLS's most-requested series (unemployment,
// inflation, employment, wages, productivity, JOLTS) - not exhaustive.
// Each id verified live 2026-09-03 to return real data via the endpoint
// below.
const BUNDLED_SERIES: Array<{ id: string; name: string }> = [
  { id: 'LNS14000000', name: 'Unemployment rate, seasonally adjusted' },
  { id: 'LNS14000001', name: 'Unemployment rate, men 20 years and over' },
  { id: 'LNS14000002', name: 'Unemployment rate, women 20 years and over' },
  { id: 'LNS14000003', name: 'Unemployment rate, White' },
  { id: 'LNS14000006', name: 'Unemployment rate, Black or African American' },
  { id: 'LNS11300000', name: 'Labor force participation rate' },
  { id: 'LNS12300000', name: 'Employment-population ratio' },
  { id: 'CUUR0000SA0', name: 'Consumer Price Index (CPI-U), all items, U.S. city average' },
  {
    id: 'CUUR0000SA0L1E',
    name: 'Consumer Price Index (CPI-U), all items less food and energy (core CPI)',
  },
  { id: 'CUUR0000SEHA', name: 'Consumer Price Index (CPI-U), rent of primary residence' },
  { id: 'WPUFD4', name: 'Producer Price Index (PPI), final demand' },
  { id: 'EIUIR', name: 'Import Price Index, all commodities' },
  { id: 'EIUIR100', name: 'Export Price Index, all commodities' },
  { id: 'CES0000000001', name: 'Total nonfarm employment, all employees' },
  { id: 'CES3000000001', name: 'Manufacturing employment, all employees' },
  { id: 'CES0500000003', name: 'Average hourly earnings, all employees, total private' },
  { id: 'PRS85006092', name: 'Nonfarm business sector labor productivity' },
  { id: 'CIU1010000000000A', name: 'Employment Cost Index, total compensation, civilian workers' },
  { id: 'JTS000000000000000JOL', name: 'Job openings, total nonfarm (JOLTS)' },
  { id: 'JTS000000000000000QUL', name: 'Quits, total nonfarm (JOLTS)' },
];

function registrationKey(): string | undefined {
  return process.env.BLS_API_KEY;
}

interface BlsFootnote {
  code?: string;
  text?: string;
}
interface BlsDataPoint {
  year: string;
  period: string;
  periodName: string;
  value: string;
  footnotes?: BlsFootnote[];
}
interface BlsSeries {
  seriesID: string;
  data?: BlsDataPoint[];
}
interface BlsResponse {
  status: string;
  message?: string[];
  Results?: { series?: BlsSeries[] };
}

export function normalizeBlsSeries(entry: { id: string; name: string }): LibraryResult {
  return {
    id: entry.id,
    source: 'bls',
    title: entry.name,
    authors: [],
    hasFullText: true,
    previewUrl: `https://data.bls.gov/timeseries/${encodeURIComponent(entry.id)}`,
  };
}

export function searchBundledSeries(
  query: string,
  limit: number,
): Array<{ id: string; name: string }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return BUNDLED_SERIES.filter((s) => {
    const haystack = s.name.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  }).slice(0, limit);
}

export async function blsSearch(query: string, limit: number): Promise<LibraryResult[]> {
  return searchBundledSeries(query, limit).map(normalizeBlsSeries);
}

// Twenty years is BLS's own per-request span cap; the "current year" here
// is real wall-clock time, not (yet) the id's own most recent data point.
function defaultYearRange(): { startyear: string; endyear: string } {
  const end = new Date().getFullYear();
  return { startyear: String(end - 19), endyear: String(end) };
}

export async function blsRead(id: string): Promise<ReadResult> {
  const { startyear, endyear } = defaultYearRange();
  const key = registrationKey();
  const body: Record<string, unknown> = { seriesid: [id], startyear, endyear };
  if (key) body.registrationkey = key;

  const data = await fetchJSON<BlsResponse>(TIMESERIES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const series = data.Results?.series?.[0];
  const points = series?.data ?? [];
  if (!series || points.length === 0) throw new Error(`BLS series not found: ${id}`);

  const known = BUNDLED_SERIES.find((s) => s.id === id);
  const text = points.map((p) => `${p.periodName} ${p.year}: ${p.value}`).join('\n');

  return {
    title: known?.name ?? id,
    authors: [],
    ...truncateText(text),
  };
}

register('bls', {
  description:
    'BLS (Bureau of Labor Statistics) Public Data API v2: US labor and price statistics (unemployment, CPI, PPI, wages, productivity, JOLTS). No text search exists upstream; search() matches a bundled list of common series. Works keyless (conservative daily cap); set BLS_API_KEY for the registered 500/day tier.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://www.bls.gov/developers/',
  verifiedAt: '2026-09-03',
  optionalEnv: ['BLS_API_KEY'],
  // Keyless BLS access is documented at 25 requests/day (the v1 rate,
  // which the keyless v2 request in blsRead's comment above matches in
  // practice); a registered BLS_API_KEY raises it to 500/day.
  //
  // Final wave (F2): this used to be a flat 25 while the description above
  // promised the 500/day tier with a key - so an operator who set the key
  // got a quarter-of-a-percent of the throughput they were told they had,
  // silently, with the cap doing the throttling. Computed from the env at
  // module load, which is when the registry reads `pacing` (see
  // registry.ts's register()), the same way every other adapter reads its
  // key: setting BLS_API_KEY after the process starts has never taken
  // effect for anything and does not here either.
  pacing: { dailyCap: registrationKey() ? 500 : 25 },
  search: blsSearch,
  read: blsRead,
});
