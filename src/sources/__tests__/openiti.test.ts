import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { openitiSearch } from '../openiti.ts';

const treeFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/openiti-tree.json'), 'utf8'),
);

test('openitiSearch falls back to the unauthenticated Trees API when GITHUB_TOKEN is unset', async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(treeFixture), { status: 200 })) as typeof fetch;

  try {
    const out = await openitiSearch('hadith', 5);
    assert.ok(out.length > 0);
    // The .yml metadata file and non-data/ paths (.gitignore, README.md)
    // must be filtered out; only the leaf text file should match.
    assert.ok(out.every((r) => !r.id.includes('.yml')));
    assert.ok(out.every((r) => r.id.includes('data/')));
    assert.equal(out[0].authors[0], '0476IbnAbiSaqrAnbari');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
  }
});

test('openitiSearch uses GitHub code search when GITHUB_TOKEN is set', async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';

  const codeSearchFixture = {
    total_count: 1,
    items: [
      {
        name: '0505Ghazali.IhyaCulumDin.Shamela0011606-ara1',
        path: 'data/0505Ghazali/0505Ghazali.IhyaCulumDin/0505Ghazali.IhyaCulumDin.Shamela0011606-ara1',
        html_url: 'https://github.com/OpenITI/0500AH/blob/master/...',
        repository: { name: '0500AH', full_name: 'OpenITI/0500AH' },
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = (async (url: string | URL | Request) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify(codeSearchFixture), { status: 200 });
  }) as typeof fetch;

  try {
    const out = await openitiSearch('ihya', 5);
    assert.match(capturedUrl, /search\/code/);
    assert.equal(out.length, 1);
    assert.equal(
      out[0].id,
      '0500AH||data/0505Ghazali/0505Ghazali.IhyaCulumDin/0505Ghazali.IhyaCulumDin.Shamela0011606-ara1',
    );
    assert.equal(out[0].title, '0505Ghazali, IhyaCulumDin');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
  }
});
