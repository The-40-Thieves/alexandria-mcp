import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

// Full-text retrieval from Trove is governed by a data agreement with the
// National Library of Australia (enquiry RSref185776): live calls only, no
// storage, no bulk retrieval, and a software cap on full-text fetches per
// session. The cap below enforces that commitment for read(); search()
// returns metadata only and is not counted. Keep supportsIngest: false so
// Trove text can never enter the ingest pipeline.
const FULLTEXT_CAP = Number(process.env.TROVE_FULLTEXT_CAP ?? 25);
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

let windowStart = Date.now();
let fullTextReads = 0;

/** Count one full-text read; throws once the per-session cap is reached. */
export function recordFullTextRead(now = Date.now()): number {
  if (now - windowStart >= SESSION_WINDOW_MS) {
    windowStart = now;
    fullTextReads = 0;
  }
  if (fullTextReads >= FULLTEXT_CAP) {
    throw new Error(
      `Trove full-text cap reached (${FULLTEXT_CAP} per session) — per the NLA data agreement. ` +
        'Open the record on trove.nla.gov.au via externalUrl, or wait for the window to reset.',
    );
  }
  fullTextReads += 1;
  return fullTextReads;
}

/** Test hook: reset the session counter. */
export function resetFullTextWindow(now = Date.now()): void {
  windowStart = now;
  fullTextReads = 0;
}

const API = 'https://api.trove.nla.gov.au/v3';
const KEY_URL = 'https://trove.nla.gov.au/about/create-something/using-api';

function getKey(): string {
  const key = process.env.TROVE_API_KEY;
  if (!key)
    throw new Error(
      `Trove requires a free API key. Register at: ${KEY_URL} then set TROVE_API_KEY in your environment.`,
    );
  return key;
}

interface TroveWork {
  id: string;
  title?: string;
  contributor?: string[];
  issued?: string;
  language?: string[];
  subject?: string[];
  troveUrl?: string;
}

interface TroveResponse {
  category: Array<{ records: { work: TroveWork[] } }>;
}

export async function troveSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    q: query,
    key: getKey(),
    category: 'book',
    n: String(limit),
    encoding: 'json',
    include: 'links',
  });

  const data = await fetchJSON<TroveResponse>(`${API}/result?${params}`);

  const works = data.category?.[0]?.records?.work ?? [];
  return works.slice(0, limit).map((w) => ({
    id: w.id,
    source: 'trove' as const,
    title: w.title ?? w.id,
    authors: w.contributor ?? [],
    year: w.issued ? parseInt(w.issued, 10) : undefined,
    language: w.language?.[0],
    subjects: (w.subject ?? []).slice(0, 5),
    hasFullText: Boolean(w.troveUrl),
    previewUrl: w.troveUrl ?? `https://trove.nla.gov.au/work/${w.id}`,
  }));
}

register('trove', {
  description:
    'Trove (NLA Australia) — 340M+ items from Australian libraries, newspapers, archives. Requires free TROVE_API_KEY.',
  supportsIngest: false,
  search: troveSearch,
  async read(id) {
    // Metadata-only today. When full-text retrieval is enabled under the NLA
    // data agreement, the cap applies to every read that returns text.
    recordFullTextRead();
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: `https://trove.nla.gov.au/work/${id}`,
      note: 'Trove provides digitized Australian content. Full text available for many items via externalUrl.',
    };
  },
});
