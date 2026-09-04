// The extraction algorithm fetchTier.ts's tier 1 used to run inline on the
// main thread (parseHTML + Defuddle): both are synchronous, CPU-bound DOM
// work that can take multiple seconds on a large page (the Rust spike
// measured 1.7s/2.9s on the two fixtures this task's report re-measures),
// blocking the event loop - and with it every concurrent MCP request,
// including a plain /health check - for the duration.
//
// This file plays two roles depending on how it's loaded:
//   - As a worker (`new Worker(...)`, see extract.ts): parentPort is set,
//     the bottom block wires up a message handler, and every extraction
//     job runs on the worker's own thread, off the main event loop.
//   - As a plain module import (extract.ts's in-thread fallback, used when
//     workers are unavailable): parentPort is undefined, the bottom block
//     never runs, and callers just get runExtraction() as an ordinary
//     async function - the exact same code path, just invoked directly.
import { parentPort } from 'node:worker_threads';
import { parseHTML } from 'linkedom';
import type { ExtractedPdf } from './pdf.ts';

// Loaded dynamically rather than with a static import, same as fetchTier.ts
// used to do for this same call: pulled in only when an extraction job
// actually runs, cached after the first call. Each side that loads this
// file (the worker thread, or the main thread's in-thread fallback) gets
// its own module instance and so its own cache - deliberate, not shared
// state to coordinate.
let defuddlePromise: Promise<typeof import('defuddle/node').Defuddle> | undefined;
function loadDefuddle(): Promise<typeof import('defuddle/node').Defuddle> {
  if (!defuddlePromise) {
    defuddlePromise = import('defuddle/node').then((mod) => mod.Defuddle);
  }
  return defuddlePromise;
}

export interface ExtractedHtml {
  title: string;
  text: string;
}

// Final wave (C3): `useAsync` defaults to TRUE in the installed defuddle
// (see node_modules/defuddle/dist/types.d.ts: "Allow async extractors to
// fetch content from third-party APIs when no content can be extracted
// from the local HTML"). For a URL matching one of its async extractors -
// wiki.c2.com is the clearest, extractors/c2-wiki.js GETs
// https://c2.com/wiki/remodel/pages/<title> - minimal HTML plus a matching
// URL made this worker fetch a third-party API on its own, with none of
// Alexandria's guards: no assertFetchableUrl, no address pinning, no
// redirect check, no body cap, and no accounting of the call at all.
// Alexandria fetches the page itself (fetchTier.ts, guarded) and hands the
// HTML here; extraction has no business opening a second connection.
const DEFUDDLE_OPTIONS = { markdown: true, useAsync: false } as const;

/** The actual extraction work: identical to fetchTier.ts's former inline call. */
export async function runExtraction(html: string, url: string): Promise<ExtractedHtml> {
  const { document } = parseHTML(html);
  const Defuddle = await loadDefuddle();
  const result = await Defuddle(document, url, DEFUDDLE_OPTIONS);
  return { title: result.title || url, text: (result.content ?? '').trim() };
}

// Final wave (C5): PDF text extraction runs here too, as a second job
// kind, rather than on the main thread. unpdf inlines PDF.js's worker into
// its own bundle and runs it synchronously in-process, so a PDF with a
// large page count or object graph blocked the event loop - and every
// concurrent MCP request with it - for as long as it took, with no
// timeout, no page limit, and nothing able to cancel it. Here it is under
// extract.ts's existing 30s per-job timeout and worker teardown, and
// pdf.ts's own page/char bounds cut the work short.
//
// Imported dynamically for the same reason defuddle is: unpdf is a large
// module, and an HTML-only worker should never pay to load it.
let pdfModulePromise: Promise<typeof import('./pdf.ts')> | undefined;
function loadPdf(): Promise<typeof import('./pdf.ts')> {
  if (!pdfModulePromise) pdfModulePromise = import('./pdf.ts');
  return pdfModulePromise;
}

export async function runPdfExtraction(bytes: Uint8Array, url: string): Promise<ExtractedPdf> {
  const { extractPdf } = await loadPdf();
  return extractPdf(bytes, url);
}

export type ExtractJobMessage =
  | { id: number; kind: 'html'; html: string; url: string }
  | { id: number; kind: 'pdf'; bytes: Uint8Array; url: string };

export type ExtractJobResult = ExtractedHtml | ExtractedPdf;

function runJob(msg: ExtractJobMessage): Promise<ExtractJobResult> {
  return msg.kind === 'pdf'
    ? runPdfExtraction(msg.bytes, msg.url)
    : runExtraction(msg.html, msg.url);
}

// Worker entry point. Only wired up when this module is actually running
// as a worker thread (parentPort !== null) - extract.ts's in-thread
// fallback imports runExtraction()/runPdfExtraction() directly and never
// triggers this.
if (parentPort) {
  const port = parentPort;
  port.on('message', (msg: ExtractJobMessage) => {
    runJob(msg).then(
      (result) => port.postMessage({ id: msg.id, result }),
      (err: unknown) =>
        port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
    );
  });
}
