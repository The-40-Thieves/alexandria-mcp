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

test('formatResult(answer, ..., concise): keeps answer + citations + warnings, drops grade/resolves', () => {
  const fixtureAnswer = {
    answer: 'The answer, cited [1].',
    citations: [
      {
        n: 1,
        source: 'arxiv',
        id: 'abc123',
        title: fixtureResult.title,
        grade: { tier: 'A' as const, signals: { sourceTier: 1 as const, fullTextVerified: true } },
        resolves: true,
      },
    ],
    results: [{ ...fixtureResult, score: 0.9 }],
    routing: fixtureAsk.routing,
    warnings: ['answer contains no citation markers'],
  };

  const detailed = formatResult('answer', fixtureAnswer, 'detailed');
  const concise = formatResult('answer', fixtureAnswer, 'concise');

  assert.deepEqual(concise, {
    answer: fixtureAnswer.answer,
    citations: [{ n: 1, source: 'arxiv', id: 'abc123', title: fixtureResult.title }],
    warnings: fixtureAnswer.warnings,
  });
  for (const key of Object.keys(concise)) {
    assert.ok(key in detailed);
  }
  assert.ok(!('grade' in concise.citations[0]), 'grade is detailed-only');
  assert.ok(!('resolves' in concise.citations[0]), 'resolves is detailed-only');
  assert.ok(!('results' in concise));
  assert.ok(!('routing' in concise));
});

test('formatResult(citations, ..., concise): result rows collapse to ConciseResultRow, seed/direction/formatted pass through', () => {
  const fixtureCitations = {
    seed: { id: '10.1000/seed', source: 'crossref', doi: '10.1000/seed' },
    direction: 'references' as const,
    results: [fixtureResult],
    formatted: '@article{x}',
  };

  const detailed = formatResult('citations', fixtureCitations, 'detailed');
  const concise = formatResult('citations', fixtureCitations, 'concise');

  assert.equal(detailed, fixtureCitations);
  assert.deepEqual(concise.seed, fixtureCitations.seed);
  assert.equal(concise.direction, 'references');
  assert.equal(concise.formatted, '@article{x}');
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
});

test('formatResult(citations, ..., concise): omits formatted when the detailed payload never had one', () => {
  const fixtureCitations = {
    seed: { id: '10.1000/seed', source: 'crossref' },
    direction: 'citations' as const,
    results: [] as LibraryResult[],
  };
  const concise = formatResult('citations', fixtureCitations, 'concise');
  assert.ok(!('formatted' in concise));
});

test('formatResult(research, ..., concise): keeps report + citations + warnings, drops grade/resolves', () => {
  const fixtureResearch = {
    report: 'A report, cited [1].',
    citations: [
      {
        n: 1,
        source: 'arxiv',
        id: 'abc123',
        title: fixtureResult.title,
        grade: { tier: 'B' as const, signals: { sourceTier: 2 as const, fullTextVerified: true } },
      },
    ],
    rounds: [{ round: 1, queries: ['q1'], newSources: 1, truncated: false }],
    elapsedMs: 1234,
    warnings: ['a fact-check warning'],
  };

  const detailed = formatResult('research', fixtureResearch, 'detailed');
  const concise = formatResult('research', fixtureResearch, 'concise');

  assert.deepEqual(concise, {
    report: fixtureResearch.report,
    citations: [{ n: 1, source: 'arxiv', id: 'abc123', title: fixtureResult.title }],
    warnings: fixtureResearch.warnings,
  });
  for (const key of Object.keys(concise)) {
    assert.ok(key in detailed);
  }
  assert.ok(!('grade' in concise.citations[0]), 'grade is detailed-only');
  assert.ok(!('rounds' in concise));
  assert.ok(!('elapsedMs' in concise));
});
