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

// The separator joining page texts into `text` - callers that need to map
// a char offset in `text` back to a page (the library_read handler) must
// use this same separator's length, not guess at one.
export const PDF_PAGE_JOINER = '\n\n';

export async function extractPdf(bytes: Uint8Array, url: string): Promise<ExtractedPdf> {
  const pdf = await getDocumentProxy(bytes);
  const { text: perPage } = await extractText(pdf, { mergePages: false });
  const rawPages = Array.isArray(perPage) ? perPage : [perPage];
  const pages: PdfPage[] = rawPages.map((text, i) => ({ page: i + 1, text: text.trim() }));
  // No filtering of empty pages here: the library_read handler recomputes
  // each page's charStart/charEnd by walking this exact join, so `pages`
  // and `text` must stay in lockstep - a page dropped from the join but
  // kept in `pages` (or vice versa) would silently desync the offsets.
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
