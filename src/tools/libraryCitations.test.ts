import assert from 'node:assert/strict';
import test from 'node:test';
// Final wave (E5): libraryCitations now validates `source` against the
// registry at entry, so the real registrations (arxiv, openalex, ...) that
// several cases below name have to be loaded, not just the local fixtures.
import '../sources/all.ts';
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

test('libraryCitations: an arXiv seed not yet indexed by OpenAlex still falls back to OpenCitations with its computed DOI', async (t) => {
  // OpenAlex 404s for the constructed arXiv DOI (a brand-new preprint
  // OpenAlex hasn't indexed yet); the computed DOI must still be returned
  // from seed resolution so the OpenCitations fallback runs (review
  // finding: it was previously dropped, silently returning empty results).
  const { calls, restore } = stubFetchSequence([
    { match: '/works/doi:10.48550/arXiv.2999.99999', respond: () => jsonResponse({}, 404) },
    {
      match: 'api.opencitations.net/index/v2/citations/doi:10.48550/arXiv.2999.99999',
      respond: () =>
        jsonResponse([
          {
            oci: 'a-b',
            citing: 'doi:10.7777/citer',
            cited: 'doi:10.48550/arXiv.2999.99999',
          },
        ]),
    },
  ]);
  t.after(restore);

  const result = await libraryCitations({
    id: '2999.99999',
    source: 'arxiv',
    direction: 'citations',
  });

  assert.equal(result.seed.doi, '10.48550/arXiv.2999.99999');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.source, 'opencitations');
  assert.equal(result.results[0]?.id, '10.7777/citer');
  assert.equal(calls.length, 2);
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

// Review finding (Important 2): the per-item Crossref-preferred BibTeX
// lookup must be paced through the same rateLimited() utility a registered
// adapter's own pacing relies on (src/utils/rateLimit.ts), keyed by
// 'doi.org', and capped so a large `limit` cannot turn one call into an
// unbounded run of sequential doi.org fetches.
test('libraryCitations: format bibtex paces Crossref-preferred lookups under the doi.org key', async (t) => {
  const timestamps: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('https://doi.org/10.9100')) {
      timestamps.push(Date.now());
      return new Response('@article{paced}', { status: 200 });
    }
    if (u.includes('api.opencitations.net/index/v2/citations/doi:10.9100/seed')) {
      return new Response(
        JSON.stringify([
          { oci: 'a', citing: 'doi:10.9100/item-0', cited: 'doi:10.9100/seed' },
          { oci: 'b', citing: 'doi:10.9100/item-1', cited: 'doi:10.9100/seed' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('api.openalex.org')) return new Response('not found', { status: 404 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  register('t_citations_pacing_fixture', {
    description: 'fixture',
    supportsIngest: true,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [], doi: '10.9100/seed' };
    },
  });

  const result = await libraryCitations({
    id: 'x',
    source: 't_citations_pacing_fixture',
    direction: 'citations',
    limit: 2,
    format: 'bibtex',
  });

  assert.equal(result.results.length, 2);
  assert.equal(timestamps.length, 2, 'expected exactly two paced Crossref lookups');
  const gap = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
  assert.ok(
    gap >= 300,
    `expected the second Crossref lookup to wait out the doi.org pacing interval (>=300ms), got a ${gap}ms gap`,
  );
});

test('libraryCitations: format bibtex caps Crossref-preferred lookups at 20; later items use the local formatter', async (t) => {
  const ITEM_COUNT = 21;
  let crossrefFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('https://doi.org/10.9000')) {
      crossrefFetches += 1;
      return new Response('@article{crossref_hit}', { status: 200 });
    }
    if (u.includes('api.opencitations.net/index/v2/citations/doi:10.9000/seed')) {
      const citations = Array.from({ length: ITEM_COUNT }, (_, i) => ({
        oci: `oci-${i}`,
        citing: `doi:10.9000/item-${i}`,
        cited: 'doi:10.9000/seed',
      }));
      return new Response(JSON.stringify(citations), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('api.openalex.org')) return new Response('not found', { status: 404 });
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  register('t_citations_cap_fixture', {
    description: 'fixture',
    supportsIngest: true,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [], doi: '10.9000/seed' };
    },
  });

  const result = await libraryCitations({
    id: 'x',
    source: 't_citations_cap_fixture',
    direction: 'citations',
    limit: ITEM_COUNT,
    format: 'bibtex',
  });

  assert.equal(result.results.length, ITEM_COUNT);
  assert.equal(
    crossrefFetches,
    20,
    'expected the Crossref-preferred lookup to run for exactly the first 20 items',
  );

  const entries = (result.formatted ?? '').split('\n\n');
  assert.equal(entries.length, ITEM_COUNT);
  for (let i = 0; i < 20; i++) {
    assert.equal(
      entries[i],
      '@article{crossref_hit}',
      `entry ${i} should be Crossref's own BibTeX`,
    );
  }
  assert.match(entries[20] ?? '', /^@article\{/);
  assert.doesNotMatch(
    entries[20] ?? '',
    /crossref_hit/,
    'the 21st item is beyond the cap and must use the local formatter',
  );
});

// Final wave (E5): resolveSeed()'s DOI branch ran before its getAdapter()
// call, so a DOI-shaped id with an unregistered `source` reached OpenAlex
// and came back with the invented source echoed in the result's `seed`.
test('libraryCitations: an unregistered source is refused before any fetch', async (t) => {
  const { calls, restore } = stubFetchSequence([]);
  t.after(restore);

  await assert.rejects(
    () =>
      libraryCitations({
        id: '10.1000/example',
        source: 'not-registered',
        direction: 'citations',
      }),
    /Unknown source "not-registered"/,
  );
  assert.equal(calls.length, 0, 'nothing may be fetched for an unregistered source');
});
