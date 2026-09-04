import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { VERSION } from '../../version.ts';
import { ecosystemsSearch, normalizeEcosystems } from '../ecosystems.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/ecosystems-search.json'), 'utf8'),
);

test('normalizeEcosystems', async (t) => {
  await t.test('maps a package with a description and registry_url', () => {
    const out = normalizeEcosystems(fixture[1]);
    assert.equal(out.id, 'express@cargo');
    assert.equal(out.source, 'ecosystems');
    assert.equal(out.title, 'express (cargo)');
    assert.ok(out.description?.includes('Rust'));
    assert.equal(out.year, 2016);
    assert.equal(out.previewUrl, 'https://crates.io/crates/express/');
  });

  await t.test('falls back cleanly when description and homepage are absent', () => {
    const out = normalizeEcosystems(fixture[0]);
    assert.equal(out.id, 'express@bower');
    assert.equal(out.hasFullText, false);
    assert.equal(out.previewUrl, undefined);
  });
});

test('ecosystemsSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.CONTACT_EMAIL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.CONTACT_EMAIL;
    else process.env.CONTACT_EMAIL = originalEnv;
  });

  await t.test('throws "ecosystems requires CONTACT_EMAIL" when the env is absent', async () => {
    delete process.env.CONTACT_EMAIL;
    await assert.rejects(
      ecosystemsSearch('express', 5),
      /^Error: ecosystems requires CONTACT_EMAIL$/,
    );
  });

  await t.test('sends a mailto User-Agent and returns normalized results when set', async () => {
    process.env.CONTACT_EMAIL = 'test@example.org';
    let headers: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await ecosystemsSearch('express', 5);
    // Final wave (F1): the version comes from package.json now, not a
    // literal frozen at `alexandria-mcp/10`. The mailto is still required
    // (ecosyste.ms answers 402 without one).
    assert.equal(headers?.['User-Agent'], `Alexandria/${VERSION} (mailto:test@example.org)`);
    assert.equal(out.length, 2);
  });
});
