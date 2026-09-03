// resolveOpenAccess(doi): the open-access fallback chain library_read's
// handler (src/index.ts) calls when an adapter returns metadataOnly but
// the item carries a DOI - four hops, tried in OPEN_ACCESS_HOP_ORDER,
// first one to produce a fetchable URL wins:
//
//   1. openalex - GET works/doi:{doi}, read best_oa_location.pdf_url.
//                 Works keyless (set CONTACT_EMAIL for the polite pool, or
//                 OPENALEX_API_KEY for the paid tier - same as
//                 src/sources/openalex.ts).
//   2. pmc      - idconv (DOI -> PMCID), then PMC's BioC full-text
//                 endpoint. Reuses src/sources/pubmed.ts's BIOC_BASE and
//                 fetchBiocFullText rather than re-implementing the fetch
//                 + passage-parsing.
//   3. core     - CORE's search/works, filtered to the DOI, read
//                 downloadUrl. Only attempted when CORE_API_KEY is set
//                 (same requirement as src/sources/core.ts); skipped
//                 entirely, no network call, otherwise.
//   4. fatcat   - release/lookup?doi=, expanded with files, looking for an
//                 archived (rel: webarchive) PDF mirror.
//
// None of these hops pre-fetches the candidate's actual content to verify
// it really has full text - like the PDF URL an adapter's own metadata
// carries elsewhere in this codebase, a hop's URL is a candidate, not a
// guarantee; the caller's own fetchAsText()/fetchBiocFullText() call is
// what finds out for real. This keeps each hop to the one API call its
// own service needs, and keeps the four hops symmetric.
//
// SECURITY: every hop's URL came from a third-party API response, not
// this process's own hard-coded constants - it goes through
// assertFetchableUrl() before resolveOpenAccess() ever hands it back, same
// guard fetchAsText() itself re-applies before connecting.
import { BIOC_BASE, fetchBiocFullText } from '../sources/pubmed.ts';
import { fetchJSON } from '../utils/http.ts';
import { assertFetchableUrl } from './fetchTier.ts';

export type OpenAccessVia = 'openalex' | 'pmc' | 'core' | 'fatcat';

export interface OpenAccessLocation {
  url: string;
  via: OpenAccessVia;
}

// Exported so library_read's handler can report which OA sources were
// considered (ReadResult.unavailable.triedTiers) without hard-coding a
// second copy of this order.
export const OPEN_ACCESS_HOP_ORDER: readonly OpenAccessVia[] = [
  'openalex',
  'pmc',
  'core',
  'fatcat',
];

const OPENALEX_BASE = 'https://api.openalex.org';
const IDCONV_BASE = 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/';
const CORE_BASE = 'https://api.core.ac.uk/v3';
const FATCAT_BASE = 'https://api.fatcat.wiki/v0';

function contactEmail(): string {
  return process.env.CONTACT_EMAIL || '';
}

// --- 1. OpenAlex -------------------------------------------------------

interface OpenAlexWorkMin {
  best_oa_location?: { pdf_url?: string };
}

async function tryOpenAlex(doi: string): Promise<OpenAccessLocation | undefined> {
  const apiKey = process.env.OPENALEX_API_KEY;
  const auth = apiKey
    ? `api_key=${encodeURIComponent(apiKey)}`
    : `mailto=${encodeURIComponent(contactEmail())}`;
  let work: OpenAlexWorkMin;
  try {
    work = await fetchJSON<OpenAlexWorkMin>(
      `${OPENALEX_BASE}/works/doi:${encodeURIComponent(doi)}?${auth}`,
    );
  } catch {
    return undefined; // not found, or OpenAlex is unavailable
  }
  const url = work.best_oa_location?.pdf_url;
  if (!url) return undefined;
  await assertFetchableUrl(url);
  return { url, via: 'openalex' };
}

// --- 2. PMC --------------------------------------------------------------

interface IdConvResponse {
  records?: Array<{ pmcid?: string }>;
}

async function tryPmc(doi: string): Promise<OpenAccessLocation | undefined> {
  let pmcid: string | undefined;
  try {
    const data = await fetchJSON<IdConvResponse>(
      `${IDCONV_BASE}?tool=alexandria-mcp&email=${encodeURIComponent(contactEmail())}&ids=${encodeURIComponent(doi)}&format=json`,
    );
    pmcid = data.records?.[0]?.pmcid;
  } catch {
    return undefined; // idconv has no record for this DOI, or is unavailable
  }
  if (!pmcid) return undefined;
  const url = `${BIOC_BASE}/${pmcid}/unicode`;
  await assertFetchableUrl(url);
  return { url, via: 'pmc' };
}

// --- 3. CORE ---------------------------------------------------------------

interface CoreWorkMin {
  downloadUrl?: string;
}
interface CoreSearchResponseMin {
  results?: CoreWorkMin[];
}

async function tryCore(doi: string): Promise<OpenAccessLocation | undefined> {
  const key = process.env.CORE_API_KEY;
  if (!key) return undefined; // brief: CORE hop only when CORE_API_KEY is set
  let data: CoreSearchResponseMin;
  try {
    data = await fetchJSON<CoreSearchResponseMin>(
      `${CORE_BASE}/search/works/?q=${encodeURIComponent(`doi:"${doi}"`)}&limit=1`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
  } catch {
    return undefined;
  }
  const url = data.results?.[0]?.downloadUrl;
  if (!url) return undefined;
  await assertFetchableUrl(url);
  return { url, via: 'core' };
}

// --- 4. fatcat ---------------------------------------------------------------

interface FatcatFileUrl {
  url: string;
  rel?: string;
}
interface FatcatFile {
  mimetype?: string;
  urls?: FatcatFileUrl[];
}
interface FatcatReleaseMin {
  files?: FatcatFile[];
}

// Prefers a rel: "webarchive" mirror (the brief calls for an "archived"
// PDF specifically) over a live publisher/repository copy, which is more
// likely to have gone stale or paywalled since fatcat indexed it.
function pickFatcatPdfUrl(release: FatcatReleaseMin): string | undefined {
  for (const file of release.files ?? []) {
    if (!file.mimetype?.includes('pdf')) continue;
    const urls = file.urls ?? [];
    const archived = urls.find((u) => u.rel === 'webarchive');
    if (archived) return archived.url;
    if (urls[0]) return urls[0].url;
  }
  return undefined;
}

async function tryFatcat(doi: string): Promise<OpenAccessLocation | undefined> {
  let release: FatcatReleaseMin;
  try {
    release = await fetchJSON<FatcatReleaseMin>(
      `${FATCAT_BASE}/release/lookup?doi=${encodeURIComponent(doi)}&expand=files`,
    );
  } catch {
    return undefined;
  }
  const url = pickFatcatPdfUrl(release);
  if (!url) return undefined;
  await assertFetchableUrl(url);
  return { url, via: 'fatcat' };
}

const HOPS: Record<OpenAccessVia, (doi: string) => Promise<OpenAccessLocation | undefined>> = {
  openalex: tryOpenAlex,
  pmc: tryPmc,
  core: tryCore,
  fatcat: tryFatcat,
};

export async function resolveOpenAccess(doi: string): Promise<OpenAccessLocation | undefined> {
  for (const hop of OPEN_ACCESS_HOP_ORDER) {
    const location = await HOPS[hop](doi);
    if (location) return location;
  }
  return undefined;
}

// Re-exported so library_read's handler can fetch PMC's full text
// directly (the BioC endpoint isn't HTML or a PDF, so fetchAsText's
// content-type gate would refuse it) without importing straight from
// src/sources/pubmed.ts and reaching past this module's own hop table.
export { fetchBiocFullText };

// tryPmc() above builds a pmc location's `url` as `${BIOC_BASE}/{pmcid}/unicode`;
// this is the inverse, so the handler can recover the PMCID
// fetchBiocFullText() needs from the `url` resolveOpenAccess() handed back
// instead of threading the PMCID through OpenAccessLocation for this one
// via.
export function pmcidFromBiocUrl(url: string): string | undefined {
  if (!url.startsWith(`${BIOC_BASE}/`)) return undefined;
  return url.slice(BIOC_BASE.length + 1).replace(/\/unicode$/, '') || undefined;
}

// A DOI embedded in a URL (e.g. an adapter's externalUrl pointing at
// https://doi.org/10.xxxx/yyy) - used by library_read's handler when an
// adapter has no dedicated `doi` field but its externalUrl carries one.
// Trailing punctuation a sentence or markdown link might have attached
// (.,;)]) is stripped, since a bare DOI itself never ends in one of those.
const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"'<>]+/;

export function extractDoiFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(DOI_PATTERN);
  if (!match) return undefined;
  return match[0].replace(/[.,;)\]]+$/, '');
}
