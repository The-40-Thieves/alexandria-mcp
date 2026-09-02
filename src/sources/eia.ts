// US Energy Information Administration (EIA) API v2. Requires EIA_API_KEY.
// v2 has no documented keyword-search endpoint (GET /v2/search returns 404
// as of 2026-09-01, confirmed by probing live); when the query doesn't look
// like a series id, search() falls back to the brief's documented
// alternative: EIA's own route listing (GET /v2/) filtered by name, since
// that's the only browsable catalog v2 exposes without a series id already
// in hand.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://api.eia.gov/v2';

function key(): string {
  const k = process.env.EIA_API_KEY;
  if (!k) throw new Error('eia requires EIA_API_KEY');
  return k;
}

interface EiaRoute {
  id: string;
  name: string;
  description?: string;
}

interface EiaRouteListResponse {
  response?: { routes?: EiaRoute[] };
}

interface EiaSeriesPoint {
  period: string;
  series?: string;
  'series-description'?: string;
  value?: number;
  units?: string;
}

interface EiaSeriesResponse {
  response?: { data?: EiaSeriesPoint[] };
}

// A series id looks like "PET.MCRFPUS2.M": at least one dot-separated
// segment, unlike a route id ("petroleum") or a free-text query.
function looksLikeSeriesId(q: string): boolean {
  return q.includes('.');
}

export function normalizeEiaRoute(route: EiaRoute): LibraryResult {
  return {
    id: route.id,
    source: 'eia',
    title: route.name,
    authors: [],
    hasFullText: false,
    description: route.description,
  };
}

export function normalizeEiaSeries(seriesId: string, points: EiaSeriesPoint[]): LibraryResult {
  const latest = points[0];
  return {
    id: seriesId,
    source: 'eia',
    title: latest?.['series-description'] || seriesId,
    authors: [],
    hasFullText: points.length > 0,
    description: latest ? `${latest.value} ${latest.units ?? ''} (${latest.period})` : undefined,
  };
}

function matchesRoute(route: EiaRoute, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${route.id} ${route.name} ${route.description ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export async function eiaSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const apiKey = key();
  if (looksLikeSeriesId(query)) {
    const data = await fetchJSON<EiaSeriesResponse>(
      `${BASE}/seriesid/${encodeURIComponent(query)}?api_key=${apiKey}`,
    );
    const points = data.response?.data ?? [];
    return points.length > 0 ? [normalizeEiaSeries(query, points)] : [];
  }
  const data = await fetchJSON<EiaRouteListResponse>(`${BASE}/?api_key=${apiKey}`);
  const routes = data.response?.routes ?? [];
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return routes
    .filter((r) => matchesRoute(r, tokens))
    .slice(0, limit)
    .map(normalizeEiaRoute);
}

export async function eiaRead(id: string): Promise<ReadResult> {
  const apiKey = key();
  if (!looksLikeSeriesId(id)) {
    const data = await fetchJSON<EiaRouteListResponse>(`${BASE}/${id}/?api_key=${apiKey}`);
    const routes = data.response?.routes ?? [];
    const text = routes.length
      ? routes.map((r) => `${r.id}: ${r.name}${r.description ? ` - ${r.description}` : ''}`).join('\n')
      : `No sub-routes found under ${id}.`;
    return { title: id, authors: [], ...truncateText(text) };
  }
  const data = await fetchJSON<EiaSeriesResponse>(`${BASE}/seriesid/${encodeURIComponent(id)}?api_key=${apiKey}`);
  const points = (data.response?.data ?? []).slice(0, 30);
  if (points.length === 0) {
    return { title: id, authors: [], ...truncateText(`No data found for series ${id}.`) };
  }
  const title = points[0]['series-description'] || id;
  const rows = points.map((p) => `${p.period}  ${p.value} ${p.units ?? ''}`);
  return { title, authors: [], ...truncateText(rows.join('\n')) };
}

register('eia', {
  description:
    'US Energy Information Administration (EIA) API v2: energy production, consumption, and pricing series. A dotted query (e.g. "PET.MCRFPUS2.M") looks up a series directly; otherwise search() filters EIA\'s route catalog by name (v2 has no keyword-search endpoint). Requires free EIA_API_KEY.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://www.eia.gov/opendata',
  auth: { type: 'query', env: 'EIA_API_KEY', param: 'api_key' },
  search: eiaSearch,
  read: eiaRead,
});
