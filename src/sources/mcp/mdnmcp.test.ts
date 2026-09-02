import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMdnMcp, normalizeMdnMcpRead, parseMdnSearch } from './mdnmcp.ts';

// A trimmed version of the real text `search` returned for {query:
// "Array.prototype.map"} against https://mcp.mdn.mozilla.net/, captured
// live on 2026-09-02 (see the task-5 report).
const SEARCH_TEXT = `# Array.prototype.map()
\`path\`: \`/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map\`
\`compat-key\`: \`javascript.builtins.Array.map\`
The map() method of Array instances creates
a new array populated with the results of calling a provided function on
every element in the calling array.

# Array.prototype.flatMap()
\`path\`: \`/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flatMap\`
\`compat-key\`: \`javascript.builtins.Array.flatMap\`
The flatMap() method returns a new array formed by applying a callback to each element.`;

test('parseMdnSearch', async (t) => {
  await t.test('splits "# Title" blocks and extracts path + summary', () => {
    const out = parseMdnSearch(SEARCH_TEXT);
    assert.equal(out.length, 2);
    assert.equal(out[0].title, 'Array.prototype.map()');
    assert.equal(out[0].path, '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map');
    assert.match(out[0].summary ?? '', /creates.*a new array populated/);
    assert.equal(out[1].title, 'Array.prototype.flatMap()');
  });

  await t.test('returns an empty array for text with no "#" blocks', () => {
    assert.deepEqual(parseMdnSearch('No results.'), []);
  });
});

test('normalizeMdnMcp', async (t) => {
  await t.test('maps each entry to a LibraryResult keyed by its path', () => {
    const out = normalizeMdnMcp(SEARCH_TEXT);
    assert.equal(out.length, 2);
    assert.equal(out[0].source, 'mdnmcp');
    assert.equal(out[0].id, '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map');
    assert.equal(out[0].hasFullText, true);
    assert.equal(
      out[0].url,
      'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
    );
  });
});

test('normalizeMdnMcpRead', async (t) => {
  await t.test('wraps the tool text as the read result', () => {
    const out = normalizeMdnMcpRead('# Array.prototype.map()\n\nfull doc text', '/en-US/docs/x');
    assert.equal(out.title, '/en-US/docs/x');
    assert.match((out as { text?: string }).text ?? '', /full doc text/);
  });
});
