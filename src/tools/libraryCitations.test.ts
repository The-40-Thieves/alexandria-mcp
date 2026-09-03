import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from '../sources/registry.ts';
import { libraryCitations } from './libraryCitations.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A minimal OpenAlex work object, shaped like the real API's response to
// GET /works/<id-or-external-id>.
function oaWork(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'https://openalex.org/W1000000001',
    doi: 'https://doi.org/10.1000/seed',
    title: 'Seed Work',
    authorships: [],
    ...overrides,
  };
}

function oaBatch(ids: string[]): { results: Record<string, unknown>[] } {
  return {
    results: ids.map((id) => ({
      id: `https://openalex.org/${id}`,
      title: `Work ${id}`,
      authorships: [],
    })),
  };
}

// Routes a sequence of fetch calls to handlers keyed by a substring match
// against the URL, in the order given - each handler is consumed once, so
// the test controls exactly how many calls of each shape it expects,
// mirroring src/sources/__tests__/crossref.test.ts's stubbing style.
function stubFetchSequence(handlers: Array<{ match: string | RegExp; respond: () => Response }>) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const remaining = [...handlers];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const idx = remaining.findIndex((h) =>
      typeof h.match === 'string' ? u.includes(h.match) : h.match.test(u),
    );
    if (idx === -1) throw new Error(`unexpected fetch: ${u}`);
    const [handler] = remaining.splice(idx, 1);
    return handler.respond();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

test('libraryCitations: references, seed passed as a bare DOI', async (t) => {
  const { calls, restore } = stubFetchSequence([
    {
      match: '/works/doi:10.1000/seed',
      respond: () =>
        jsonResponse(
          oaWork({ referenced_works: ['https://openalex.org/W2', 'https://openalex.org/W3'] }),
        ),
    },
    { match: 'filter=openalex_id:W2|W3', respond: () => jsonResponse(oaBatch(['W2', 'W3'])) },
  ]);
  t.after(restore);

  const result = await libraryCitations({
    id: '10.1000/seed',
    source: 'crossref',
    direction: 'references',
  });

  assert.equal(result.seed.doi, '10.1000/seed');
  assert.equal(result.direction, 'references');
  assert.deepEqual(
    result.results.map((r) => r.id),
    ['W2', 'W3'],
  );
  assert.equal(calls.length, 2);
});

test('libraryCitations: batches referenced_works over 51 ids into two filter calls', async (t) => {
  const ids = Array.from({ length: 51 }, (_, i) => `W${i + 1}`);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/works/doi:')) {
      return jsonResponse(
        oaWork({ referenced_works: ids.map((id) => `https://openalex.org/${id}`) }),
      );
    }
    if (u.includes('filter=openalex_id:')) {
      const batch = new URL(u).searchParams.get('filter')?.split(':')[1]?.split('|') ?? [];
      return jsonResponse(oaBatch(batch));
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  t.after(() => (globalThis.fetch = originalFetch));

  const result = await libraryCitations({
    id: '10.1000/many-refs',
    source: 'crossref',
    direction: 'references',
    limit: 51,
  });

  const batchCalls = calls.filter((u) => u.includes('filter=openalex_id:'));
  assert.equal(batchCalls.length, 2, 'expected exactly two batched filter calls for 51 ids');
  assert.equal(result.results.length, 51);
});

test('libraryCitations: citations direction uses the cites: filter', async (t) => {
  const { calls, restore } = stubFetchSequence([
    { match: '/works/doi:10.1000/seed', respond: () => jsonResponse(oaWork()) },
    {
      match: /filter=cites:W1000000001.*per_page=5/,
      respond: () => jsonResponse(oaBatch(['W9'])),
    },
  ]);
  t.after(restore);

  const result = await libraryCitations({
    id: '10.1000/seed',
    source: 'crossref',
    direction: 'citations',
    limit: 5,
  });

  assert.deepEqual(
    result.results.map((r) => r.id),
    ['W9'],
  );
  assert.equal(calls.length, 2);
});

test("libraryCitations: an arXiv seed resolves through arXiv's own DOI (10.48550/arXiv.<id>)", async (t) => {
  const { calls, restore } = stubFetchSequence([
    {
      match: '/works/doi:10.48550/arXiv.2301.12345',
      respond: () =>
        jsonResponse(
          oaWork({
            id: 'https://openalex.org/W42',
            doi: 'https://doi.org/10.48550/arxiv.2301.12345',
            referenced_works: [],
          }),
        ),
    },
  ]);
  t.after(restore);

  const result = await libraryCitations({
    id: '2301.12345',
    source: 'arxiv',
    direction: 'references',
  });

  assert.equal(result.seed.doi, '10.48550/arxiv.2301.12345');
  assert.deepEqual(result.results, []);
  assert.equal(calls.length, 1);
});

test('libraryCitations: a generic source resolves via its own read().doi (Task 6)', async (t) => {
  register('t_citations_doi_source', {
    description: 'fixture',
    supportsIngest: true,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [], doi: '10.2000/generic' };
    },
  });

  const { calls, restore } = stubFetchSequence([
    {
      match: '/works/doi:10.2000/generic',
      respond: () => jsonResponse(oaWork({ id: 'https://openalex.org/W7', referenced_works: [] })),
    },
  ]);
  t.after(restore);

  const result = await libraryCitations({
    id: 'generic-1',
    source: 't_citations_doi_source',
    direction: 'references',
  });

  assert.equal(result.seed.doi, '10.2000/generic');
  assert.equal(calls.length, 1);
});

test('libraryCitations: OpenCitations fallback when OpenAlex has no record for the DOI', async (t) => {
  register('t_citations_oc_fallback', {
    description: 'fixture',
    supportsIngest: true,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [], doi: '10.3000/no-openalex-record' };
    },
  });

  await t.test('citations: falls back to opencitationsSearch', async () => {
    const { restore } = stubFetchSequence([
      { match: '/works/doi:10.3000/no-openalex-record', respond: () => jsonResponse({}, 404) },
      {
        match: 'api.opencitations.net/index/v2/citations/doi:10.3000/no-openalex-record',
        respond: () =>
          jsonResponse([
            { oci: 'x-y', citing: 'doi:10.9999/citer', cited: 'doi:10.3000/no-openalex-record' },
          ]),
      },
    ]);
    try {
      const result = await libraryCitations({
        id: 'x',
        source: 't_citations_oc_fallback',
        direction: 'citations',
      });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0]?.source, 'opencitations');
      assert.equal(result.results[0]?.id, '10.9999/citer');
    } finally {
      restore();
    }
  });

  await t.test(
    'references: falls back to opencitationsRead, parsed into LibraryResult stubs',
    async () => {
      const { restore } = stubFetchSequence([
        { match: '/works/doi:10.3000/no-openalex-record', respond: () => jsonResponse({}, 404) },
        {
          match: 'api.opencitations.net/index/v2/references/doi:10.3000/no-openalex-record',
          respond: () =>
            jsonResponse([
              {
                oci: 'a-b',
                citing: 'doi:10.3000/no-openalex-record',
                cited: 'doi:10.8888/ref-one',
              },
            ]),
        },
      ]);
      try {
        const result = await libraryCitations({
          id: 'x',
          source: 't_citations_oc_fallback',
          direction: 'references',
        });
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.source, 'opencitations');
        assert.equal(result.results[0]?.id, '10.8888/ref-one');
        assert.equal(result.results[0]?.previewUrl, 'https://doi.org/10.8888/ref-one');
      } finally {
        restore();
      }
    },
  );
});

test('libraryCitations: no DOI resolvable at all returns empty results and no seed.doi', async () => {
  register('t_citations_no_doi', {
    description: 'fixture',
    supportsIngest: true,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [] }; // no doi
    },
  });

  const result = await libraryCitations({
    id: 'whatever',
    source: 't_citations_no_doi',
    direction: 'references',
  });

  assert.deepEqual(result.results, []);
  assert.equal(result.seed.doi, undefined);
  assert.deepEqual(result.seed, { id: 'whatever', source: 't_citations_no_doi' });
});

test('libraryCitations: format', async (t) => {
  await t.test('ris/apa run the local formatter over the whole result list', async () => {
    const { restore } = stubFetchSequence([
      {
        match: '/works/doi:10.1000/seed',
        respond: () =>
          jsonResponse(
            oaWork({
              referenced_works: ['https://openalex.org/W2'],
              doi: 'https://doi.org/10.1000/seed',
            }),
          ),
      },
      { match: 'filter=openalex_id:W2', respond: () => jsonResponse(oaBatch(['W2'])) },
    ]);
    try {
      const result = await libraryCitations({
        id: '10.1000/seed',
        source: 'crossref',
        direction: 'references',
        format: 'ris',
      });
      assert.match(result.formatted ?? '', /^TY {2}- JOUR/);
      assert.match(result.formatted ?? '', /ID {2}- openalex:W2/);
    } finally {
      restore();
    }
  });

  await t.test('bibtex prefers Crossref content negotiation when the item has a DOI', async () => {
    const { restore } = stubFetchSequence([
      {
        match: '/works/doi:10.1000/seed',
        respond: () => jsonResponse(oaWork({ referenced_works: ['https://openalex.org/W2'] })),
      },
      {
        match: 'filter=openalex_id:W2',
        respond: () =>
          jsonResponse({
            results: [
              {
                id: 'https://openalex.org/W2',
                title: 'Referenced Work',
                authorships: [],
                doi: 'https://doi.org/10.4000/ref',
              },
            ],
          }),
      },
      {
        match: 'https://doi.org/10.4000%2Fref',
        respond: () => new Response('@article{crossref_wins}', { status: 200 }),
      },
    ]);
    try {
      const result = await libraryCitations({
        id: '10.1000/seed',
        source: 'crossref',
        direction: 'references',
        format: 'bibtex',
      });
      assert.equal(result.formatted, '@article{crossref_wins}');
    } finally {
      restore();
    }
  });

  await t.test('bibtex falls back to the local formatter when Crossref fails', async () => {
    const { restore } = stubFetchSequence([
      {
        match: '/works/doi:10.1000/seed',
        respond: () => jsonResponse(oaWork({ referenced_works: ['https://openalex.org/W2'] })),
      },
      {
        match: 'filter=openalex_id:W2',
        respond: () => jsonResponse(oaBatch(['W2'])), // no doi on this item
      },
    ]);
    try {
      const result = await libraryCitations({
        id: '10.1000/seed',
        source: 'crossref',
        direction: 'references',
        format: 'bibtex',
      });
      assert.match(result.formatted ?? '', /^@article\{/);
      assert.match(result.formatted ?? '', /note = \{openalex:W2\}/);
    } finally {
      restore();
    }
  });
});
