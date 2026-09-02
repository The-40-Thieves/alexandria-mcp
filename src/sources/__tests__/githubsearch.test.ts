import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeGithubSearch } from '../githubsearch.js';
import { getAdapter } from '../registry.js';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/githubsearch-code.json'), 'utf8'),
);

test('normalizeGithubSearch', async (t) => {
  await t.test('maps a code search item to a LibraryResult', () => {
    const out = normalizeGithubSearch(fixture.items[0]);
    assert.equal(out.id, 'octokit/octokit.rb#lib/octokit/rate_limit.rb');
    assert.equal(out.source, 'githubsearch');
    assert.ok(out.title.includes('octokit/octokit.rb'));
    assert.equal(
      out.url,
      'https://github.com/octokit/octokit.rb/blob/main/lib/octokit/rate_limit.rb',
    );
  });
});

test('githubsearch requires GITHUB_TOKEN', async (t) => {
  const originalEnv = process.env.GITHUB_TOKEN;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalEnv;
  });

  await t.test('throws "githubsearch requires GITHUB_TOKEN" when the env is absent', async () => {
    delete process.env.GITHUB_TOKEN;
    await assert.rejects(
      () => getAdapter('githubsearch').search('foo', 5),
      /^Error: githubsearch requires GITHUB_TOKEN$/,
    );
  });
});
