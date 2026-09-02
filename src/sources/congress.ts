// congress.gov API v3: US federal bill search and text. There is no /v3/search
// endpoint (probed live: 404 "Unknown resource: search"; confirmed against
// the project's own ChangeLog.md, which never documents one either), and
// /v3/bill's q= parameter is silently ignored (probed live: identical
// results with and without it), so search() instead lists the most
// recently updated bills and filters by title token client-side, per the
// task-4.4 brief's documented fallback.
//
// Shares the api.data.gov key family with GovInfo and Regulations.gov:
// DATA_GOV_API_KEY is read first, GOVINFO_API_KEY second, so an owner who
// only registered a GovInfo key still gets Congress and Regulations. The
// registry's generic AuthSpec only carries one env var, so `auth.env`
// names the primary (DATA_GOV_API_KEY) for documentation/probe purposes,
// and `hidden` is set explicitly here to reflect the two-env fallback
// registry.register()'s default single-env hidden check can't express.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://api.congress.gov/v3';

function key(): string {
  const k = process.env.DATA_GOV_API_KEY || process.env.GOVINFO_API_KEY;
  if (!k) throw new Error('congress requires DATA_GOV_API_KEY (or GOVINFO_API_KEY)');
  return k;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface CongressBill {
  congress: number;
  type: string;
  number: string;
  title: string;
  introducedDate?: string;
  updateDate?: string;
  latestAction?: { actionDate?: string; text?: string };
}

interface CongressBillListResponse {
  bills?: CongressBill[];
}

interface CongressTextFormat {
  type: string;
  url: string;
}

interface CongressTextVersion {
  type: string;
  date?: string;
  formats?: CongressTextFormat[];
}

interface CongressTextResponse {
  textVersions?: CongressTextVersion[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

export function billId(bill: CongressBill): string {
  return `${bill.congress}-${bill.type.toLowerCase()}-${bill.number}`;
}

export function normalizeCongressBill(bill: CongressBill): LibraryResult {
  return {
    id: billId(bill),
    source: 'congress',
    title: bill.title,
    authors: [],
    year: yearOf(bill.introducedDate ?? bill.updateDate),
    hasFullText: true,
    description: bill.latestAction?.text,
    published: bill.latestAction?.actionDate,
  };
}

function matchesTitle(bill: CongressBill, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = bill.title.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export async function congressSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const apiKey = key();
  const data = await fetchJSON<CongressBillListResponse>(
    `${BASE}/bill?sort=updateDate+desc&limit=250&api_key=${apiKey}`,
  );
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (data.bills ?? [])
    .filter((b) => matchesTitle(b, tokens))
    .slice(0, limit)
    .map(normalizeCongressBill);
}

export async function congressRead(id: string): Promise<ReadResult> {
  const apiKey = key();
  const [congress, type, number] = id.split('-');
  const data = await fetchJSON<CongressTextResponse>(
    `${BASE}/bill/${congress}/${type}/${number}/text?api_key=${apiKey}`,
  );
  const first = data.textVersions?.[0];
  const formattedText = first?.formats?.find((f) => f.type === 'Formatted Text');
  if (!formattedText) {
    return { title: id, authors: [], ...truncateText(`No text version found for bill ${id}.`) };
  }
  const html = await fetchText(formattedText.url);
  return { title: id, authors: [], year: yearOf(first?.date), ...truncateText(stripHtml(html)) };
}

register('congress', {
  description:
    "congress.gov API v3: US federal bill search and full text. There is no /v3/search endpoint and /v3/bill's q= parameter is ignored, so search() filters the most recently updated bills by title token. Shares the api.data.gov key family: reads DATA_GOV_API_KEY first, GOVINFO_API_KEY second.",
  supportsIngest: true,
  kind: 'rest',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://api.congress.gov',
  auth: { type: 'query', env: 'DATA_GOV_API_KEY', param: 'api_key' },
  hidden: !(process.env.DATA_GOV_API_KEY || process.env.GOVINFO_API_KEY),
  search: congressSearch,
  read: congressRead,
});
