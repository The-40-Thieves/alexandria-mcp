import { test } from 'vitest';
import { chunkSemantic, indexText } from '../src/pipeline/index.ts';
import {
  cleanArchiveText,
  cleanGutenbergText,
  ocrQualityScore,
  stripHtml,
} from '../src/utils/text-clean.ts';
import { book, fixture, gutenbergBook } from './fixtures.ts';

const BOOK = book(20, 30);
const GUTENBERG_RAW = gutenbergBook(20, 30);
const STANDARD_EBOOKS_HTML = fixture('standardebooks-read.html');
const PERSEUS_GREEK = fixture('perseus-passage.txt');
const ENGLISH_CHUNK = book(1, 6);
const METADATA = {
  source: 'gutenberg' as const,
  sourceId: '1342',
  title: 'Benchmark Tales',
  authors: ['Anonymous'],
  year: 1900,
  language: 'en',
};

test('text cleaning', async ({ bench }) => {
  await bench('cleanGutenbergText', () => {
    cleanGutenbergText(GUTENBERG_RAW);
  }).run();
  await bench('stripHtml standardebooks page', () => {
    stripHtml(STANDARD_EBOOKS_HTML);
  }).run();
  await bench('cleanArchiveText html', () => {
    cleanArchiveText(STANDARD_EBOOKS_HTML);
  }).run();
});

test('ocrQualityScore', async ({ bench }) => {
  await bench('english chunk', () => {
    ocrQualityScore(ENGLISH_CHUNK);
  }).run();
  await bench('greek passage', () => {
    ocrQualityScore(PERSEUS_GREEK);
  }).run();
});

test('chunking', async ({ bench }) => {
  await bench('chunkSemantic book', () => {
    chunkSemantic(BOOK, METADATA);
  }).run();
  await bench('indexText book', () => {
    indexText(BOOK, 'gutenberg', '1342', 'Benchmark Tales', ['Anonymous'], 1900, 'en');
  }).run();
});
