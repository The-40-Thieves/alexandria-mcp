import assert from 'node:assert/strict';
import test from 'node:test';
import type { LibraryResult } from '../types.ts';
import { formatResult } from './format.ts';
import type { AskResult } from './libraryAsk.ts';

const fixtureResult: LibraryResult = {
  id: 'abc123',
  source: 'arxiv',
  title: 'A Paper About Diffusion Models',
  authors: ['A. Researcher', 'B. Researcher'],
  year: 2024,
  language: 'en',
  subjects: ['cs.LG'],
  hasFullText: true,
  previewUrl: 'https://example.org/preview',
  downloadUrl: 'https://example.org/download',
  description: 'An extended abstract describing the paper in detail.',
  published: '2024-01-01',
  url: 'https://example.org/abc123',
  cluster: 'ai_research',
};

const fixtureAsk: AskResult = {
  query: 'diffusion models',
  intent: 'find recent papers on diffusion models',
  sources_searched: ['arxiv', 'semanticscholar'],
  total_results: 1,
  results: [fixtureResult],
  routing: [{ source: 'arxiv', query: 'diffusion models', reason: 'top academic match' }],
  errors: [{ source: 'semanticscholar', error: 'timeout' }],
  stage1: 'embeddings',
  stage2: 'llm',
};

test('formatResult: detailed returns the payload unchanged', () => {
  assert.equal(formatResult('ask', fixtureAsk, 'detailed'), fixtureAsk);
  assert.equal(
    formatResult('search', { results: [fixtureResult] }, 'detailed').results[0],
    fixtureResult,
  );
});

test('formatResult(ask, ..., concise): keys are a strict subset of detailed, per result row too', () => {
  const detailed = formatResult('ask', fixtureAsk, 'detailed');
  const concise = formatResult('ask', fixtureAsk, 'concise');

  for (const key of Object.keys(concise)) {
    assert.ok(key in detailed, `concise key "${key}" is not present on the detailed result`);
  }

  assert.deepEqual(concise.results, [
    {
      title: fixtureResult.title,
      source: fixtureResult.source,
      id: fixtureResult.id,
      hasFullText: fixtureResult.hasFullText,
      year: fixtureResult.year,
      url: fixtureResult.url,
    },
  ]);
  for (const key of Object.keys(concise.results[0])) {
    assert.ok(
      key in detailed.results[0],
      `concise result row key "${key}" is not present on the detailed row`,
    );
  }

  // routing collapses to plain source names, not the { source, query,
  // reason } shape it carries in detailed mode.
  assert.deepEqual(concise.routing, ['arxiv']);

  // stage1/stage2 are detailed-only diagnostics, dropped in concise mode.
  assert.ok(!('stage1' in concise));
  assert.ok(!('stage2' in concise));
});

test('formatResult(search, ..., concise): result rows drop authors/description/etc., keeping the wrapper shape', () => {
  const detailed = formatResult('search', { results: [fixtureResult] }, 'detailed');
  const concise = formatResult('search', { results: [fixtureResult] }, 'concise');

  assert.deepEqual(Object.keys(concise), Object.keys(detailed));
  for (const key of Object.keys(concise.results[0])) {
    assert.ok(key in detailed.results[0]);
  }
  assert.ok(!('authors' in concise.results[0]));
  assert.ok(!('description' in concise.results[0]));
});

test('formatResult(answer, ..., concise): keeps only answer + citations', () => {
  const fixtureAnswer = {
    answer: 'The answer, cited [1].',
    citations: [{ n: 1, source: 'arxiv', id: 'abc123', title: fixtureResult.title }],
    results: [{ ...fixtureResult, score: 0.9 }],
    routing: fixtureAsk.routing,
    warnings: [] as string[],
  };

  const detailed = formatResult('answer', fixtureAnswer, 'detailed');
  const concise = formatResult('answer', fixtureAnswer, 'concise');

  assert.deepEqual(concise, { answer: fixtureAnswer.answer, citations: fixtureAnswer.citations });
  for (const key of Object.keys(concise)) {
    assert.ok(key in detailed);
  }
  assert.ok(!('results' in concise));
  assert.ok(!('routing' in concise));
  assert.ok(!('warnings' in concise));
});

test('formatResult(research, ..., concise): keeps only report + citations', () => {
  const fixtureResearch = {
    report: 'A report, cited [1].',
    citations: [{ n: 1, source: 'arxiv', id: 'abc123', title: fixtureResult.title }],
    rounds: [{ round: 1, queries: ['q1'], newSources: 1, truncated: false }],
    elapsedMs: 1234,
    warnings: [] as string[],
  };

  const detailed = formatResult('research', fixtureResearch, 'detailed');
  const concise = formatResult('research', fixtureResearch, 'concise');

  assert.deepEqual(concise, {
    report: fixtureResearch.report,
    citations: fixtureResearch.citations,
  });
  for (const key of Object.keys(concise)) {
    assert.ok(key in detailed);
  }
  assert.ok(!('rounds' in concise));
  assert.ok(!('elapsedMs' in concise));
});
