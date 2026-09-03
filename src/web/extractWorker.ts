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

/** The actual extraction work: identical to fetchTier.ts's former inline call. */
export async function runExtraction(html: string, url: string): Promise<ExtractedHtml> {
  const { document } = parseHTML(html);
  const Defuddle = await loadDefuddle();
  const result = await Defuddle(document, url, { markdown: true });
  return { title: result.title || url, text: (result.content ?? '').trim() };
}

interface ExtractJobMessage {
  id: number;
  html: string;
  url: string;
}

// Worker entry point. Only wired up when this module is actually running
// as a worker thread (parentPort !== null) - extract.ts's in-thread
// fallback imports runExtraction() directly and never triggers this.
if (parentPort) {
  const port = parentPort;
  port.on('message', (msg: ExtractJobMessage) => {
    runExtraction(msg.html, msg.url).then(
      (result) => port.postMessage({ id: msg.id, result }),
      (err: unknown) =>
        port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
    );
  });
}
