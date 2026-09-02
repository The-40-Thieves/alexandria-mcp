import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext7Mcp, normalizeContext7McpRead, parseLibraryList } from './context7mcp.js';

// The real text resolve-library-id returned for {query: "react",
// libraryName: "react"} against https://mcp.context7.com/mcp, captured
// live on 2026-09-02 (see the task-5 report).
const RESOLVE_TEXT = `Available Libraries:

- Title: React
- Context7-compatible library ID: /reactjs/react.dev
- Description: React.dev is the official documentation website for React, a JavaScript library for building user interfaces, providing guides, API references, and tutorials.
- Code Snippets: 5957
- Source Reputation: High
- Benchmark Score: 88.88
- Versions: __branch__v18
----------
- Title: React
- Context7-compatible library ID: /react/react
- Description: React is a JavaScript library for building user interfaces.
- Code Snippets: 6246
- Source Reputation: High
- Benchmark Score: 69.6
- Versions: v19.2.7, v18.2.0`;

test('parseLibraryList', async (t) => {
  await t.test('splits the dash-separated blocks into title/id/description', () => {
    const out = parseLibraryList(RESOLVE_TEXT);
    assert.equal(out.length, 2);
    assert.equal(out[0].title, 'React');
    assert.equal(out[0].id, '/reactjs/react.dev');
    assert.match(out[0].description ?? '', /official documentation website/);
    assert.equal(out[1].id, '/react/react');
  });

  await t.test('returns an empty array for text with no library blocks', () => {
    assert.deepEqual(parseLibraryList('No libraries found.'), []);
  });
});

test('normalizeContext7Mcp', async (t) => {
  await t.test('maps each library to a LibraryResult', () => {
    const out = normalizeContext7Mcp(RESOLVE_TEXT);
    assert.equal(out.length, 2);
    assert.equal(out[0].source, 'context7mcp');
    assert.equal(out[0].id, '/reactjs/react.dev');
    assert.equal(out[0].title, 'React');
    assert.equal(out[0].hasFullText, true);
    assert.equal(out[0].previewUrl, 'https://context7.com/reactjs/react.dev');
  });
});

test('normalizeContext7McpRead', async (t) => {
  await t.test('truncates and titles the read result by id', () => {
    const out = normalizeContext7McpRead('some docs text', '/reactjs/react.dev');
    assert.equal(out.title, '/reactjs/react.dev');
    assert.equal((out as { text?: string }).text, 'some docs text');
  });

  await t.test('falls back to a note when the tool returns no text', () => {
    const out = normalizeContext7McpRead('', '/reactjs/react.dev');
    assert.match((out as { text?: string }).text ?? '', /No documentation found/);
  });
});
