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
import { type ExtractedHtml, runExtraction } from './extractWorker.ts';

export type { ExtractedHtml };

const JOB_TIMEOUT_MS = 30_000;

interface PendingJob {
  resolve: (result: ExtractedHtml) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerMessage {
  id: number;
  result?: ExtractedHtml;
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

function settlePending(id: number, err: Error | undefined, result: ExtractedHtml | undefined) {
  const job = pending.get(id);
  if (!job) return;
  pending.delete(id);
  clearTimeout(job.timer);
  // Back to idle once the last in-flight job settles: unref so this
  // worker no longer blocks an otherwise-finished process from exiting.
  if (pending.size === 0) worker?.unref();
  if (err) job.reject(err);
  else if (result) job.resolve(result);
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
    rejectAllPending(err instanceof Error ? err : new Error(String(err)));
    worker = undefined;
  });
  w.on('exit', (code) => {
    rejectAllPending(new Error(`extractHtml: worker exited with code ${code}`));
    worker = undefined;
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

export async function extractHtml(html: string, url: string): Promise<ExtractedHtml> {
  const w = getWorker();
  if (!w) return runExtraction(html, url);

  const id = nextJobId++;
  // A job is now in flight: ref so this doesn't exit the process out from
  // under it (paired with settlePending()'s unref once every job drains).
  w.ref();
  return new Promise<ExtractedHtml>((resolve, reject) => {
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
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, html, url });
  });
}

// Test-only: lets a test that intentionally crashes/replaces the worker (or
// wants a clean slate between cases) tear down the current one without
// waiting for it to fail on its own.
export async function resetExtractWorkerForTests(): Promise<void> {
  rejectAllPending(new Error('extractHtml: worker reset for tests'));
  if (worker) await worker.terminate();
  worker = undefined;
}
