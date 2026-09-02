import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { context7Search, normalizeContext7 } from '../context7.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/context7-search.json'), 'utf8'),
);

test('normalizeContext7', async (t) => {
  await t.test('maps a library to a LibraryResult', () => {
    const out = normalizeContext7(fixture.results[0]);
    assert.equal(out.id, '/reactjs/react.dev');
    assert.equal(out.source, 'context7');
    assert.equal(out.title, 'React');
    assert.ok(out.description?.includes('official documentation'));
    assert.equal(out.previewUrl, 'https://context7.com/reactjs/react.dev');
  });
});

test('context7Search', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.CONTEXT7_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.CONTEXT7_API_KEY;
    else process.env.CONTEXT7_API_KEY = originalEnv;
  });

  await t.test('works keyless', async () => {
    delete process.env.CONTEXT7_API_KEY;
    let headers: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await context7Search('react', 5);
    assert.equal(out.length, 2);
    assert.equal(headers?.Authorization, undefined);
  });

  await t.test('sends a bearer header when CONTEXT7_API_KEY is set', async () => {
    process.env.CONTEXT7_API_KEY = 'secret';
    let headers: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    await context7Search('react', 5);
    assert.equal(headers?.Authorization, 'Bearer secret');
  });
});
