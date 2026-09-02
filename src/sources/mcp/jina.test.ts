import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeJinaArxiv, normalizeJinaRead, normalizeJinaWeb, parseYamlHit } from './jina.js';

// Ground truth for jina's per-hit YAML formatting: generated with the
// `yaml` npm package's stringify() (the same one jina's own MCP server
// uses per its published source) against representative hit shapes, and
// captured verbatim on 2026-09-02 (see the task-5 report). A short hit,
// a hit with a colon and a long folded snippet (no block-scalar marker,
// just indented continuation lines), and an arXiv hit with an authors
// array.
const SHORT_HIT = `title: OpenAI announces GPT-6
url: https://example.com/a
snippet: A short snippet here.
date: 2026-08-30`;

const LONG_HIT = `title: "Report: economy grows 3%, says Fed"
url: https://example.com/b?x=1&y=2
snippet: This is a considerably longer snippet of text that describes the search
  result content in more detail than the short one above, spanning what could
  end up being multiple wrapped lines depending on the line width settings used
  by the yaml stringifier when it decides to fold long scalar strings.
date: 2026-08-29`;

const ARXIV_HIT = `title: Vision-Language Models Survey
url: https://arxiv.org/abs/2407.06581
snippet: A survey of vision language models and their capabilities.
authors:
  - Jane Doe
  - John Smith
date: 2024-07-09
arxiv_id: "2407.06581"`;

test('parseYamlHit', async (t) => {
  await t.test('parses a flat hit with plain scalar values', () => {
    const hit = parseYamlHit(SHORT_HIT);
    assert.equal(hit.title, 'OpenAI announces GPT-6');
    assert.equal(hit.url, 'https://example.com/a');
    assert.equal(hit.snippet, 'A short snippet here.');
    assert.equal(hit.date, '2026-08-30');
  });

  await t.test('unquotes a quoted title and rejoins a folded multi-line snippet', () => {
    const hit = parseYamlHit(LONG_HIT);
    assert.equal(hit.title, 'Report: economy grows 3%, says Fed');
    assert.equal(hit.url, 'https://example.com/b?x=1&y=2');
    assert.equal(
      hit.snippet,
      'This is a considerably longer snippet of text that describes the search result content in more detail than the short one above, spanning what could end up being multiple wrapped lines depending on the line width settings used by the yaml stringifier when it decides to fold long scalar strings.',
    );
    assert.equal(hit.date, '2026-08-29');
  });

  await t.test('parses an authors list and unquotes a quoted arxiv_id', () => {
    const hit = parseYamlHit(ARXIV_HIT);
    assert.deepEqual(hit.authors, ['Jane Doe', 'John Smith']);
    assert.equal(hit.arxiv_id, '2407.06581');
  });
});

test('normalizeJinaWeb', async (t) => {
  await t.test('maps each blank-line-separated hit to a LibraryResult keyed by its url', () => {
    const out = normalizeJinaWeb(`${SHORT_HIT}\n\n${LONG_HIT}`);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'https://example.com/a');
    assert.equal(out[0].source, 'jina');
    assert.equal(out[0].title, 'OpenAI announces GPT-6');
    assert.equal(out[0].published, '2026-08-30');
    assert.equal(out[1].title, 'Report: economy grows 3%, says Fed');
  });

  await t.test('drops an "Error: ..." result instead of mis-parsing it', () => {
    assert.deepEqual(normalizeJinaWeb('Error: Search failed for query "x": Unauthorized'), []);
  });

  await t.test('returns an empty array for no hits', () => {
    assert.deepEqual(normalizeJinaWeb(''), []);
  });
});

test('normalizeJinaArxiv', async (t) => {
  await t.test('keys a result by its arxiv_id and carries authors through', () => {
    const out = normalizeJinaArxiv(ARXIV_HIT);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '2407.06581');
    assert.equal(out[0].source, 'jinaarxiv');
    assert.deepEqual(out[0].authors, ['Jane Doe', 'John Smith']);
  });

  await t.test('falls back to the url as id when arxiv_id is absent', () => {
    const out = normalizeJinaArxiv(SHORT_HIT);
    assert.equal(out[0].id, 'https://example.com/a');
  });
});

test('normalizeJinaRead', async (t) => {
  await t.test('wraps the tool text as the read result', () => {
    const out = normalizeJinaRead('page content here', 'https://example.com/a');
    assert.equal(out.title, 'https://example.com/a');
    assert.equal((out as { text?: string }).text, 'page content here');
  });
});
