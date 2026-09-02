// HUD Fair Market Rents (FMR) API. search() only accepts a 5-digit ZIP code
// or a 2-letter state code, per the task-4.3 brief; anything else returns
// [] with the expected format explained in the description. Requires a
// bearer HUD_API_TOKEN.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://www.huduser.gov/hudapi/public/fmr/data';
const ZIP_OR_STATE = /^(\d{5}|[A-Za-z]{2})$/;

interface HudBasicData {
  zip_code?: string;
  town_name?: string;
  metro_name?: string;
  Efficiency?: number;
  'One-Bedroom'?: number;
  'Two-Bedroom'?: number;
  'Three-Bedroom'?: number;
  'Four-Bedroom'?: number;
}

interface HudFmrResponse {
  data?: {
    year?: string;
    basicdata?: HudBasicData | HudBasicData[];
  };
}

function token(): string {
  const t = process.env.HUD_API_TOKEN;
  if (!t) throw new Error('hud requires HUD_API_TOKEN');
  return t;
}

function currentYear(): number {
  return new Date().getUTCFullYear();
}

function firstBasicData(data: HudFmrResponse): HudBasicData | undefined {
  const basic = data.data?.basicdata;
  if (!basic) return undefined;
  return Array.isArray(basic) ? basic[0] : basic;
}

export function normalizeHud(q: string, data: HudFmrResponse): LibraryResult | null {
  const basic = firstBasicData(data);
  if (!basic) return null;
  const year = data.data?.year ?? String(currentYear());
  return {
    id: `${q}:${year}`,
    source: 'hud',
    title: `Fair Market Rents: ${basic.town_name ?? basic.metro_name ?? q} (${year})`,
    authors: [],
    year: Number(year) || undefined,
    hasFullText: true,
    description: `2BR FMR: $${basic['Two-Bedroom'] ?? 'n/a'}`,
  };
}

function rentText(q: string, data: HudFmrResponse): string {
  const basic = firstBasicData(data);
  if (!basic) return `No FMR data found for ${q}.`;
  return [
    `Area: ${basic.town_name ?? basic.metro_name ?? q}`,
    `Efficiency: $${basic.Efficiency ?? 'n/a'}`,
    `One-Bedroom: $${basic['One-Bedroom'] ?? 'n/a'}`,
    `Two-Bedroom: $${basic['Two-Bedroom'] ?? 'n/a'}`,
    `Three-Bedroom: $${basic['Three-Bedroom'] ?? 'n/a'}`,
    `Four-Bedroom: $${basic['Four-Bedroom'] ?? 'n/a'}`,
  ].join('\n');
}

export async function hudSearch(query: string, _limit: number): Promise<LibraryResult[]> {
  const bearer = token();
  const q = query.trim();
  if (!ZIP_OR_STATE.test(q)) return [];
  const data = await fetchJSON<HudFmrResponse>(
    `${BASE}/${encodeURIComponent(q)}?year=${currentYear()}`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  );
  const normalized = normalizeHud(q, data);
  return normalized ? [normalized] : [];
}

export async function hudRead(id: string): Promise<ReadResult> {
  const bearer = token();
  const q = id.split(':')[0];
  const data = await fetchJSON<HudFmrResponse>(
    `${BASE}/${encodeURIComponent(q)}?year=${currentYear()}`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  );
  const basic = firstBasicData(data);
  return {
    title: basic ? `Fair Market Rents: ${basic.town_name ?? basic.metro_name ?? q}` : id,
    authors: [],
    year: data.data?.year ? Number(data.data.year) : undefined,
    ...truncateText(rentText(q, data)),
  };
}

register('hud', {
  description:
    'HUD Fair Market Rents (FMR): US rental cost benchmarks by area, used to set Section 8 voucher payment standards. The query must be a 5-digit ZIP code or a 2-letter state code; any other query returns no results. Requires a bearer HUD_API_TOKEN.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'real_estate',
  freshness: 'daily',
  homepage: 'https://www.huduser.gov/portal/dataset/fmr-api.html',
  auth: { type: 'bearer', env: 'HUD_API_TOKEN' },
  search: hudSearch,
  read: hudRead,
});
