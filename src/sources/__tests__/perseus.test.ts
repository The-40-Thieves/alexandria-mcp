import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { perseusRead, perseusSearch } from '../perseus.js';

function fixture(name: string): string {
  return readFileSync(path.resolve(process.cwd(), `eval/fixtures/${name}`), 'utf8');
}

test('perseusSearch', async (t) => {
  await t.test('matches by title/author/subject against the local catalogue', () => {
    const out = perseusSearch('homer', 10);
    assert.ok(out.some((r) => r.id === 'iliad'));
    assert.ok(out.some((r) => r.id === 'odyssey'));
  });

  await t.test('respects limit', () => {
    assert.equal(perseusSearch('grc', 1).length, 1);
  });

  await t.test('unknown query returns []', () => {
    assert.deepEqual(perseusSearch('nonexistent-author-xyz', 10), []);
  });
});

test('perseusRead against scaife.perseus.org (recorded fixtures)', async (t) => {
  await t.test('resolves a work urn to an edition, walks toc, concatenates passage text', async () => {
    const work = JSON.parse(fixture('perseus-work.json'));
    const edition = JSON.parse(fixture('perseus-edition.json'));
    const passageText = fixture('perseus-passage.txt');

    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      call += 1;
      const u = String(url);
      if (u.includes('tlg0012.tlg001/json')) {
        return new Response(JSON.stringify(work), { status: 200 });
      }
      if (u.includes('tlg0012.tlg001.perseus-grc2/json')) {
        return new Response(JSON.stringify(edition), { status: 200 });
      }
      if (u.includes('/text/')) {
        return new Response(passageText, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    try {
      const out = await perseusRead('iliad');
      assert.equal(out.title, 'Iliad');
      assert.match(out.text, /μῆνιν ἄειδε/);
      assert.ok(call >= 3); // work json + edition json + at least one passage
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('throws a clear error for an unknown id', async () => {
    await assert.rejects(perseusRead('not-a-real-work'), /Unknown Perseus ID/);
  });
});
