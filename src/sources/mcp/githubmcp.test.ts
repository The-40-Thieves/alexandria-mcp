import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGithubMcpRead, normalizeGithubMcpSearch, splitGithubMcpId } from './githubmcp.js';

// A trimmed version of the real JSON text search_code returned for
// {query: "addEventListener language:javascript"} against
// https://api.githubcopilot.com/mcp/, captured live on 2026-09-02 with a
// temporary personal token (see the task-5 report). Note `repository` is
// a plain "owner/repo" string here, unlike the raw GitHub REST API.
const SEARCH_TEXT = JSON.stringify({
  total_count: 17924096,
  incomplete_results: false,
  items: [
    { name: 'Q.js', path: 'Q.js', sha: 'b3a23bf', repository: 'EGreg/Q.js' },
    { name: 'q.js', path: 'q.js', sha: 'ab2bdbb', repository: 'WITS/Q.js' },
  ],
});

test('normalizeGithubMcpSearch', async (t) => {
  await t.test('maps each item to a LibraryResult keyed by owner/repo#path', () => {
    const out = normalizeGithubMcpSearch(SEARCH_TEXT);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'EGreg/Q.js#Q.js');
    assert.equal(out[0].source, 'githubmcp');
    assert.equal(out[0].url, 'https://github.com/EGreg/Q.js/blob/HEAD/Q.js');
  });

  await t.test('returns an empty array for unparseable text', () => {
    assert.deepEqual(normalizeGithubMcpSearch('not json'), []);
  });

  await t.test('skips an item missing path or repository', () => {
    const out = normalizeGithubMcpSearch(JSON.stringify({ items: [{ name: 'x' }] }));
    assert.deepEqual(out, []);
  });
});

test('splitGithubMcpId', async (t) => {
  await t.test('splits owner/repo#path into get_file_contents arguments', () => {
    assert.deepEqual(splitGithubMcpId('facebook/react#README.md'), {
      owner: 'facebook',
      repo: 'react',
      path: 'README.md',
    });
  });

  await t.test('handles a nested path with slashes', () => {
    assert.deepEqual(splitGithubMcpId('facebook/react#packages/react/src/React.js'), {
      owner: 'facebook',
      repo: 'react',
      path: 'packages/react/src/React.js',
    });
  });
});

test('normalizeGithubMcpRead', async (t) => {
  await t.test('drops the leading summary line and keeps the file content', () => {
    const raw = 'successfully downloaded text file (SHA: abc)\n\n# React\n\nfile body here';
    const out = normalizeGithubMcpRead(raw, 'facebook/react#README.md');
    assert.equal(out.title, 'facebook/react#README.md');
    assert.equal((out as { text?: string }).text, '# React\n\nfile body here');
  });

  await t.test('falls back to a note when there is no blank-line-separated content', () => {
    const out = normalizeGithubMcpRead('', 'facebook/react#README.md');
    assert.match((out as { text?: string }).text ?? '', /No content found/);
  });
});
