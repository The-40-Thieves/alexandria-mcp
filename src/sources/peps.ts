// Python Enhancement Proposals: a single JSON document, downloaded once per
// process and filtered client-side by token match against number+title,
// the static-download convention shared with kev.ts, attack.ts, tc39.ts and
// swiftevolution.ts. read() returns metadata only; extracting the PEP body
// HTML awaits the fetchTier web-fetch tier (Stage 6), the same TODO
// convention used by nhk.ts and kinds/rss.ts.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { fetchAsText } from '../web/fetchTier.ts';
import { register, truncateText } from './registry.ts';

const URL = 'https://peps.python.org/api/peps.json';
// Final wave (C2): fetchJSON caps response bodies at 10 MB by default;
// this catalog measured 424,419 bytes on 2026-09-03. Explicit anyway: it
// is a whole-catalog download, and the default is not sized for those.
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 20000;

interface PepEntry {
  number: number;
  title: string;
  author_names?: string[];
  authors?: string;
  created?: string;
  status?: string;
  url: string;
}

type PepsResponse = Record<string, PepEntry>;

let cached: Promise<PepEntry[]> | undefined;

function download(): Promise<PepEntry[]> {
  if (!cached) {
    cached = fetchJSON<PepsResponse>(URL, { maxBytes: CATALOG_MAX_BYTES }, TIMEOUT_MS)
      .then((data) => Object.values(data))
      .catch((err) => {
        cached = undefined;
        throw err;
      });
  }
  return cached;
}

function yearOf(created: string | undefined): number | undefined {
  if (!created) return undefined;
  const year = new Date(created).getFullYear();
  return Number.isFinite(year) ? year : undefined;
}

function matches(pep: PepEntry, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `pep ${pep.number} ${pep.title}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

export function normalizePep(pep: PepEntry): LibraryResult {
  return {
    id: `PEP ${pep.number}`,
    source: 'peps',
    title: pep.title,
    authors: pep.author_names ?? (pep.authors ? [pep.authors] : []),
    year: yearOf(pep.created),
    hasFullText: false,
    published: pep.created,
    url: pep.url,
  };
}

export async function pepsSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const peps = await download();
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return peps
    .filter((p) => matches(p, tokens))
    .slice(0, limit)
    .map(normalizePep);
}

export async function pepsRead(id: string): Promise<ReadResult> {
  const peps = await download();
  const pep = peps.find((p) => `PEP ${p.number}` === id || String(p.number) === id);
  if (!pep) throw new Error(`peps: ${id} not found`);
  const authors = pep.author_names ?? (pep.authors ? [pep.authors] : []);
  // See kinds/rss.ts: a fetch-tier failure degrades to metadata rather
  // than throwing, since the PEP page is ordinary third-party web content.
  try {
    const page = await fetchAsText(pep.url);
    return {
      title: pep.title,
      authors,
      year: yearOf(pep.created),
      externalUrl: pep.url,
      ...truncateText(page.text),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      title: pep.title,
      authors,
      year: yearOf(pep.created),
      metadataOnly: true,
      externalUrl: pep.url,
      note: `Full-text fetch failed; showing metadata only: ${message}`,
    };
  }
}

register('peps', {
  description:
    'Python Enhancement Proposals (PEPs): index of every PEP by number and title. Downloaded once per process and filtered client-side; there is no per-query search API. No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'developer',
  freshness: 'daily',
  homepage: 'https://peps.python.org',
  timeoutMs: TIMEOUT_MS,
  verifiedAt: '2026-09-01',
  search: pepsSearch,
  read: pepsRead,
});
