// Swift Evolution proposals: a single JSON document, downloaded once per
// process and filtered client-side by token match, the static-download
// convention shared with kev.ts, attack.ts, peps.ts and tc39.ts.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

const URL = 'https://download.swift.org/swift-evolution/v1/evolution.json';
const TIMEOUT_MS = 20000;

interface SwiftAuthor {
  name: string;
}

interface SwiftProposal {
  id: string;
  title: string;
  authors?: SwiftAuthor[];
  status?: { state: string; version?: string };
  link?: string;
  summary?: string;
}

interface SwiftEvolutionResponse {
  proposals: SwiftProposal[];
}

let cached: Promise<SwiftProposal[]> | undefined;

function download(): Promise<SwiftProposal[]> {
  if (!cached) {
    cached = fetchJSON<SwiftEvolutionResponse>(URL, {}, TIMEOUT_MS)
      .then((data) => data.proposals ?? [])
      .catch((err) => {
        cached = undefined;
        throw err;
      });
  }
  return cached;
}

function proposalUrl(p: SwiftProposal): string {
  return p.link
    ? `https://github.com/swiftlang/swift-evolution/blob/main/proposals/${p.link}`
    : 'https://www.swift.org/swift-evolution';
}

function matches(p: SwiftProposal, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${p.id} ${p.title} ${p.summary ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function normalizeSwiftEvolution(p: SwiftProposal): LibraryResult {
  return {
    id: p.id,
    source: 'swiftevolution',
    title: p.title,
    authors: (p.authors ?? []).map((a) => a.name),
    hasFullText: Boolean(p.summary),
    description: p.status ? `Status: ${p.status.state}` : undefined,
    url: proposalUrl(p),
  };
}

export async function swiftEvolutionSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const proposals = await download();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return proposals
    .filter((p) => matches(p, tokens))
    .slice(0, limit)
    .map(normalizeSwiftEvolution);
}

export async function swiftEvolutionRead(id: string): Promise<ReadResult> {
  const proposals = await download();
  const p = proposals.find((proposal) => proposal.id === id);
  if (!p) throw new Error(`swiftevolution: proposal ${id} not found`);
  return {
    title: p.title,
    authors: (p.authors ?? []).map((a) => a.name),
    metadataOnly: true,
    externalUrl: proposalUrl(p),
    note: p.status ? `Status: ${p.status.state}` : 'No status available.',
  };
}

register('swiftevolution', {
  description:
    'Swift Evolution proposals: every accepted, rejected, or in-review Swift language proposal with its status. Downloaded once per process and filtered client-side; there is no per-query search API. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://www.swift.org/swift-evolution',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: swiftEvolutionSearch,
  read: swiftEvolutionRead,
});
