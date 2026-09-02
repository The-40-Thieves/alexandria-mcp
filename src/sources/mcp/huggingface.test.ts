import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHuggingFace } from './huggingface.ts';

// A trimmed version of the real structuredContent returned by hf_fs for
// `{"operations":[{"cmd":"search","args":["hf://papers","vision language
// models","--limit","5"]}]}` against https://huggingface.co/mcp, captured
// live on 2026-09-02 (see the task-5 report).
const STRUCTURED = {
  results: [
    {
      index: 0,
      status: 'success',
      result: {
        uri: 'hf://papers',
        op: 'search',
        entries: [
          {
            type: 'paper',
            name: '2509.23250',
            path: '2509.23250',
            uri: 'hf://papers/2509.23250',
            title: 'Training Vision-Language Process Reward Models',
            description: 'Hybrid data synthesis improves VL-PRM reliability.',
            upvotes: 6,
            created_at: '2025-09-27T10:56:58.000Z',
            published_at: '2025-09-27T10:56:58.000Z',
            url: 'https://huggingface.co/papers/2509.23250',
            arxiv_url: 'https://arxiv.org/abs/2509.23250',
          },
          {
            type: 'paper',
            name: '2407.06581',
            path: '2407.06581',
            uri: 'hf://papers/2407.06581',
            title: 'Vision language models are blind',
            description: 'State-of-the-art VLMs perform poorly on simple visual tasks.',
            upvotes: 84,
            created_at: '2024-07-09T06:20:17.000Z',
            published_at: '2024-07-09T06:20:17.000Z',
            url: 'https://huggingface.co/papers/2407.06581',
            arxiv_url: 'https://arxiv.org/abs/2407.06581',
          },
        ],
      },
      output_truncated: false,
    },
  ],
};

test('normalizeHuggingFace', async (t) => {
  await t.test('maps each paper entry to a LibraryResult keyed by its arXiv id', () => {
    const out = normalizeHuggingFace('ignored', STRUCTURED);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, '2509.23250');
    assert.equal(out[0].source, 'huggingface');
    assert.equal(out[0].title, 'Training Vision-Language Process Reward Models');
    assert.equal(out[0].year, 2025);
    assert.equal(out[0].hasFullText, true);
    assert.equal(out[1].id, '2407.06581');
    assert.equal(out[1].year, 2024);
  });

  await t.test('returns an empty array when structuredContent is missing or has no entries', () => {
    assert.deepEqual(normalizeHuggingFace('no results found', undefined), []);
    assert.deepEqual(normalizeHuggingFace('', { results: [] }), []);
    assert.deepEqual(
      normalizeHuggingFace('', { results: [{ index: 0, status: 'success', result: {} }] }),
      [],
    );
  });

  await t.test('drops non-paper entries (e.g. a truncation marker with no path)', () => {
    const out = normalizeHuggingFace('', {
      results: [
        {
          index: 0,
          status: 'success',
          result: { entries: [{ type: 'dir', path: 'some/dir' }] },
        },
      ],
    });
    assert.deepEqual(out, []);
  });
});
