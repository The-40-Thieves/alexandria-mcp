import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractHtml, resetExtractWorkerForTests } from './extract.ts';
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
