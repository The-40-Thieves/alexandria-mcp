import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, EXPECTED_EMPTY, regressions } from './probe.js';

test('probe classification', async (t) => {
  await t.test('OK when results present', () => {
    assert.equal(classify({ results: [{ id: '1' }] as any, error: null }), 'OK');
  });
  await t.test('EMPTY when zero results', () => {
    assert.equal(classify({ results: [], error: null }), 'EMPTY');
  });
  await t.test('TIMEOUT when aborted', () => {
    assert.equal(
      classify({ results: null, error: new Error('This operation was aborted') }),
      'TIMEOUT',
    );
  });
  await t.test('ERROR otherwise', () => {
    assert.equal(classify({ results: null, error: new Error('HTTP 500') }), 'ERROR');
  });
  await t.test('KEY_MISSING when the error names a missing key/token/env', () => {
    assert.equal(
      classify({ results: null, error: new Error('CORE_API_KEY is not set') }),
      'ERROR', // "is not set" doesn't match "requires .* (key|token|env)" — see next cases
    );
    assert.equal(
      classify({
        results: null,
        error: new Error('Trove requires a free API key. Register at: ...'),
      }),
      'KEY_MISSING',
    );
    assert.equal(
      classify({
        results: null,
        error: new Error('YOUTUBE_API_KEY is required for the youtube source'),
      }),
      'ERROR', // "is required" doesn't match "requires" either — see openiti-style wording below
    );
    assert.equal(
      classify({
        results: null,
        error: new Error('openiti requires a GITHUB_TOKEN environment variable'),
      }),
      'KEY_MISSING',
    );
  });

  await t.test('regressions lists sources that were OK and are not', () => {
    const base = { a: { status: 'OK' }, b: { status: 'ERROR' } } as any;
    const now = { a: { status: 'ERROR' }, b: { status: 'OK' } } as any;
    assert.deepEqual(regressions(base, now), ['a']);
  });
  await t.test('regressions does not flag a source absent from the current run', () => {
    // A source dropped from the registry (e.g. deleted) disappears from
    // `now` entirely; that is a deliberate removal, not a regression.
    const base = { a: { status: 'OK' }, dropped: { status: 'OK' } } as any;
    const now = { a: { status: 'OK' } } as any;
    assert.deepEqual(regressions(base, now), []);
  });
  await t.test(
    'regressions does not flag OK -> KEY_MISSING for a source that declares auth',
    () => {
      const base = { keyed: { status: 'OK' } } as any;
      const now = { keyed: { status: 'KEY_MISSING' } } as any;
      assert.deepEqual(
        regressions(base, now, (s) => s === 'keyed'),
        [],
      );
    },
  );
  await t.test('regressions DOES flag OK -> KEY_MISSING for a source with no auth declared', () => {
    const base = { keyless: { status: 'OK' } } as any;
    const now = { keyless: { status: 'KEY_MISSING' } } as any;
    assert.deepEqual(
      regressions(base, now, () => false),
      ['keyless'],
    );
  });
  await t.test('regressions does not flag OK -> EMPTY for an EXPECTED_EMPTY source', () => {
    assert.ok(EXPECTED_EMPTY.has('hathitrust'));
    const base = { hathitrust: { status: 'OK' } } as any;
    const now = { hathitrust: { status: 'EMPTY' } } as any;
    assert.deepEqual(regressions(base, now), []);
  });
  await t.test('regressions DOES flag OK -> EMPTY for a source not in EXPECTED_EMPTY', () => {
    const base = { other: { status: 'OK' } } as any;
    const now = { other: { status: 'EMPTY' } } as any;
    assert.deepEqual(regressions(base, now), ['other']);
  });
});
