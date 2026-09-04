// The open-access fallback chain (task 6), and the "does this read
// actually have full text" test it turns on.
//
// Final wave (E2): lifted out of src/index.ts, where it could only ever be
// reached by library_read's own handler and the document resource.
// src/tools/libraryAnswer.ts's readTopSources() needs the same chain - an
// answer built from abstract stubs when the full text was one OA hop away
// is the whole point of the chain - and nothing may import src/index.ts
// (it is the entrypoint: importing it would run main()'s module-level
// wiring). index.ts imports this module now, exactly like every other
// caller.
import { truncateText } from '../sources/registry.ts';
import type { ReadResult } from '../types.ts';
import { type FetchedPage, fetchAsText } from './fetchTier.ts';
import {
  extractDoiFromUrl,
  fetchBiocFullText,
  OPEN_ACCESS_HOP_ORDER,
  OpenAccessBlockedError,
  pmcidFromBiocUrl,
  resolveOpenAccess,
} from './openAccess.ts';
import { PDF_PAGE_JOINER } from './pdf.ts';

// Task 6 (and review round 1's controller ruling): the open-access
// fallback chain, used by library_read's handler below. Triggers whenever
// an adapter's result has no full text - metadataOnly: true, OR less than
// MIN_FULL_TEXT_CHARS of `text` (most scholarly adapters - crossref,
// datacite, biorxiv, medrxiv, plos, doaj, europmc, zenodo, osf, openalex,
// semanticscholar - never set metadataOnly at all; read() just returns an
// abstract stub as `text`) - AND the item names a DOI, its own `doi`
// field, or one embedded in `externalUrl`. resolveOpenAccess() (openalex,
// pmc, core, fatcat, in that order) finds a candidate URL, then this
// fetches it (fetchAsText for a PDF/HTML candidate, fetchBiocFullText
// directly for a PMC one, since PMC's BioC endpoint is neither HTML nor a
// PDF and fetchAsText's content-type gate would refuse it). On success the
// adapter's own stub moves to `note` (dropped only when it's identical to
// the new full text) rather than being discarded. Anything short of real
// text keeps the adapter's original `text` untouched (never blanked) and
// attaches `unavailable` with a reason and which OA sources were actually
// tried.
export const MIN_FULL_TEXT_CHARS = 2000;

type UnavailableReason = NonNullable<ReadResult['unavailable']>['reason'];

function classifyOpenAccessFailure(err: unknown): UnavailableReason {
  const message = err instanceof Error ? err.message : String(err);
  // fetchTier.ts's guard errors ("fetchAsText: refusing to fetch ...",
  // "fetchAsText: could not resolve ...", "fetchAsText: not a valid
  // URL ...") all start this way - see assertFetchableUrl's callers.
  if (/refusing to fetch|could not resolve|not a valid URL/.test(message)) return 'blocked';
  if (/byte cap/.test(message)) return 'too_large'; // readCappedBytes/readCappedText
  if (/HTTP 40[123]\b/.test(message)) return 'paywalled';
  return 'no_full_text';
}

// Mirrors pdf.ts's extractPdf(): `text` is these pages' text joined by
// PDF_PAGE_JOINER, so walking the same join recovers each page's char
// range in that (untruncated) text.
function pdfPagesToCharPages(
  pages: NonNullable<FetchedPage['pages']>,
): NonNullable<ReadResult['pages']> {
  let offset = 0;
  return pages.map(({ page, text }) => {
    const charStart = offset;
    const charEnd = charStart + text.length;
    offset = charEnd + PDF_PAGE_JOINER.length;
    return { page, charStart, charEnd };
  });
}

export function hasFullText(result: ReadResult): boolean {
  return !result.metadataOnly && (result.text ?? '').length >= MIN_FULL_TEXT_CHARS;
}

export async function withOpenAccessFallback(result: ReadResult): Promise<ReadResult> {
  if (hasFullText(result)) return result;
  const doi = result.doi ?? extractDoiFromUrl(result.externalUrl);
  if (!doi) return result;

  const allHops = [...OPEN_ACCESS_HOP_ORDER] as string[];
  let oa: Awaited<ReturnType<typeof resolveOpenAccess>>;
  try {
    oa = await resolveOpenAccess(doi);
  } catch (err) {
    // A hop's own candidate URL was refused by assertFetchableUrl (see
    // openAccess.ts's module comment) - a real refusal, not "nothing
    // found", so it's reported rather than silently swallowed.
    // OpenAccessBlockedError carries exactly the hops resolveOpenAccess
    // attempted before the one that threw; anything else (a bug, an
    // unexpected throw) falls back to reporting the full hop list.
    const triedTiers = err instanceof OpenAccessBlockedError ? err.tried : allHops;
    return { ...result, unavailable: { reason: classifyOpenAccessFailure(err), triedTiers } };
  }
  if (!oa) {
    return { ...result, unavailable: { reason: 'not_found', triedTiers: allHops } };
  }

  const triedTiers = allHops.slice(0, allHops.indexOf(oa.via) + 1);
  try {
    let text: string;
    let title = result.title;
    let pages: NonNullable<ReadResult['pages']> | undefined;
    if (oa.via === 'pmc') {
      const pmcid = pmcidFromBiocUrl(oa.url);
      const fetched = pmcid ? await fetchBiocFullText(pmcid) : undefined;
      if (!fetched) throw new Error(`no BioC full text available at ${oa.url}`);
      text = fetched;
    } else {
      const page = await fetchAsText(oa.url);
      if (!page.text) throw new Error(`empty text fetching ${oa.url}`);
      text = page.text;
      title = result.title || page.title;
      if (page.via === 'pdf' && page.pages) pages = pdfPagesToCharPages(page.pages);
    }
    const enriched: ReadResult = { ...result, metadataOnly: false, title, ...truncateText(text) };
    if (pages) enriched.pages = pages;
    // The adapter's own abstract/stub is kept under `note` rather than
    // discarded - a short-text trigger means the adapter DID return
    // something real, just not full text.
    if (result.text && result.text !== text) {
      enriched.note = result.note
        ? `${result.note}\n\nAbstract: ${result.text}`
        : `Abstract: ${result.text}`;
    }
    return enriched;
  } catch (err) {
    // Keep the adapter's own text untouched (never blanked); only attach
    // `unavailable` (result is spread first, so its `text` survives).
    return { ...result, unavailable: { reason: classifyOpenAccessFailure(err), triedTiers } };
  }
}
