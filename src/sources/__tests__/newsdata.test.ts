import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeNewsdata } from '../newsdata.ts';
import { getAdapter } from '../registry.ts';

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'eval/fixtures/newsdata-latest.json'), 'utf8'),
);

test('normalizeNewsdata', async (t) => {
  await t.test('maps an article to a LibraryResult', () => {
    const out = normalizeNewsdata(fixture.results[0]);
    assert.ok(out);
    assert.equal(out?.id, 'abc123');
    assert.equal(out?.source, 'newsdata');
    assert.ok(out?.title.includes('Central bank'));
    assert.equal(out?.year, 2026);
    assert.equal(out?.url, 'https://example.com/news/central-bank-rates');
  });

  await t.test('drops an article with no article_id', () => {
    assert.equal(normalizeNewsdata({ article_id: '', title: 'x' }), null);
  });
});

test('newsdata requires NEWSDATA_API_KEY', async (t) => {
  const originalEnv = process.env.NEWSDATA_API_KEY;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.NEWSDATA_API_KEY;
    else process.env.NEWSDATA_API_KEY = originalEnv;
  });

  await t.test('throws "newsdata requires NEWSDATA_API_KEY" when the env is absent', async () => {
    delete process.env.NEWSDATA_API_KEY;
    await assert.rejects(
      () => getAdapter('newsdata').search('economy', 5),
      /^Error: newsdata requires NEWSDATA_API_KEY$/,
    );
  });
});
