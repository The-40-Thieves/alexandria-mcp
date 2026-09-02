// FIRST.org EPSS: Exploit Prediction Scoring System. Only accepts a single
// CVE id as a query; anything else returns [] rather than a meaningless
// unfiltered score list. No API key required.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const BASE = 'https://api.first.org/data/v1/epss';
const CVE_PATTERN = /^CVE-\d{4}-\d+$/i;

interface EpssScore {
  cve: string;
  epss: string;
  percentile: string;
  date?: string;
}

interface EpssResponse {
  data?: EpssScore[];
}

export function normalizeEpss(score: EpssScore): LibraryResult {
  return {
    id: score.cve,
    source: 'epss',
    title: `${score.cve} EPSS ${score.epss} percentile ${score.percentile}`,
    authors: [],
    hasFullText: true,
    description: `EPSS score ${score.epss} (percentile ${score.percentile}) as of ${score.date ?? 'unknown date'}.`,
    published: score.date,
  };
}

async function fetchScore(cve: string): Promise<EpssScore | undefined> {
  const data = await fetchJSON<EpssResponse>(`${BASE}?cve=${encodeURIComponent(cve)}`);
  return data.data?.[0];
}

export async function epssSearch(query: string, _limit: number): Promise<LibraryResult[]> {
  const trimmed = query.trim();
  if (!CVE_PATTERN.test(trimmed)) return [];
  const score = await fetchScore(trimmed);
  return score ? [normalizeEpss(score)] : [];
}

export async function epssRead(id: string): Promise<ReadResult> {
  const score = await fetchScore(id);
  if (!score) throw new Error(`epss: no score found for ${id}`);
  return {
    title: `${score.cve} EPSS ${score.epss}`,
    authors: [],
    text: `EPSS score ${score.epss}, percentile ${score.percentile}, as of ${score.date ?? 'unknown date'}.`,
  };
}

register('epss', {
  description:
    'FIRST.org EPSS: the Exploit Prediction Scoring System, a probability (0-1) that a CVE will be exploited in the next 30 days. Query as a single CVE id (e.g. CVE-2021-44228); anything else returns []. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'security',
  freshness: 'daily',
  homepage: 'https://www.first.org/epss',
  verifiedAt: '2026-09-01',
  search: epssSearch,
  read: epssRead,
});
