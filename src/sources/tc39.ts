// TC39 (ECMAScript) proposals: a single JSON document, downloaded once per
// process and filtered client-side by token match, the static-download
// convention shared with kev.ts, attack.ts, peps.ts and swiftevolution.ts.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

const URL = 'https://tc39.es/dataset/proposals.json';
const TIMEOUT_MS = 20000;

interface Tc39Proposal {
  id: string;
  name: string;
  description?: string;
  stage: number | string;
  authors?: string | string[];
  url: string;
}

let cached: Promise<Tc39Proposal[]> | undefined;

function download(): Promise<Tc39Proposal[]> {
  if (!cached) {
    cached = fetchJSON<Tc39Proposal[]>(URL, {}, TIMEOUT_MS).catch((err) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

function matches(p: Tc39Proposal, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${p.name} ${p.description ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

function authorList(authors: string | string[] | undefined): string[] {
  if (!authors) return [];
  return Array.isArray(authors) ? authors : [authors];
}

export function normalizeTc39(p: Tc39Proposal): LibraryResult {
  return {
    id: p.id,
    source: 'tc39',
    title: p.name,
    authors: authorList(p.authors),
    hasFullText: Boolean(p.description),
    description: p.description ? `Stage ${p.stage}: ${p.description}` : `Stage ${p.stage}`,
    url: p.url,
  };
}

export async function tc39Search(query: string, limit: number): Promise<LibraryResult[]> {
  const proposals = await download();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return proposals
    .filter((p) => matches(p, tokens))
    .slice(0, limit)
    .map(normalizeTc39);
}

export async function tc39Read(id: string): Promise<ReadResult> {
  const proposals = await download();
  const p = proposals.find((proposal) => proposal.id === id);
  if (!p) throw new Error(`tc39: proposal ${id} not found`);
  return {
    title: p.name,
    authors: authorList(p.authors),
    metadataOnly: true,
    externalUrl: p.url,
    note: p.description ? `Stage ${p.stage}: ${p.description}` : `Stage ${p.stage}`,
  };
}

register('tc39', {
  description:
    'TC39 (ECMAScript) proposals: every JavaScript language proposal with its current stage. Downloaded once per process and filtered client-side; there is no per-query search API. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://tc39.es',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: tc39Search,
  read: tc39Read,
});
