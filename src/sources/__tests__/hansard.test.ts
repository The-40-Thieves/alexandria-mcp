import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeHansardDebate } from '../hansard.ts';
import { getAdapter } from '../registry.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8'));
}

const searchFixture = fixture('hansard-search.json') as { Debates: unknown[] };
const debateFixture = fixture('hansard-debate.json');

type HansardDebateHit = Parameters<typeof normalizeHansardDebate>[0];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizeHansardDebate', () => {
  const out = normalizeHansardDebate(searchFixture.Debates[0] as HansardDebateHit);
  assert.equal(out.id, '46C38A5F-8CE5-493D-8508-5D98AA98E113');
  assert.equal(out.source, 'hansard');
  assert.equal(out.title, 'Climate Change: International Partners');
  assert.equal(out.year, 2026);
  assert.deepEqual(out.subjects, ['Commons']);
  assert.equal(out.hasFullText, true);
});

test('hansard adapter', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('search() sends the search term and maps Debates', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('queryParameters.searchTerm'), 'climate change');
      assert.equal(parsed.searchParams.get('queryParameters.take'), '2');
      return jsonResponse(searchFixture);
    }) as typeof fetch;
    const out = await getAdapter('hansard').search('climate change', 2);
    assert.equal(out.length, 2);
  });

  await t.test('read() joins each contribution into the debate transcript', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.match(String(url), /\/debates\/debate\/E5BC6258-F22B-45D9-8916-9CB564FA81B2\.json$/);
      return jsonResponse(debateFixture);
    }) as typeof fetch;
    const result = await getAdapter('hansard').read('E5BC6258-F22B-45D9-8916-9CB564FA81B2');
    assert.equal(result.title, 'Direction of Government');
    assert.match(result.text ?? '', /Statement/);
  });

  await t.test('read() reports no contributions for an empty debate', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ Overview: { Title: 'Empty Debate' }, Items: [] })) as typeof fetch;
    const result = await getAdapter('hansard').read('00000000-0000-0000-0000-000000000000');
    assert.match(result.text ?? '', /No contributions recorded/);
  });
});

test('hansard adapter is registered', () => {
  assert.ok(getAdapter('hansard'));
});
