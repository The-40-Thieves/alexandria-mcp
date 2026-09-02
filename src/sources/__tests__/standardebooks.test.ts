import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractStandardEbooksText, normalizeStandardEbooksSearch } from '../standardebooks.js';

const searchHtml = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/standardebooks-search.html'),
  'utf8',
);
const readHtml = readFileSync(
  path.resolve(process.cwd(), 'eval/fixtures/standardebooks-read.html'),
  'utf8',
);

test('normalizeStandardEbooksSearch', async (t) => {
  await t.test('parses li entries from the /ebooks?query= results page', () => {
    const out = normalizeStandardEbooksSearch(searchHtml, 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'joseph-jacobs/indian-fairy-tales');
    assert.equal(out[0].title, 'Indian Fairy Tales');
    assert.deepEqual(out[0].authors, ['Joseph Jacobs']);
    assert.equal(out[0].previewUrl, 'https://standardebooks.org/ebooks/joseph-jacobs/indian-fairy-tales');
    assert.equal(out[0].hasFullText, true);
  });

  await t.test('respects limit', () => {
    assert.equal(normalizeStandardEbooksSearch(searchHtml, 1).length, 1);
  });

  await t.test('handles a page with no results', () => {
    assert.deepEqual(normalizeStandardEbooksSearch('<html><body></body></html>', 10), []);
  });

  await t.test('ignores unrelated <li> elements (e.g. nav menus) outside the results list', () => {
    const withNav = `<html><body><ul><li><a href="/about">About</a></li></ul>${searchHtml}</body></html>`;
    const out = normalizeStandardEbooksSearch(withNav, 10);
    assert.equal(out.length, 2);
  });
});

test('extractStandardEbooksText', async (t) => {
  await t.test('strips script/style and extracts body-only text from the single-page HTML', () => {
    const { text, title } = extractStandardEbooksText(readHtml, 'joseph-jacobs/indian-fairy-tales');
    assert.equal(title, 'Indian Fairy Tales');
    assert.match(text, /Indian Fairy Tales/);
    assert.match(text, /By\s+Joseph Jacobs/);
    // The single <style> block in <head> must not leak into the body text.
    assert.doesNotMatch(text, /font-family|text-indent|@media/);
  });
});

