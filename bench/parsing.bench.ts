import { test } from 'vitest';
import { normalizeArxiv } from '../src/sources/arxiv.ts';
import { parseFeedItems } from '../src/sources/kinds/rss.ts';
import { fixture } from './fixtures.ts';

const ARXIV_XML = fixture('arxiv-search.xml');
const RSS2 = fixture('rss/rss2.xml');
const ATOM = fixture('rss/atom.xml');
const RDF = fixture('rss/rdf.xml');

test('source response parsing', async ({ bench }) => {
  await bench('normalizeArxiv', () => {
    normalizeArxiv(ARXIV_XML);
  }).run();
  await bench('parseFeedItems rss2', () => {
    parseFeedItems(RSS2);
  }).run();
  await bench('parseFeedItems atom', () => {
    parseFeedItems(ATOM);
  }).run();
  await bench('parseFeedItems rdf', () => {
    parseFeedItems(RDF);
  }).run();
});
