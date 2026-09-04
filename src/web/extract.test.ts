import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  abandonExtractWorkerForTests,
  extractHtml,
  resetExtractWorkerForTests,
} from './extract.ts';
import { runExtraction } from './extractWorker.ts';

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), 'eval/fixtures/web', name), 'utf8');
}

test('extractHtml (worker) returns the same text as in-thread extraction for a fixture', async (t) => {
  t.after(() => resetExtractWorkerForTests());

  const html = fixture('article.html');
  const url = 'https://example.com/article';

  const inThread = await runExtraction(html, url);
  const viaWorker = await extractHtml(html, url);

  assert.equal(viaWorker.title, inThread.title);
  assert.equal(viaWorker.text, inThread.text);
  assert.ok(viaWorker.text.length > 0, 'extracted text should not be empty');
});

test('a worker crash is recovered from: the next call lazily starts a fresh worker', async (t) => {
  t.after(() => resetExtractWorkerForTests());

  // Force the current worker down (simulating a crash) before the second
  // call - extractHtml() must not stay wedged against a dead worker.
  await resetExtractWorkerForTests();

  const html = fixture('article.html');
  const url = 'https://example.com/article';
  const result = await extractHtml(html, url);
  assert.ok(result.text.length > 0);
});

// Final wave (C3): defuddle's `useAsync` defaults to true, so for a URL
// matching one of its async extractors (wiki.c2.com is the clearest -
// extractors/c2-wiki.js GETs https://c2.com/wiki/remodel/pages/<title>)
// extraction fetched a third-party API on its own, with none of
// Alexandria's guards on it. Asserting on the fetch itself rather than on
// the option: `useAsync: false` is only worth passing if it actually stops
// the call.
test('extraction never fetches: an async-extractor URL completes with no network access', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const attempted: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    attempted.push(String(input));
    throw new Error('extraction must not reach the network');
  }) as typeof fetch;

  // Minimal HTML with nothing extractable: exactly the case that used to
  // send defuddle to its async extractor for a fallback.
  const html = '<html><head><title>Iterator Pattern</title></head><body></body></html>';
  const result = await runExtraction(html, 'https://wiki.c2.com/?IteratorPattern');

  assert.deepEqual(attempted, [], `extraction fetched: ${attempted.join(', ')}`);
  assert.equal(typeof result.text, 'string');
});

// Final wave (C4): a timed-out worker's 'exit' event fires asynchronously,
// well after extractHtml() has already started a replacement and posted
// new jobs to it. The old error/exit handlers called rejectAllPending()
// and cleared the singleton unconditionally, so the dead worker's exit
// rejected jobs belonging to the healthy replacement and left the module
// with no worker it had just started. Handlers now settle only the jobs
// posted to their own worker.
test('a dead worker rejects only its own jobs, never its replacement`s', async (t) => {
  t.after(() => resetExtractWorkerForTests());
  await resetExtractWorkerForTests();

  const html = fixture('article.html');

  // Job A on worker 1, then worker 1 is abandoned exactly the way the job
  // timeout abandons a wedged one: terminate() is NOT awaited and the
  // singleton is cleared, so its 'exit' arrives several ticks later, after
  // job B below has already started on a replacement.
  const jobA = extractHtml(html, 'https://example.com/a');
  const aRejects = assert.rejects(() => jobA, /worker/);
  abandonExtractWorkerForTests();

  // Job B starts on a fresh worker 2 while worker 1 is still exiting.
  const jobB = extractHtml(html, 'https://example.com/b');

  await aRejects;
  const resultB = await jobB;
  assert.ok(resultB.text.length > 0, 'job B must complete on the replacement worker');

  // And a third job still works: the exiting worker 1 must not have
  // cleared the singleton out from under worker 2.
  const resultC = await extractHtml(html, 'https://example.com/c');
  assert.ok(resultC.text.length > 0);
});
