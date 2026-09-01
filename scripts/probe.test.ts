import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, regressions } from './probe.js';

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
});
