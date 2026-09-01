import { fetchWithRetry } from '../utils/http.js';
import { rateLimited } from '../utils/rateLimit.js';
import { register, truncateText } from './registry.js';
import type { LibraryResult, ReadResult } from '../types.js';

// BASE (Bielefeld Academic Search Engine)
// 400M+ scholarly records from 12,000+ providers, ~60% open access.
// Dublin Core metadata via HTTP interface (cgi-bin/BaseHttpSearchInterface.fcgi).
//
// Auth: API key passed as `userName` URL parameter. Apply at
//   https://www.base-search.net/about/en/contact.php
// Set BASE_API_KEY env var to the key issued by base.ub@uni-bielefeld.de.
//
// Rate limit: STRICT 1 qps. Bielefeld's email: "your access may be revoked
// without another warning". We pace at 1100ms minimum between request
// completions for a 100ms safety margin, and disable retries inside the
// rate-limited window so a single failure can't burst.

const SEARCH_URL = 'https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi';
const UA = 'Alexandria/9.0 (open access research; contact@the13thletter.co)';
const RATE_LIMIT_KEY = 'base';
const MIN_INTERVAL_MS = 1100;

type DCArr = string | string[] | undefined;

interface BASEDoc {
  dcidentifier?: DCArr;
  dctitle?: DCArr;
  dccreator?: DCArr;
  dcdate?: DCArr;
  dcdescription?: DCArr;
  dcsubject?: DCArr;
  dclanguage?: string;
  dclink?: string;
  dctype?: DCArr;
  dcoa?: string;          // '1' = open access
  dcpublisher?: DCArr;
  dcrights?: DCArr;
}

interface BASEResponse {
  response?: { numFound?: number; docs?: BASEDoc[] };
}

function toArr(v: DCArr): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

function first(v: DCArr): string {
  return toArr(v)[0] || '';
}

function buildUrl(params: Record<string, string | number>): string {
  const key = process.env.BASE_API_KEY;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  if (key) qs.set('userName', key);
  qs.set('format', 'json');
  return `${SEARCH_URL}?${qs.toString()}`;
}

// Single rate-limited BASE API call. No internal retries — the rate limiter
// governs all timing, and any failed request burns a slot anyway.
async function fetchBase(url: string): Promise<BASEResponse> {
  return rateLimited(RATE_LIMIT_KEY, MIN_INTERVAL_MS, async () => {
    const response = await fetchWithRetry(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': UA } },
      15_000,
      0,
    );
    if (!response.ok) {
      throw new Error(`BASE HTTP ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<BASEResponse>;
  });
}

function mapDoc(d: BASEDoc): LibraryResult {
  const ids = toArr(d.dcidentifier);
  const id = d.dclink || ids[0] || '';
  const dateStr = first(d.dcdate);
  const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
  return {
    id,
    source: 'base' as const,
    title: first(d.dctitle) || 'Untitled',
    authors: toArr(d.dccreator),
    year: isNaN(year as number) ? undefined : year,
    language: d.dclanguage || undefined,
    subjects: toArr(d.dcsubject),
    hasFullText: d.dcoa === '1' || Boolean(d.dclink),
    previewUrl: d.dclink || undefined,
    description: first(d.dcdescription)?.substring(0, 300) || undefined,
  };
}

export async function baseSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  const url = buildUrl({ func: 'PerformSearch', query, hits: limit, offset: 0 });
  try {
    const data = await fetchBase(url);
    return (data.response?.docs || []).map(mapDoc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[base] search failed for "${query.substring(0, 80)}": ${msg}`);
    return [];
  }
}

// Naive HTML → text. Good enough for ingest quality scoring; real parsing
// would use cheerio/jsdom and respect article boundaries. The pipeline's
// quality scorer will drop garbage chunks downstream.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function baseRead(id: string): Promise<ReadResult> {
  // 1. Look up the BASE record by identifier or dclink.
  let d: BASEDoc | null = null;
  try {
    const url = buildUrl({
      func: 'PerformSearch',
      query: `dc.identifier:"${id}" OR dc.link:"${id}"`,
      hits: 1,
      offset: 0,
    });
    const data = await fetchBase(url);
    d = data.response?.docs?.[0] || null;
  } catch (err) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      note: `BASE metadata lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!d) {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      note: `BASE record not found: ${id}`,
    };
  }

  const dateStr = first(d.dcdate);
  const year = dateStr ? parseInt(dateStr.substring(0, 4), 10) : undefined;
  const meta = {
    title: first(d.dctitle) || id,
    authors: toArr(d.dccreator),
    year: isNaN(year as number) ? undefined : year,
    language: d.dclanguage || undefined,
  };

  // 2. Attempt full-text retrieval from dclink for open-access HTML records.
  //    Skipped for non-OA (paywalled) and binary content (no PDF parser yet).
  //    dclink points to the *source* server, not BASE — no BASE rate limit.
  const dclink = d.dclink;
  if (dclink && d.dcoa === '1') {
    try {
      const response = await fetchWithRetry(
        dclink,
        { headers: { 'User-Agent': UA } },
        15_000,
        1, // one retry — arbitrary upstream servers, don't hammer
      );
      if (response.ok) {
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html') || contentType.includes('text/plain')) {
          const text = stripHtml(await response.text());
          if (text.length > 500) {
            return { ...meta, ...truncateText(text), externalUrl: dclink };
          }
        }
        // PDF/binary or content too short — fall through to metadata-only.
      }
    } catch {
      // Upstream fetch failed; fall through to metadata-only.
    }
  }

  // 3. Metadata-only fallback.
  return {
    ...meta,
    metadataOnly: true,
    text: first(d.dcdescription) || undefined,
    externalUrl: dclink || undefined,
    note: dclink
      ? 'BASE returns metadata only; full text at externalUrl (PDF or non-OA upstream).'
      : 'No full-text URL available for this BASE record.',
  };
}

register('base', {
  description:
    'BASE (Bielefeld Academic Search Engine) — 400M+ scholarly records from 12,000+ providers, ~60% open access. Dublin Core metadata + best-effort HTML full-text from open-access source URLs. Requires BASE_API_KEY (apply at base-search.net/about/en/contact.php). 1 qps rate limit enforced.',
  supportsIngest: true,
  search: baseSearch,
  read: baseRead,
});
