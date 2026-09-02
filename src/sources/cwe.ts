// MITRE CWE REST API: single-id weakness lookup, no keyword search endpoint.
// A query that isn't a CWE number (optionally "CWE-"-prefixed) returns [].
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const BASE = 'https://cwe-api.mitre.org/api/v1/cwe/weakness';
const ID_PATTERN = /^(CWE-)?(\d+)$/i;

interface CweWeakness {
  ID: string;
  Name: string;
  Description: string;
}

interface CweWeaknessResponse {
  Weaknesses?: CweWeakness[];
}

export function normalizeCwe(w: CweWeakness): LibraryResult {
  return {
    id: `CWE-${w.ID}`,
    source: 'cwe',
    title: w.Name,
    authors: [],
    hasFullText: Boolean(w.Description),
    description: w.Description,
    previewUrl: `https://cwe.mitre.org/data/definitions/${w.ID}.html`,
  };
}

async function fetchWeakness(n: string): Promise<CweWeakness | undefined> {
  const data = await fetchJSON<CweWeaknessResponse>(`${BASE}/${encodeURIComponent(n)}`);
  return data.Weaknesses?.[0];
}

export async function cweSearch(query: string, _limit: number): Promise<LibraryResult[]> {
  const match = query.trim().match(ID_PATTERN);
  if (!match) return [];
  const weakness = await fetchWeakness(match[2]);
  return weakness ? [normalizeCwe(weakness)] : [];
}

export async function cweRead(id: string): Promise<ReadResult> {
  const match = id.trim().match(ID_PATTERN);
  const n = match ? match[2] : id;
  const weakness = await fetchWeakness(n);
  if (!weakness) throw new Error(`cwe: ${id} not found`);
  return {
    title: weakness.Name,
    authors: [],
    text: weakness.Description,
  };
}

register('cwe', {
  description:
    'MITRE CWE: the Common Weakness Enumeration, a single-id weakness lookup (e.g. CWE-79 or 79); there is no keyword search endpoint, so any other query returns []. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'security',
  freshness: 'static',
  homepage: 'https://cwe.mitre.org',
  verifiedAt: '2026-09-01',
  search: cweSearch,
  read: cweRead,
});
