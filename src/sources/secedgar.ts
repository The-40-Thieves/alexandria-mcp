// SEC EDGAR full-text search (efts): US public company filings since 2001.
// SEC requires an identifying User-Agent (name + contact email) on every
// request or it 403s; CONTACT_EMAIL is required here, unlike Wikipedia's
// optional contact. read() fetches the filing document itself through
// fetchAsText (SSRF-guarded), so this is a hand-written register() rather
// than defineRest, same shape as ecosystems.ts/webfetch.ts.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { fetchAsText } from '../web/fetchTier.ts';
import { register, truncateText } from './registry.ts';

const SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';

function requireContactEmail(): string {
  const email = process.env.CONTACT_EMAIL;
  if (!email) throw new Error('secedgar requires CONTACT_EMAIL');
  return email;
}

// SEC's documented format is "<company/app name> <contact email>" (e.g.
// "Sample Company Name AdminContact@sample.com") - no mailto: prefix, no
// parentheses.
function headers(): Record<string, string> {
  return { 'User-Agent': `alexandria-mcp ${requireContactEmail()}` };
}

interface SecHitSource {
  ciks?: string[];
  display_names?: string[];
  form?: string;
  file_date?: string;
  root_forms?: string[];
}
interface SecHit {
  _id: string; // "{accession-with-dashes}:{filename}"
  _source: SecHitSource;
}
interface SecSearchResponse {
  hits?: { hits?: SecHit[] };
}

interface FilingDocParts {
  cik: string;
  accessionNoDashes: string;
  filename: string;
}

function parseHitParts(hit: SecHit): FilingDocParts | null {
  const cik = hit._source.ciks?.[0];
  const [accession, filename] = hit._id.split(':');
  if (!cik || !accession || !filename) return null;
  // SEC's Archives paths use the CIK without leading zeros, but the
  // accession number WITH its internal digits (dashes stripped) as the
  // directory name.
  return { cik: String(Number(cik)), accessionNoDashes: accession.replace(/-/g, ''), filename };
}

function docUrl(parts: FilingDocParts): string {
  return `https://www.sec.gov/Archives/edgar/data/${parts.cik}/${parts.accessionNoDashes}/${parts.filename}`;
}

// The three parts needed to rebuild the filing's document URL are encoded
// into a single id (LibraryResult.id / read()'s parameter must be one
// string) rather than just reusing the raw `_id`, since that alone lacks
// the CIK the Archives path needs.
function encodeId(parts: FilingDocParts): string {
  return `${parts.cik}::${parts.accessionNoDashes}::${parts.filename}`;
}
function decodeId(id: string): FilingDocParts {
  const [cik, accessionNoDashes, ...rest] = id.split('::');
  return { cik, accessionNoDashes, filename: rest.join('::') };
}

export function normalizeSecHit(hit: SecHit): LibraryResult | null {
  const parts = parseHitParts(hit);
  if (!parts) return null;
  const title = [hit._source.display_names?.[0], hit._source.form].filter(Boolean).join(' - ');
  return {
    id: encodeId(parts),
    source: 'secedgar',
    title: title || `SEC filing ${parts.accessionNoDashes}`,
    authors: [],
    year: hit._source.file_date ? Number(hit._source.file_date.slice(0, 4)) : undefined,
    subjects: hit._source.root_forms,
    hasFullText: true,
    previewUrl: docUrl(parts),
  };
}

export async function secedgarSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<SecSearchResponse>(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
    headers: headers(),
  });
  const hits = data.hits?.hits ?? [];
  const results: LibraryResult[] = [];
  for (const hit of hits) {
    const r = normalizeSecHit(hit);
    if (r) results.push(r);
    if (results.length >= limit) break;
  }
  return results;
}

// Filing documents are arbitrary third-party HTML (or PDF, which fetchAsText
// can't extract); a failure degrades to metadata-only rather than throwing,
// the same convention as nhk.ts/peps.ts for any fetchAsText-based read.
export async function secedgarRead(id: string): Promise<ReadResult> {
  const parts = decodeId(id);
  const url = docUrl(parts);
  try {
    const page = await fetchAsText(url);
    return {
      title: page.title || parts.filename,
      authors: [],
      externalUrl: url,
      ...truncateText(page.text),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      title: parts.filename,
      authors: [],
      metadataOnly: true,
      externalUrl: url,
      note: `Full-text fetch failed; showing metadata only: ${message}`,
    };
  }
}

register('secedgar', {
  description:
    'SEC EDGAR full-text search: US public company filings (10-K, 10-Q, 8-K, and more) since 2001. Requires CONTACT_EMAIL for the mandatory identifying User-Agent (SEC 403s unidentified requests); 10 rps hard cap.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'economics',
  freshness: 'daily',
  homepage: 'https://www.sec.gov/edgar',
  verifiedAt: '2026-09-03',
  // Informational only (used by isConfigured() to decide hidden status);
  // the actual header value is built by headers() above in the format SEC
  // documents, not defineRest's raw-value injection.
  auth: { type: 'header', env: 'CONTACT_EMAIL', header: 'User-Agent' },
  pacing: { minIntervalMs: 100 },
  search: secedgarSearch,
  read: secedgarRead,
});
