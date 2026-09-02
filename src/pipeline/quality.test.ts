import assert from 'node:assert';
import test from 'node:test';
import type { Chunk } from '../types.ts';
import { ocrQualityScore } from '../utils/text-clean.ts';
import {
  avgQuality,
  DEFAULT_QUALITY_THRESHOLD,
  filterChunks,
  MIN_CHUNK_LENGTH,
  scoreChunk,
} from './quality.ts';

test('DEFAULT_QUALITY_THRESHOLD is 0.75', () => {
  assert.strictEqual(DEFAULT_QUALITY_THRESHOLD, 0.75);
});

test('MIN_CHUNK_LENGTH is 100', () => {
  assert.strictEqual(MIN_CHUNK_LENGTH, 100);
});

test('ocrQualityScore tests', async (t) => {
  await t.test('clean ASCII text', () => {
    const text = 'This is clean ASCII text with some punctuation, right? Yes.';
    const score = ocrQualityScore(text);
    // Almost everything should match the clean regex
    assert.ok(score > 0.9);
  });

  await t.test('Unicode text (Greek) is readable', () => {
    const greek = 'Μῆνιν ἄειδε θεὰ Πηληϊάδεω Ἀχιλῆος οὐλομένην, ἣ μυρίʼ Ἀχαιοῖς ἄλγεʼ ἔθηκε';
    const score = ocrQualityScore(greek);
    assert.ok(score > 0.75);
  });

  await t.test('Unicode text (Arabic) is readable', () => {
    const arabic = 'الخط العربي هو فن وتصميم الكتابة في مختلف اللغات التي تستعمل الحروف العربية.';
    const score = ocrQualityScore(arabic);
    assert.ok(score > 0.75);
  });

  await t.test('Unicode text (Chinese) is readable', () => {
    const chinese = '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。';
    const score = ocrQualityScore(chinese);
    assert.ok(score > 0.75);
  });

  await t.test('empty input', () => {
    assert.strictEqual(ocrQualityScore(''), 0);
  });
});

test('scoreChunk assigns qualityScore', () => {
  const dummyChunk: Chunk = {
    text: 'A simple, clean chunk of text.',
    metadata: {
      source: 'gutenberg',
      sourceId: '123',
      title: 'Dummy Title',
      authors: [],
      chunkIndex: 0,
      totalChunks: 1,
      qualityScore: 0,
    },
  };

  const scoredChunk = scoreChunk(dummyChunk);
  assert.ok(scoredChunk.metadata.qualityScore > 0);
  assert.strictEqual(scoredChunk.text, dummyChunk.text);
});

test('filterChunks tests', async (t) => {
  const createChunk = (text: string, qualityScore: number): Chunk => ({
    text,
    metadata: {
      source: 'gutenberg',
      sourceId: '123',
      title: 'Title',
      authors: [],
      chunkIndex: 0,
      totalChunks: 1,
      qualityScore,
    },
  });

  const validText = 'a'.repeat(MIN_CHUNK_LENGTH); // Length exactly MIN_CHUNK_LENGTH
  const shortText = 'a'.repeat(MIN_CHUNK_LENGTH - 1); // Below MIN_CHUNK_LENGTH

  await t.test('passes valid chunks', () => {
    const chunks = [createChunk(validText, DEFAULT_QUALITY_THRESHOLD), createChunk(validText, 1.0)];
    const result = filterChunks(chunks);
    assert.strictEqual(result.passed.length, 2);
    assert.strictEqual(result.dropped, 0);
  });

  await t.test('drops chunks below threshold', () => {
    const chunks = [
      createChunk(validText, DEFAULT_QUALITY_THRESHOLD - 0.01),
      createChunk(validText, 0.5),
    ];
    const result = filterChunks(chunks);
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.dropped, 2);
  });

  await t.test('drops chunks below minimum length', () => {
    const chunks = [createChunk(shortText, 1.0)];
    const result = filterChunks(chunks);
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.dropped, 1);
  });

  await t.test('handles empty string properly (drops)', () => {
    const chunks = [
      createChunk('', 1.0), // It should drop because length is < MIN_CHUNK_LENGTH
    ];
    const result = filterChunks(chunks);
    assert.strictEqual(result.passed.length, 0);
    assert.strictEqual(result.dropped, 1);
  });
});

test('avgQuality tests', async (t) => {
  const createChunk = (qualityScore: number): Chunk => ({
    text: '',
    metadata: {
      source: 'gutenberg',
      sourceId: '123',
      title: 'Title',
      authors: [],
      chunkIndex: 0,
      totalChunks: 1,
      qualityScore,
    },
  });

  await t.test('empty array', () => {
    assert.strictEqual(avgQuality([]), 0);
  });

  await t.test('calculates average correctly', () => {
    const chunks = [createChunk(0.5), createChunk(1.0), createChunk(0.75)];
    assert.strictEqual(avgQuality(chunks), 0.75);
  });
});
