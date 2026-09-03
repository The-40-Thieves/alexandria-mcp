import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizePubmedDoc, parseBiocFullText, pubmedRead, pubmedSearch } from '../pubmed.ts';
import { getAdapter } from '../registry.ts';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8'));
}

const esearchFixture = fixture('pubmed-esearch.json') as {
  esearchresult: { idlist: string[] };
};
const esummaryFixture = fixture('pubmed-esummary.json') as {
  result: { uids: string[]; [uid: string]: unknown };
};
const biocFixture = fixture('pubmed-bioc.json');

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('normalizePubmedDoc', () => {
  // 37173523 carries a PMC id in its articleids.
  const withPmc = esummaryFixture.result['37173523'] as Parameters<typeof normalizePubmedDoc>[0];
  const out = normalizePubmedDoc(withPmc);
  assert.equal(out.id, '37173523');
  assert.equal(out.source, 'pubmed');
  assert.equal(out.hasFullText, true);
  assert.equal(out.previewUrl, 'https://pubmed.ncbi.nlm.nih.gov/37173523/');
  assert.deepEqual(out.authors, ['Dong S', 'Zhao N', 'Spragins E']);
  assert.equal(out.year, 2023);

  // 42687624 has no PMC id.
  const withoutPmc = esummaryFixture.result['42687624'] as Parameters<typeof normalizePubmedDoc>[0];
  assert.equal(normalizePubmedDoc(withoutPmc).hasFullText, false);
});

test('parseBiocFullText', () => {
  const raw = JSON.stringify(biocFixture);
  const text = parseBiocFullText(raw);
  assert.match(text ?? '', /Isolation and characterization of SARS-CoV-2/);
});

test('pubmedSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('chains esearch then esummary', async () => {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      calls += 1;
      const u = String(url);
      if (u.includes('esearch.fcgi')) return jsonResponse(esearchFixture);
      if (u.includes('esummary.fcgi')) return jsonResponse(esummaryFixture);
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const out = await pubmedSearch('CRISPR gene editing', 3);
    assert.equal(calls, 2);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, '42687624');
  });

  await t.test('returns [] without an esummary call when esearch finds nothing', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ esearchresult: { idlist: [] } });
    }) as typeof fetch;
    const out = await pubmedSearch('zzznonexistentzzz', 3);
    assert.deepEqual(out, []);
    assert.equal(calls, 1);
  });
});

test('pubmedRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('returns PMC BioC full text when a PMCID exists', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('esummary.fcgi')) return jsonResponse(esummaryFixture);
      if (u.includes('BioC_json'))
        return new Response(JSON.stringify(biocFixture), { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const result = await pubmedRead('37173523');
    assert.match(result.text, /Isolation and characterization of SARS-CoV-2/);
    assert.equal(
      result.title,
      'Annotating and prioritizing human non-coding variants with RegulomeDB v.2.',
    );
  });

  await t.test('falls back to efetch abstract when there is no PMCID', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('esummary.fcgi')) return jsonResponse(esummaryFixture);
      if (u.includes('efetch.fcgi')) return new Response('Abstract text here.', { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const result = await pubmedRead('42687624');
    assert.equal(result.text, 'Abstract text here.');
  });

  await t.test('falls back to efetch abstract when BioC has no result for the PMCID', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('esummary.fcgi')) return jsonResponse(esummaryFixture);
      if (u.includes('BioC_json'))
        return new Response('[Error] : No result can be found.', { status: 200 });
      if (u.includes('efetch.fcgi')) return new Response('Fallback abstract.', { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    const result = await pubmedRead('37173523');
    assert.equal(result.text, 'Fallback abstract.');
  });

  await t.test('throws when the PMID does not exist', async () => {
    globalThis.fetch = (async () => jsonResponse({ result: { uids: [] } })) as typeof fetch;
    await assert.rejects(() => pubmedRead('00000000'), /PubMed record not found/);
  });
});

test('pubmed adapter is registered', () => {
  assert.ok(getAdapter('pubmed'));
});
