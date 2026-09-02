import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { attackSearch, normalizeAttack } from '../attack.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/attack-bundle.json'), 'utf8'),
);

test('normalizeAttack', async (t) => {
  await t.test('maps an attack-pattern object to a LibraryResult', () => {
    const out = normalizeAttack(fixture.objects[0]);
    assert.equal(out.id, 'T1055.011');
    assert.equal(out.source, 'attack');
    assert.equal(out.title, 'T1055.011: Extra Window Memory Injection');
    assert.ok(out.description);
    assert.equal(out.previewUrl, 'https://attack.mitre.org/techniques/T1055/011');
  });
});

test('attackSearch', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test(
    'downloads the bundle once, filters to attack-pattern objects, and matches by token',
    async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify(fixture), { status: 200 });
      }) as typeof fetch;
      const out = await attackSearch('scheduled task', 5);
      assert.equal(out.length, 1);
      assert.equal(out[0].id, 'T1053.005');
      // The fixture's third object is a course-of-action, not an
      // attack-pattern; an unscoped query must not surface it.
      const all = await attackSearch('', 5);
      assert.ok(all.every((r) => r.id.startsWith('T')));
      // A second call in the same process should hit the module-level cache,
      // not download the bundle again.
      await attackSearch('injection', 5);
      assert.equal(calls, 1);
    },
  );
});
