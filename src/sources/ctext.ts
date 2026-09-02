import pLimit from 'p-limit';
import type { LibraryResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { normaliseWhitespace } from '../utils/text-clean.ts';
import { register, truncateText } from './registry.ts';

// Migrated off the legacy ctext.org/api.pl CGI endpoint (retired) to the
// current api.ctext.org REST API. Ids are now ctp: URNs (e.g. "ctp:analects")
// instead of bare titleids. gettextinfo is keyless; gettext (the actual
// passage text) is restricted to registered IPs or an API key per ctext's
// own docs (https://ctext.org/tools/api); pass CTEXT_API_KEY if set, and
// surface the live "requires authentication" error clearly otherwise.
const API = 'https://api.ctext.org';

function apiKeyParam(): string {
  const key = process.env.CTEXT_API_KEY;
  return key ? `&apikey=${encodeURIComponent(key)}` : '';
}

interface CtextApiError {
  error?: { code: string; description: string };
}

interface CtextSearchResponse extends CtextApiError {
  books?: Array<{ id?: string; title: string; urn: string }>;
}

interface CtextTextInfo extends CtextApiError {
  title?: string;
  toptitle?: string;
  topurn?: string;
  workurn?: string;
  // Present for some multi-chapter works; absent for others (observed live
  // on 2026-09-01, gettextinfo for "ctp:analects" carries no chapter list).
  chapters?: Array<{ title: string; urn: string }>;
  books?: Array<{ title: string; urn: string }>;
}

interface CtextGetText extends CtextApiError {
  urn?: string;
  fulltext?: Array<{ type: string; content: string }>;
}

export function normalizeCtextSearch(data: CtextSearchResponse, limit: number): LibraryResult[] {
  return (data.books ?? []).slice(0, limit).map((item) => ({
    id: item.urn,
    source: 'ctext' as const,
    title: item.title,
    authors: [],
    language: 'zh',
    subjects: ['Chinese classics'],
    hasFullText: true,
    previewUrl: `https://ctext.org/${item.urn.replace(/^ctp:/, '')}`,
  }));
}

export async function ctextSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<CtextSearchResponse>(
    `${API}/searchtexts?title=${encodeURIComponent(query)}`,
  );
  return normalizeCtextSearch(data, limit);
}

function flattenFullText(data: CtextGetText): string {
  return (data.fulltext ?? [])
    .map((s) => s.content)
    .join('\n')
    .trim();
}

async function fetchChapterText(urn: string): Promise<string> {
  const data = await fetchJSON<CtextGetText>(
    `${API}/gettext?urn=${encodeURIComponent(urn)}${apiKeyParam()}`,
  );
  if (data.error) {
    throw new Error(
      `ctext gettext for "${urn}" requires authentication (registered IP or CTEXT_API_KEY): ${data.error.description}`,
    );
  }
  return flattenFullText(data);
}

export async function ctextRead(id: string): Promise<{
  text: string;
  title: string;
  authors: string[];
  language?: string;
}> {
  const info = await fetchJSON<CtextTextInfo>(
    `${API}/gettextinfo?urn=${encodeURIComponent(id)}${apiKeyParam()}`,
  );
  if (info.error) {
    throw new Error(`ctext gettextinfo for "${id}" failed: ${info.error.description}`);
  }
  const title = info.title ?? info.toptitle ?? id;
  const chapters = info.chapters ?? info.books ?? [];

  if (chapters.length === 0) {
    const text = await fetchChapterText(id);
    return { text: normaliseWhitespace(text), title, authors: [], language: 'zh' };
  }

  const limit = pLimit(5);
  const parts = (
    await Promise.all(
      chapters.slice(0, 100).map((chapter) =>
        limit(async () => {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const text = await fetchChapterText(chapter.urn);
            if (text.length > 20) return `\n\n# ${chapter.title}\n\n${text}`;
          } catch {
            /* skip */
          }
          return null;
        }),
      ),
    )
  ).filter((res): res is string => res !== null);

  return {
    text: normaliseWhitespace(parts.join('\n')),
    title,
    authors: [],
    language: 'zh',
  };
}

register('ctext', {
  description:
    'Chinese Text Project: pre-Qin and Han dynasty classical Chinese texts with English translations. Full-text read requires a registered IP or optional CTEXT_API_KEY per ctext.org/tools/api; search stays keyless.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://ctext.org',
  verifiedAt: '2026-09-01',
  // Raises the anonymous quota; the source works without one.
  optionalEnv: ['CTEXT_API_KEY'],
  search: ctextSearch,
  async read(id) {
    const raw = await ctextRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
