import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeSwiftEvolution, swiftEvolutionSearch } from '../swiftevolution.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/swiftevolution-proposals.json'), 'utf8'),
);

test('normalizeSwiftEvolution', async (t) => {
  await t.test('maps a proposal to a LibraryResult with a proposals/ URL', () => {
    const out = normalizeSwiftEvolution(fixture.proposals[0]);
    assert.equal(out.id, 'SE-0001');
    assert.equal(out.source, 'swiftevolution');
    assert.equal(out.title, 'Allow (most) keywords as argument labels');
    assert.deepEqual(out.authors, ['Doug Gregor']);
    assert.equal(out.description, 'Status: implemented');
    assert.equal(
      out.url,
      'https://github.com/swiftlang/swift-evolution/blob/main/proposals/0001-keywords-as-argument-labels.md',
    );
  });
});

test('swiftEvolutionSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test(
    'downloads the dataset once and filters by id, title, or summary token',
    async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify(fixture), { status: 200 });
      }) as typeof fetch;
      const out = await swiftEvolutionSearch('argument labels', 5);
      assert.ok(out.length >= 1);
      assert.equal(out[0].id, 'SE-0001');
      await swiftEvolutionSearch('SE-0001', 5);
      assert.equal(calls, 1);
    },
  );
});
