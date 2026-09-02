// UN Comtrade: international merchandise trade statistics. search() only
// accepts an HS (Harmonized System) commodity code, e.g. "0101" or "010121";
// anything else returns [] with the expected format explained in the
// description, per the task-4.3 brief. The default path is the keyless
// public preview endpoint; UN_COMTRADE_KEY, if present, is sent as
// Ocp-Apim-Subscription-Key (needed only for the full /data/v1/get/
// endpoint, which this adapter does not call).
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const BASE = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const HS_CODE = /^\d{2,10}$/;

interface ComtradeRow {
  reporterCode?: number;
  partnerCode?: number;
  cmdCode?: string;
  period?: string;
  primaryValue?: number;
  netWgt?: number;
}

interface ComtradeResponse {
  count?: number;
  data?: ComtradeRow[];
}

const subscriptionKey = process.env.UN_COMTRADE_KEY;
const headers = subscriptionKey ? { 'Ocp-Apim-Subscription-Key': subscriptionKey } : undefined;

function previousYear(): number {
  return new Date().getUTCFullYear() - 1;
}

export function normalizeComtrade(row: ComtradeRow): LibraryResult | null {
  if (!row.cmdCode || !row.period) return null;
  return {
    id: `${row.reporterCode ?? 0}-${row.partnerCode ?? 0}-${row.cmdCode}-${row.period}`,
    source: 'comtrade',
    title: `HS ${row.cmdCode}: reporter ${row.reporterCode ?? '?'} -> partner ${row.partnerCode ?? '?'} (${row.period})`,
    authors: [],
    year: Number(row.period) || undefined,
    hasFullText: true,
    description: `Trade value: $${row.primaryValue ?? 0}, net weight: ${row.netWgt ?? 0}kg`,
  };
}

export async function comtradeSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const cmdCode = query.trim();
  if (!HS_CODE.test(cmdCode)) return [];
  const period = previousYear();
  const data = await fetchJSON<ComtradeResponse>(
    `${BASE}?reporterCode=&cmdCode=${encodeURIComponent(cmdCode)}&period=${period}`,
    { headers },
  );
  const rows: LibraryResult[] = [];
  for (const row of data.data ?? []) {
    const normalized = normalizeComtrade(row);
    if (normalized) rows.push(normalized);
    if (rows.length >= limit) break;
  }
  return rows;
}

export async function comtradeRead(id: string): Promise<ReadResult> {
  const [reporterCode, partnerCode, cmdCode, period] = id.split('-');
  const data = await fetchJSON<ComtradeResponse>(
    `${BASE}?reporterCode=&cmdCode=${encodeURIComponent(cmdCode)}&period=${period}`,
    { headers },
  );
  const row = (data.data ?? []).find(
    (r) => String(r.reporterCode ?? 0) === reporterCode && String(r.partnerCode ?? 0) === partnerCode,
  );
  if (!row) {
    return { title: id, authors: [], ...truncateText(`No Comtrade row found for ${id}.`) };
  }
  const text = `HS ${row.cmdCode} (${row.period})\nReporter: ${row.reporterCode}\nPartner: ${row.partnerCode}\nTrade value (USD): ${row.primaryValue}\nNet weight (kg): ${row.netWgt}`;
  return { title: id, authors: [], ...truncateText(text) };
}

register('comtrade', {
  description:
    'UN Comtrade: international merchandise trade statistics by HS (Harmonized System) commodity code. The query must be an HS code (e.g. "0101" or "010121"); any other query returns no results. Uses the keyless public preview endpoint by default.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://comtradeplus.un.org',
  verifiedAt: '2026-09-01',
  pacing: { dailyCap: 450 },
  search: comtradeSearch,
  read: comtradeRead,
});
