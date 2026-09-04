// PDF text extraction for fetchTier.ts's PDF branch (task 6): unpdf wraps a
// serverless build of PDF.js with its worker inlined into the bundle, so
// getDocumentProxy()/extractText() run synchronously in-process on Node -
// no worker_threads, no native binary, verified live against Node 24 with
// the hand-built fixture at eval/fixtures/sample.pdf (see
// scripts/gen-pdf-fixture.ts).
//
// extractText(..., { mergePages: false }) (the default) returns one string
// per page rather than a single merged blob, which is what lets this
// module hand back real page numbers instead of an opaque char offset -
// fetchTier.ts's caller (library_read's handler, in src/index.ts) turns
// these into ReadResult.pages' charStart/charEnd by walking the same join
// this module performs to build `text`.
import { extractText, getDocumentProxy, getMeta } from 'unpdf';

export interface PdfPage {
  page: number;
  text: string;
}

export interface ExtractedPdf {
  title?: string;
  pages: PdfPage[];
  text: string;
}

/** Test-only: pdf.test.ts asserts these stay equal to registry.ts's READ_MAX_CHARS. */
export const PDF_LIMITS_FOR_TESTS = { maxPages: 500, maxTextChars: 200_000 };

// The separator joining page texts into `text` - callers that need to map
// a char offset in `text` back to a page (the library_read handler) must
// use this same separator's length, not guess at one.
export const PDF_PAGE_JOINER = '\n\n';

// Final wave (C5): extraction used to walk every page of any PDF that got
// past the 5 MB network cap, which a compressed PDF with a large page count
// or object graph can turn into a long, uninterruptible run. Two bounds now
// stop it early.
//
// MAX_PDF_TEXT_CHARS mirrors src/sources/registry.ts's READ_MAX_CHARS, which
// is where every read is truncated anyway - deliberately duplicated rather
// than imported, because registry.ts pulls in the state store's sqlite
// handle and this module runs inside the extraction worker thread (see
// extractWorker.ts). pdf.test.ts asserts the two stay equal.
//
// The page that CROSSES the char bound is kept whole, so `text` ends up
// just over the limit whenever anything was dropped. That is deliberate:
// the library_read handler's truncateText() then sees charCount >
// READ_MAX_CHARS and reports `truncated: true`, where stopping exactly at
// the limit would have reported a complete read of a PDF that was cut
// short. MAX_PDF_PAGES is the second bound, for a pathological PDF of very
// many tiny pages; at a typical 2-3k characters per page the char bound
// fires long before it.
const MAX_PDF_PAGES = PDF_LIMITS_FOR_TESTS.maxPages;
const MAX_PDF_TEXT_CHARS = PDF_LIMITS_FOR_TESTS.maxTextChars;

export async function extractPdf(bytes: Uint8Array, url: string): Promise<ExtractedPdf> {
  const pdf = await getDocumentProxy(bytes);
  const { text: perPage } = await extractText(pdf, { mergePages: false });
  const rawPages = Array.isArray(perPage) ? perPage : [perPage];

  // No filtering of empty pages here: the library_read handler recomputes
  // each page's charStart/charEnd by walking this exact join, so `pages`
  // and `text` must stay in lockstep - a page dropped from the join but
  // kept in `pages` (or vice versa) would silently desync the offsets.
  // Which is also why the bounds above drop WHOLE pages from both.
  const pages: PdfPage[] = [];
  let chars = 0;
  for (const [i, raw] of rawPages.slice(0, MAX_PDF_PAGES).entries()) {
    const pageText = raw.trim();
    pages.push({ page: i + 1, text: pageText });
    chars += pageText.length + (i === 0 ? 0 : PDF_PAGE_JOINER.length);
    if (chars >= MAX_PDF_TEXT_CHARS) break;
  }
  const text = pages.map((p) => p.text).join(PDF_PAGE_JOINER);

  if (!text.trim()) {
    throw new Error(`extractPdf: no extractable text in PDF at ${url}`);
  }

  // Metadata is best-effort: a PDF with a malformed /Info dict or none at
  // all still has its text, so a getMeta() failure never fails the whole
  // extraction.
  let title: string | undefined;
  try {
    const meta = await getMeta(pdf);
    const rawTitle = meta.info?.Title;
    if (typeof rawTitle === 'string' && rawTitle.trim()) title = rawTitle.trim();
  } catch {
    // no metadata available; extraction already succeeded above
  }

  return { title, pages, text };
}
