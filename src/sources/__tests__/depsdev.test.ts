import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { depsdevRead, depsdevSearch, normalizeDepsDev } from '../depsdev.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/depsdev-package.json'), 'utf8'),
);
const versionFixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/depsdev-version.json'), 'utf8'),
);

test('normalizeDepsDev', async (t) => {
  await t.test('maps a version to a LibraryResult, lowercasing the system', () => {
    const out = normalizeDepsDev(fixture.versions[0]);
    assert.equal(out.id, 'npm:lodash@0.1.0');
    assert.equal(out.source, 'depsdev');
    assert.equal(out.title, 'lodash 0.1.0 (npm)');
    assert.equal(out.year, 2012);
    assert.equal(out.previewUrl, 'https://deps.dev/npm/lodash/0.1.0');
  });
});

test('depsdevSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test(
    'parses a system:name query into the systems/{system}/packages/{name} URL',
    async () => {
      let calledUrl = '';
      globalThis.fetch = (async (url: string | URL) => {
        calledUrl = String(url);
        return new Response(JSON.stringify(fixture), { status: 200 });
      }) as typeof fetch;
      const out = await depsdevSearch('npm:lodash', 1);
      assert.equal(calledUrl, 'https://api.deps.dev/v3/systems/npm/packages/lodash');
      assert.equal(out.length, 1);
    },
  );

  await t.test('defaults to the npm system for a bare name', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    await depsdevSearch('lodash', 5);
    assert.equal(calledUrl, 'https://api.deps.dev/v3/systems/npm/packages/lodash');
  });
});

test('depsdevRead', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('fetches the version detail and includes licenses and links', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(versionFixture), { status: 200 })) as typeof fetch;
    const out = await depsdevRead('npm:lodash@4.17.21');
    assert.equal(out.title, 'lodash 4.17.21 (npm)');
    assert.ok(out.text?.includes('MIT'));
    assert.ok(out.text?.includes('https://lodash.com/'));
    assert.equal(out.year, 2021);
  });
});
