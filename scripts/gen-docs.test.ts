import assert from 'node:assert/strict';
import test from 'node:test';
import type { listSources } from '../src/sources/registry.ts';
import {
  buildEnvBlock,
  buildHealthExample,
  buildReadmeSourcesBlock,
  buildSourcesDoc,
  spliceMarked,
} from './gen-docs.ts';

type Source = ReturnType<typeof listSources>[number];

function source(overrides: Partial<Source> & Pick<Source, 'name'>): Source {
  return {
    description: 'A test source.',
    supportsIngest: false,
    kind: 'rest',
    cluster: 'literature',
    freshness: 'static',
    hidden: false,
    ...overrides,
  } as Source;
}

const FIXTURES: Source[] = [
  source({ name: 'alpha', cluster: 'literature', description: 'Alpha: a literature source.' }),
  source({
    name: 'beta',
    cluster: 'academic',
    kind: 'mcp',
    hidden: true,
    auth: { type: 'bearer', env: 'BETA_API_KEY' },
    optionalEnv: ['BETA_EXTRA_KEY'],
    verifiedAt: '2026-01-01',
    description: 'Beta: an academic source. Requires BETA_API_KEY.',
  }),
  source({
    name: 'gamma',
    cluster: 'academic',
    kind: 'rss',
    description: 'Gamma: another academic source.',
  }),
];

test('buildSourcesDoc', async (t) => {
  await t.test('groups by cluster, sorted, with counts and a hidden marker', () => {
    const doc = buildSourcesDoc(FIXTURES);
    assert.match(doc, /## academic \(2\)/);
    assert.match(doc, /## literature \(1\)/);
    // academic comes before literature alphabetically
    assert.ok(doc.indexOf('## academic') < doc.indexOf('## literature'));
    assert.match(
      doc,
      /beta \*\(hidden\)\* \| mcp \| academic \| static \| BETA_API_KEY \| BETA_EXTRA_KEY \| 2026-01-01/,
    );
    // A source with no optional envs gets a dash in that column.
    assert.match(doc, /alpha \| rest \| literature \| static \| none \| - \| - \|/);
    assert.match(doc, /\| \*\*Total\*\* \| 3 \| 1 \|/);
  });

  await t.test('escapes a pipe character in a description', () => {
    const doc = buildSourcesDoc([source({ name: 'pipey', description: 'a | b' })]);
    assert.match(doc, /a \\\| b/);
  });
});

test('buildReadmeSourcesBlock', async (t) => {
  await t.test('wraps the summary table in the sources markers', () => {
    const block = buildReadmeSourcesBlock(FIXTURES);
    assert.ok(block.startsWith('<!-- sources:start -->'));
    assert.ok(block.endsWith('<!-- sources:end -->'));
    assert.match(block, /## Sources \(3\)/);
    assert.match(block, /\| academic \| 2 \| 1 \|/);
    assert.match(block, /\| \*\*Total\*\* \| 3 \| 1 \|/);
  });
});

test('buildHealthExample', async (t) => {
  await t.test('reports total, visible, hidden, and per-kind counts', () => {
    const example = buildHealthExample(FIXTURES);
    assert.match(example, /sources: \{ total: 3, visible: 2, hidden: 1, calls: 0, errors: 0 \}/);
    assert.match(example, /rest: 1/);
    assert.match(example, /mcp: 1/);
    assert.match(example, /rss: 1/);
    assert.match(example, /hub: 0/);
    assert.match(example, /scrape: 0/);
  });
});

test('buildEnvBlock', async (t) => {
  await t.test('lists a source-declared auth env with its source name', () => {
    const block = buildEnvBlock(FIXTURES);
    assert.match(block, /# beta: Beta: an academic source\. Requires BETA_API_KEY\./);
    assert.match(block, /^BETA_API_KEY=$/m);
  });

  await t.test('a feature env name shared with a source auth env appears only once', () => {
    const withOverlap = [
      ...FIXTURES,
      source({ name: 'delta', auth: { type: 'bearer', env: 'JINA_API_KEY' } }),
    ];
    const block = buildEnvBlock(withOverlap);
    const occurrences = block.split('\nJINA_API_KEY=').length - 1;
    assert.equal(occurrences, 1);
  });

  await t.test('an optionalEnv gets its own section, separate from the required keys', () => {
    const withOptional = [
      ...FIXTURES,
      source({ name: 'epsilon', optionalEnv: ['EPSILON_OPTIONAL_KEY'] }),
    ];
    const block = buildEnvBlock(withOptional);
    assert.match(block, /# .. Optional source keys/);
    assert.match(block, /^# epsilon$/m);
    assert.match(block, /^EPSILON_OPTIONAL_KEY=$/m);
    // It must land in the optional section, after the required keys.
    assert.ok(
      block.indexOf('EPSILON_OPTIONAL_KEY=') > block.indexOf('Optional source keys'),
      'optional key listed outside the optional section',
    );
  });

  await t.test('a required env also read optionally names both sets of sources', () => {
    const withBoth = [
      source({ name: 'zeta', auth: { type: 'bearer', env: 'SHARED_TOKEN' } }),
      source({ name: 'eta', optionalEnv: ['SHARED_TOKEN'] }),
    ];
    const block = buildEnvBlock(withBoth);
    assert.match(block, /# Also read, but not required, by: eta\./);
    // Listed once, under the required keys, not twice.
    assert.equal(block.split('\nSHARED_TOKEN=').length - 1, 1);
  });

  await t.test('is wrapped in the env markers', () => {
    const block = buildEnvBlock(FIXTURES);
    assert.ok(block.startsWith('# env:start'));
    assert.ok(block.endsWith('# env:end'));
  });
});

test('spliceMarked', async (t) => {
  await t.test('replaces content between two markers', () => {
    const out = spliceMarked('a\nSTART\nold\nEND\nb', 'START', 'END', 'START\nnew\nEND');
    assert.equal(out, 'a\nSTART\nnew\nEND\nb');
  });

  await t.test('throws when a marker is missing', () => {
    assert.throws(() => spliceMarked('a\nSTART\nold\nb', 'START', 'END', 'x'), /markers/);
  });
});
