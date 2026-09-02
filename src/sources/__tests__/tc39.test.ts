import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeTc39, tc39Search } from '../tc39.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/tc39-proposals.json'), 'utf8'),
);

test('normalizeTc39', async (t) => {
  await t.test('maps a proposal to a LibraryResult, folding stage into the description', () => {
    const out = normalizeTc39(fixture[0]);
    assert.equal(out.id, 'proposal-amount');
    assert.equal(out.source, 'tc39');
    assert.equal(out.title, 'Amount');
    assert.deepEqual(out.authors, ['Ben Allen']);
    assert.ok(out.description?.startsWith('Stage 2:'));
    assert.equal(out.url, 'https://github.com/tc39/proposal-amount');
  });
});

test('tc39Search', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('downloads the dataset once and filters by name or description token', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const out = await tc39Search('thenable', 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'proposal-thenable-curtailment');
    await tc39Search('amount', 5);
    assert.equal(calls, 1);
  });
});
