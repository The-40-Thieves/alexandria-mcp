import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeOcCitingWork, opencitationsRead, opencitationsSearch } from '../opencitations.ts';
import { getAdapter, listSources } from '../registry.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8'));
}

const citationsFixture = fixture('opencitations-citations.json') as unknown[];
const referencesFixture = fixture('opencitations-references.json') as unknown[];

type OcCitation = Parameters<typeof normalizeOcCitingWork>[0];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('opencitations declares supportsIngest false', () => {
  const meta = listSources().find((s) => s.name === 'opencitations');
  assert.ok(meta);
  assert.equal(meta?.supportsIngest, false);
});

test('normalizeOcCitingWork', () => {
  const out = normalizeOcCitingWork(citationsFixture[0] as OcCitation);
  assert.ok(out);
  assert.equal(out?.id, '10.1063/1.5011231');
  assert.equal(out?.source, 'opencitations');
  assert.equal(out?.year, 2018);
  assert.equal(out?.previewUrl, 'https://doi.org/10.1063/1.5011231');
});

test('normalizeOcCitingWork returns null when the citing pid list has no DOI', () => {
  const out = normalizeOcCitingWork({
    oci: 'x-y',
    citing: 'omid:br/123',
    cited: 'omid:br/456 doi:10.1/x',
  });
  assert.equal(out, null);
});

test('opencitationsSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.OPENCITATIONS_ACCESS_TOKEN;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.OPENCITATIONS_ACCESS_TOKEN;
    else process.env.OPENCITATIONS_ACCESS_TOKEN = originalToken;
  });

  await t.test('queries citations/doi:<doi> without percent-encoding the DOI', async () => {
    delete process.env.OPENCITATIONS_ACCESS_TOKEN;
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(
        String(url),
        'https://api.opencitations.net/index/v2/citations/doi:10.1038/nature12373',
      );
      return jsonResponse(citationsFixture);
    }) as typeof fetch;
    const out = await opencitationsSearch('10.1038/nature12373', 2);
    assert.equal(out.length, 2);
  });

  await t.test('sends the access token header when OPENCITATIONS_ACCESS_TOKEN is set', async () => {
    process.env.OPENCITATIONS_ACCESS_TOKEN = 'tok123';
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.authorization, 'tok123');
      return jsonResponse(citationsFixture);
    }) as typeof fetch;
    await opencitationsSearch('10.1038/nature12373', 5);
  });
});

test('opencitationsRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('renders the reference list as numbered lines', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(
        String(url),
        'https://api.opencitations.net/index/v2/references/doi:10.1038/nature12373',
      );
      return jsonResponse(referencesFixture);
    }) as typeof fetch;
    const result = await opencitationsRead('10.1038/nature12373');
    assert.match(result.text ?? '', /1\. doi:10\.1038\/nmeth818/);
  });

  await t.test('reports no references when the list is empty', async () => {
    globalThis.fetch = (async () => jsonResponse([])) as typeof fetch;
    const result = await opencitationsRead('10.0000/nothing');
    assert.match(result.text ?? '', /No references found/);
  });
});

test('opencitations adapter is registered', () => {
  assert.ok(getAdapter('opencitations'));
});
