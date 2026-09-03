import assert from 'node:assert/strict';
import test from 'node:test';
import { dnsResolver } from './fetchTier.ts';
import {
  extractDoiFromUrl,
  fetchBiocFullText,
  OPEN_ACCESS_HOP_ORDER,
  pmcidFromBiocUrl,
  resolveOpenAccess,
} from './openAccess.ts';

const DOI = '10.1234/fixture.5678';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(): Response {
  return new Response('not found', { status: 404 });
}

test('resolveOpenAccess', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalLookup = dnsResolver.lookup;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    dnsResolver.lookup = originalLookup;
  });
  delete process.env.CORE_API_KEY;
  delete process.env.OPENALEX_API_KEY;
  process.env.CONTACT_EMAIL = 'test@example.org';
  // The candidate URLs each hop hands back (oa.example.org, core.example.org,
  // ...) are fixtures, not real hosts - stub the resolver so
  // assertFetchableUrl's guard sees an ordinary public address for them
  // instead of a real DNS failure.
  dnsResolver.lookup = (async () => [
    { address: '93.184.216.34', family: 4 },
  ]) as typeof dnsResolver.lookup;

  await t.test('hop order is openalex, pmc, core, fatcat', () => {
    assert.deepEqual(OPEN_ACCESS_HOP_ORDER, ['openalex', 'pmc', 'core', 'fatcat']);
  });

  await t.test('resolves via openalex when best_oa_location.pdf_url is present', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      assert.match(url, /^https:\/\/api\.openalex\.org\/works\/doi:/);
      return jsonResponse({ best_oa_location: { pdf_url: 'https://oa.example.org/paper.pdf' } });
    }) as typeof fetch;

    const result = await resolveOpenAccess(DOI);
    assert.deepEqual(result, { url: 'https://oa.example.org/paper.pdf', via: 'openalex' });
    assert.equal(calls.length, 1); // no fallthrough once openalex resolves
  });

  await t.test(
    'falls through to pmc (idconv then BioC) when openalex has no OA location',
    async () => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('api.openalex.org')) return jsonResponse({});
        if (url.includes('idconv')) return jsonResponse({ records: [{ pmcid: 'PMC1234567' }] });
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      const result = await resolveOpenAccess(DOI);
      assert.equal(result?.via, 'pmc');
      assert.match(result?.url ?? '', /PMC1234567\/unicode$/);
    },
  );

  await t.test('falls through to pmc, then to core, when idconv has no PMCID', async () => {
    process.env.CORE_API_KEY = 'test-core-key';
    const coreHeaders: Record<string, string>[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('api.openalex.org')) return jsonResponse({});
      if (url.includes('idconv')) return jsonResponse({ records: [{}] }); // no pmcid
      if (url.includes('api.core.ac.uk')) {
        coreHeaders.push((init.headers as Record<string, string>) ?? {});
        return jsonResponse({ results: [{ downloadUrl: 'https://core.example.org/full.pdf' }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveOpenAccess(DOI);
    assert.deepEqual(result, { url: 'https://core.example.org/full.pdf', via: 'core' });
    assert.equal(coreHeaders[0]?.Authorization, 'Bearer test-core-key');
    delete process.env.CORE_API_KEY;
  });

  await t.test('never calls CORE when CORE_API_KEY is unset', async () => {
    delete process.env.CORE_API_KEY;
    let coreWasCalled = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.openalex.org')) return jsonResponse({});
      if (url.includes('idconv')) return jsonResponse({ records: [{}] });
      if (url.includes('api.core.ac.uk')) {
        coreWasCalled = true;
        return jsonResponse({});
      }
      if (url.includes('api.fatcat.wiki')) return notFound();
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveOpenAccess(DOI);
    assert.equal(result, undefined);
    assert.equal(coreWasCalled, false);
  });

  await t.test('falls all the way through to fatcat, preferring a webarchive mirror', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('api.openalex.org')) return jsonResponse({});
      if (url.includes('idconv')) return jsonResponse({ records: [{}] });
      if (url.includes('api.fatcat.wiki')) {
        return jsonResponse({
          files: [
            {
              mimetype: 'application/pdf',
              urls: [
                { url: 'https://publisher.example.org/live.pdf', rel: 'publisher' },
                { url: 'https://web.archive.org/web/2020/paper.pdf', rel: 'webarchive' },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await resolveOpenAccess(DOI);
    assert.deepEqual(result, {
      url: 'https://web.archive.org/web/2020/paper.pdf',
      via: 'fatcat',
    });
  });

  await t.test('returns undefined when every hop fails to produce a candidate', async () => {
    globalThis.fetch = (async () => notFound()) as typeof fetch;

    const result = await resolveOpenAccess(DOI);
    assert.equal(result, undefined);
  });

  await t.test(
    'rejects rather than falling through when a hop resolves to a blocked URL',
    async () => {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('api.openalex.org')) {
          return jsonResponse({ best_oa_location: { pdf_url: 'http://10.1.2.3/private.pdf' } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      await assert.rejects(() => resolveOpenAccess(DOI), /private/);
    },
  );
});

test('fetchBiocFullText is re-exported for library_read to fetch PMC full text directly', () => {
  assert.equal(typeof fetchBiocFullText, 'function');
});

test('pmcidFromBiocUrl', async (t) => {
  await t.test('recovers the PMCID from a BioC url', () => {
    assert.equal(
      pmcidFromBiocUrl(
        'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/PMC1234567/unicode',
      ),
      'PMC1234567',
    );
  });

  await t.test('returns undefined for an unrelated url', () => {
    assert.equal(pmcidFromBiocUrl('https://example.org/PMC1234567/unicode'), undefined);
  });
});

test('extractDoiFromUrl', async (t) => {
  await t.test('extracts a bare DOI from a doi.org url', () => {
    assert.equal(extractDoiFromUrl('https://doi.org/10.1234/fixture.5678'), '10.1234/fixture.5678');
  });

  await t.test('strips trailing punctuation', () => {
    assert.equal(
      extractDoiFromUrl('See https://doi.org/10.1234/fixture.5678).'),
      '10.1234/fixture.5678',
    );
  });

  await t.test('returns undefined when the url has no DOI', () => {
    assert.equal(extractDoiFromUrl('https://example.org/about'), undefined);
  });

  await t.test('returns undefined for an undefined url', () => {
    assert.equal(extractDoiFromUrl(undefined), undefined);
  });
});
