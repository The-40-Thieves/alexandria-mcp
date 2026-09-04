// extractHtml(): the event-loop-safe front door to extractWorker.ts's
// parseHTML+Defuddle extraction (task 13). Runs the actual work on one
// lazily-started worker thread instead of the main thread, so a slow
// extraction (multi-second on a large page) never blocks concurrent MCP
// requests. See extractWorker.ts's module comment for the split between
// its worker-mode and plain-import-mode roles.
//
// One worker, not one per job: extraction is not so frequent that a fresh
// thread per call is worth its startup cost, and a single worker gives a
// simple place to hang a crash-restart and an in-flight job count. A crash
// (the 'error' or 'exit' event) or a per-job timeout tears the worker down
// and rejects every job still pending against it; the next extractHtml()
// call lazily starts a replacement, so a wedged or crashed worker never
// wedges every future call.
//
// Falls back to in-thread extraction (runExtraction() called directly,
// same algorithm) when a Worker can't even be constructed - the
// environment this runs in doesn't support worker_threads at all, rather
// than a transient per-job failure, which is what the crash/timeout
// handling above already covers.
//
// ref()/unref(): a Worker keeps the whole process alive by default
// (Node's own default active-handle behavior), which is wrong for an idle
// worker sitting between jobs - a caller (the test suite, a one-off
// script) whose own work is done should be able to exit without knowing
// this module even exists. The worker is unref()ed right after it starts
// and again as soon as the last pending job settles, and ref()ed for the
// span of each job actually in flight - so it never blocks an otherwise-
// finished process from exiting, but also never lets the process exit out
// from under a job that's still running.
import { Worker } from 'node:worker_threads';
import {
  type ExtractedHtml,
  type ExtractJobMessage,
  type ExtractJobResult,
  runExtraction,
  runPdfExtraction,
} from './extractWorker.ts';
import type { ExtractedPdf } from './pdf.ts';

export type { ExtractedHtml };

const JOB_TIMEOUT_MS = 30_000;

interface PendingJob {
  resolve: (result: ExtractJobResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  // Final wave (C4): which worker this job was posted to. A timed-out
  // worker's 'exit' fires asynchronously, well after extractHtml() has
  // already started a replacement and posted new jobs to it, and the
  // handlers used to reject EVERY pending job and clear the singleton
  // unconditionally - killing jobs that belonged to the healthy
  // replacement and leaving the module without a worker it had just
  // started. Handlers now settle only their own worker's jobs.
  worker: Worker;
}

interface WorkerMessage {
  id: number;
  result?: ExtractJobResult;
  error?: string;
}

let worker: Worker | undefined;
let nextJobId = 1;
const pending = new Map<number, PendingJob>();

// extract.ts's own import.meta.url ends in .ts under native `.ts` execution
// (src/) and .js after `npm run build` (dist/); extractWorker.ts sits next
// to it and is compiled/copied the same way, so deriving the sibling's
// extension from THIS file's own extension - rather than hardcoding one -
// is what makes `new Worker(...)` resolve correctly from both src/ and
// dist/, proven in this task's report by running dist/index.js directly.
function workerScriptUrl(): URL {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./extractWorker${ext}`, import.meta.url);
}

function pendingCountFor(w: Worker): number {
  let n = 0;
  for (const job of pending.values()) if (job.worker === w) n += 1;
  return n;
}

function settlePending(id: number, err: Error | undefined, result: ExtractJobResult | undefined) {
  const job = pending.get(id);
  if (!job) return;
  pending.delete(id);
  clearTimeout(job.timer);
  // Back to idle once the last in-flight job on THAT worker settles: unref
  // so it no longer blocks an otherwise-finished process from exiting.
  if (pendingCountFor(job.worker) === 0) job.worker.unref();
  if (err) job.reject(err);
  else if (result) job.resolve(result);
}

// Rejects only the jobs posted to `w` (final wave, C4).
function rejectPendingFor(w: Worker, err: Error): void {
  for (const [id, job] of [...pending]) {
    if (job.worker === w) settlePending(id, err, undefined);
  }
}

function rejectAllPending(err: Error): void {
  for (const id of [...pending.keys()]) settlePending(id, err, undefined);
}

function startWorker(): Worker {
  const w = new Worker(workerScriptUrl());
  // Idle at birth (no job posted yet): unref so a process whose own work
  // is otherwise done can exit without waiting on this worker.
  w.unref();
  w.on('message', (msg: WorkerMessage) => {
    settlePending(msg.id, msg.error ? new Error(msg.error) : undefined, msg.result);
  });
  w.on('error', (err) => {
    rejectPendingFor(w, err instanceof Error ? err : new Error(String(err)));
    // Only if this is still the live worker: a replacement may already have
    // been started (see PendingJob.worker) and must not be dropped.
    if (worker === w) worker = undefined;
  });
  w.on('exit', (code) => {
    rejectPendingFor(w, new Error(`extractHtml: worker exited with code ${code}`));
    if (worker === w) worker = undefined;
  });
  return w;
}

// Returns undefined (rather than throwing) when a Worker can't be
// constructed at all, so extractHtml() below can fall back to in-thread
// extraction instead of failing every caller.
function getWorker(): Worker | undefined {
  if (worker) return worker;
  try {
    worker = startWorker();
    return worker;
  } catch {
    return undefined;
  }
}

// One job on the shared worker, with the per-job timeout and teardown.
// `transfer` is the transfer list for postMessage (the PDF job's byte
// buffer, so a multi-megabyte body is moved rather than structured-cloned).
function runOnWorker(
  w: Worker,
  buildMessage: (id: number) => ExtractJobMessage,
  url: string,
  transfer: readonly ArrayBuffer[] = [],
): Promise<ExtractJobResult> {
  const id = nextJobId++;
  // A job is now in flight: ref so this doesn't exit the process out from
  // under it (paired with settlePending()'s unref once every job drains).
  w.ref();
  return new Promise<ExtractJobResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // A job stuck past the timeout means the worker itself is likely
      // wedged (a pathological parse) rather than just this one job being
      // slow - terminate it so a replacement starts fresh on the next
      // call, instead of leaving a wedged worker silently swallowing every
      // future job. Unref first: this worker is being abandoned regardless
      // of whether any other job is still pending against it, so it
      // should stop counting toward keeping the process alive immediately
      // rather than only once terminate() finishes tearing it down.
      w.unref();
      void w.terminate();
      if (worker === w) worker = undefined;
      reject(
        new Error(`extractHtml: worker timed out after ${JOB_TIMEOUT_MS}ms extracting ${url}`),
      );
    }, JOB_TIMEOUT_MS);
    // Belt and suspenders alongside the worker's own ref/unref pairing:
    // clearTimeout() below already fires on every normal completion, but
    // an unref'd timer also can't itself hold the process open for up to
    // JOB_TIMEOUT_MS on some future code path that skips that call.
    timer.unref?.();
    pending.set(id, { resolve, reject, timer, worker: w });
    w.postMessage(buildMessage(id), transfer as ArrayBuffer[]);
  });
}

export async function extractHtml(html: string, url: string): Promise<ExtractedHtml> {
  const w = getWorker();
  if (!w) return runExtraction(html, url);
  return (await runOnWorker(w, (id) => ({ id, kind: 'html', html, url }), url)) as ExtractedHtml;
}

/**
 * PDF text extraction, on the same worker as HTML extraction (final wave,
 * C5). unpdf runs PDF.js synchronously in-process, so this used to block
 * the main event loop for as long as a large or pathological PDF took,
 * with no timeout and nothing able to cancel it; here it inherits the same
 * 30s per-job timeout and worker teardown as an HTML job, and pdf.ts's
 * page/char bounds cut the work itself short.
 *
 * The byte buffer is TRANSFERRED, not copied: `bytes` comes straight from
 * fetchTier.ts's readCappedBytes(), which builds a fresh Uint8Array owning
 * its whole buffer and never touches it again after this call, so moving
 * it avoids structured-cloning up to the 5 MB network cap on every PDF.
 * The in-thread fallback (no worker_threads at all) copies nothing and
 * runs the same code directly.
 */
export async function extractPdfOffThread(bytes: Uint8Array, url: string): Promise<ExtractedPdf> {
  const w = getWorker();
  if (!w) return runPdfExtraction(bytes, url);
  return (await runOnWorker(w, (id) => ({ id, kind: 'pdf', bytes, url }), url, [
    bytes.buffer as ArrayBuffer,
  ])) as ExtractedPdf;
}

/**
 * Test-only: reproduces exactly what the JOB_TIMEOUT_MS handler above does
 * to a wedged worker - unref, terminate WITHOUT awaiting, drop the
 * singleton - so a replacement starts while the abandoned worker is still
 * on its way to 'exit'. That interleaving is the whole of final wave C4,
 * and resetExtractWorkerForTests() cannot produce it: it awaits
 * terminate(), so the exit has already fired by the time it returns.
 */
export function abandonExtractWorkerForTests(): void {
  const w = worker;
  if (!w) return;
  w.unref();
  void w.terminate();
  worker = undefined;
}

// Test-only: lets a test that intentionally crashes/replaces the worker (or
// wants a clean slate between cases) tear down the current one without
// waiting for it to fail on its own.
export async function resetExtractWorkerForTests(): Promise<void> {
  rejectAllPending(new Error('extractHtml: worker reset for tests'));
  if (worker) await worker.terminate();
  worker = undefined;
}
