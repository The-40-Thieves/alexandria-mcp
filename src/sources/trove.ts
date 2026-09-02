import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { register } from './registry.ts';

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

// The work-record schema (per Trove's API technical guide): identifiers
// carry a link type: "fulltext" is the one worth following. They show up
// both at the work level and per-version.
interface TroveIdentifier {
  type?: string;
  linktype?: string;
  value?: string; // the URL itself
}
interface TroveVersion {
  identifier?: TroveIdentifier[];
}
interface TroveWorkRecord {
  id: string;
  title?: string;
  contributor?: string[];
  issued?: string;
  language?: string[];
  subject?: string[];
  identifier?: TroveIdentifier[];
  version?: TroveVersion[];
}
interface TroveWorkResponse {
  work?: TroveWorkRecord;
}

interface TroveNewspaperArticle {
  id: string;
  heading?: string;
  articleText?: string;
}
interface TroveNewspaperResponse {
  article?: TroveNewspaperArticle;
}

function stripArticleHtml(html: string): string {
  return html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Trove's canonical newspaper article URL is
// https://trove.nla.gov.au/newspaper/article/{articleId}, and the
// article's own record id (e.g. "nla.news-article18341291") embeds the
// same number; look for either form among a work's fulltext identifiers.
function findNewspaperArticleId(record: TroveWorkRecord): string | undefined {
  const allIdentifiers = [
    ...(record.identifier ?? []),
    ...(record.version ?? []).flatMap((v) => v.identifier ?? []),
  ];
  for (const ident of allIdentifiers) {
    if (ident.linktype !== 'fulltext' || !ident.value) continue;
    const m =
      ident.value.match(/newspaper\/article\/(\d+)/) ?? ident.value.match(/nla\.news-article(\d+)/);
    if (m) return m[1];
  }
  return undefined;
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

interface TroveReadResult {
  title: string;
  authors: string[];
  text?: string;
  metadataOnly?: boolean;
  externalUrl: string;
  note?: string;
}

function metadataOnlyRead(id: string, title?: string, authors?: string[]): TroveReadResult {
  return {
    title: title ?? id,
    authors: authors ?? [],
    metadataOnly: true,
    externalUrl: `https://trove.nla.gov.au/work/${id}`,
    note: 'Trove provides digitized Australian content. Full text available for many items via externalUrl.',
  };
}

export async function troveRead(id: string): Promise<TroveReadResult> {
  const key = process.env.TROVE_API_KEY;
  // No key: keep the pre-Stage-2 metadata-only shape exactly (no NLA calls
  // at all, nothing to cap against recordFullTextRead()).
  if (!key) return metadataOnlyRead(id);

  const params = new URLSearchParams({
    encoding: 'json',
    include: 'all',
    reclevel: 'full',
    key,
  });
  const data = await fetchJSON<TroveWorkResponse>(`${API}/work/${id}?${params}`);
  const work = data.work;
  if (!work) return metadataOnlyRead(id);

  const articleId = findNewspaperArticleId(work);
  if (articleId) {
    try {
      const artParams = new URLSearchParams({
        include: 'articletext',
        encoding: 'json',
        key,
      });
      const artData = await fetchJSON<TroveNewspaperResponse>(
        `${API}/newspaper/${articleId}?${artParams}`,
      );
      const rawText = artData.article?.articleText;
      if (rawText) {
        const text = stripArticleHtml(rawText);
        if (text.length > 20) {
          // Full text is actually being returned to the caller; count it
          // against the NLA data-agreement session cap.
          recordFullTextRead();
          return {
            text,
            title: artData.article?.heading ?? work.title ?? id,
            authors: work.contributor ?? [],
            externalUrl: `https://trove.nla.gov.au/newspaper/article/${articleId}`,
          };
        }
      }
    } catch {
      /* fall through to metadata-only below */
    }
  }

  return metadataOnlyRead(id, work.title, work.contributor);
}

register('trove', {
  description:
    'Trove (NLA Australia): 340M+ items from Australian libraries, newspapers, archives. Requires free TROVE_API_KEY. Full text is fetched only for newspaper articles that carry a fulltext link; other categories stay metadata-only. Governed by an NLA data agreement: live calls only, no storage, capped full-text reads per session.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'archives',
  freshness: 'daily',
  homepage: 'https://trove.nla.gov.au',
  verifiedAt: '2026-09-01',
  auth: { type: 'query', env: 'TROVE_API_KEY', param: 'key' },
  search: troveSearch,
  async read(id) {
    return troveRead(id);
  },
});
