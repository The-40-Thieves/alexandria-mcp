import assert from 'node:assert/strict';
import test from 'node:test';
import { runbergSearch } from '../projectruneberg.js';

test('runbergSearch', async (t) => {
  await t.test('finds book by exact title', () => {
    const results = runbergSearch('Jerusalem', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'selma-jerusalem');
  });

  await t.test('finds book by author', () => {
    const results = runbergSearch('Ibsen', 10);
    assert.equal(results.length, 2);
    assert.ok(results.some((r) => r.id === 'ibsen-doll-house'));
    assert.ok(results.some((r) => r.id === 'ibsen-peer-gynt'));
  });

  await t.test('is case insensitive', () => {
    const results = runbergSearch('ibsen', 10);
    assert.equal(results.length, 2);
  });

  await t.test('respects limit', () => {
    const results = runbergSearch('Ibsen', 1);
    assert.equal(results.length, 1);
  });

  await t.test('returns empty array when no matches', () => {
    const results = runbergSearch('Harry Potter', 10);
    assert.equal(results.length, 0);
  });

  await t.test('finds book by subject', () => {
    const results = runbergSearch('Fairy', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'andersen-fairy-tales');
  });

  await t.test('handles multiple terms (AND logic roughly)', () => {
    const results = runbergSearch('Henrik doll', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'ibsen-doll-house');
  });

  await t.test('handles extra spaces in query', () => {
    const results = runbergSearch('   Henrik    doll   ', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'ibsen-doll-house');
  });

  await t.test('handles empty query', () => {
    const results = runbergSearch('     ', 10);
    assert.equal(results.length, 0);
  });
});
