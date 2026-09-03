import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { mcpProbeEntries } from '../src/sources/kinds/mcp.ts';
import { startTestMcpServer, type TestMcpServerHandle } from '../src/utils/mcpTestServer.ts';
import {
  classify,
  EXPECTED_EMPTY,
  MCP_SNAPSHOT_DIR,
  mcpToolsSnapshotOrDrift,
  regressions,
  withEmptyRegressionLabels,
} from './probe.ts';

test('probe classification', async (t) => {
  await t.test('OK when results present', () => {
    assert.equal(classify({ results: [{ id: '1' }] as any, error: null }), 'OK');
  });
  await t.test('EMPTY when zero results', () => {
    assert.equal(classify({ results: [], error: null }), 'EMPTY');
  });
  await t.test('TIMEOUT when aborted', () => {
    assert.equal(
      classify({ results: null, error: new Error('This operation was aborted') }),
      'TIMEOUT',
    );
  });
  await t.test('ERROR otherwise', () => {
    assert.equal(classify({ results: null, error: new Error('HTTP 500') }), 'ERROR');
  });
  await t.test('KEY_MISSING when the error names a missing key/token/env', () => {
    assert.equal(
      classify({ results: null, error: new Error('CORE_API_KEY is not set') }),
      'ERROR', // "is not set" doesn't match "requires .* (key|token|env)", see next cases
    );
    assert.equal(
      classify({
        results: null,
        error: new Error('Trove requires a free API key. Register at: ...'),
      }),
      'KEY_MISSING',
    );
    assert.equal(
      classify({
        results: null,
        error: new Error('YOUTUBE_API_KEY is required for the youtube source'),
      }),
      'ERROR', // "is required" doesn't match "requires" either, see openiti-style wording below
    );
    assert.equal(
      classify({
        results: null,
        error: new Error('openiti requires a GITHUB_TOKEN environment variable'),
      }),
      'KEY_MISSING',
    );
    // Stage-4B keyed sources whose env var names don't contain "key",
    // "token", or "env" (e.g. reliefweb's RELIEFWEB_APPNAME, hapi's
    // HDX_APP_IDENTIFIER): the regex also matches "email", "identifier",
    // and "appname".
    assert.equal(
      classify({
        results: null,
        error: new Error('x requires CONTACT_EMAIL'),
      }),
      'KEY_MISSING',
    );
    assert.equal(
      classify({
        results: null,
        error: new Error('x requires HDX_APP_IDENTIFIER'),
      }),
      'KEY_MISSING',
    );
  });

  await t.test('regressions lists sources that were OK and are not', () => {
    const base = { a: { status: 'OK' }, b: { status: 'ERROR' } } as any;
    const now = { a: { status: 'ERROR' }, b: { status: 'OK' } } as any;
    assert.deepEqual(regressions(base, now), ['a']);
  });
  await t.test('regressions does not flag a source absent from the current run', () => {
    // A source dropped from the registry (e.g. deleted) disappears from
    // `now` entirely; that is a deliberate removal, not a regression.
    const base = { a: { status: 'OK' }, dropped: { status: 'OK' } } as any;
    const now = { a: { status: 'OK' } } as any;
    assert.deepEqual(regressions(base, now), []);
  });
  await t.test(
    'regressions does not flag OK -> KEY_MISSING for a source that declares auth',
    () => {
      const base = { keyed: { status: 'OK' } } as any;
      const now = { keyed: { status: 'KEY_MISSING' } } as any;
      assert.deepEqual(
        regressions(base, now, (s) => s === 'keyed'),
        [],
      );
    },
  );
  await t.test('regressions DOES flag OK -> KEY_MISSING for a source with no auth declared', () => {
    const base = { keyless: { status: 'OK' } } as any;
    const now = { keyless: { status: 'KEY_MISSING' } } as any;
    assert.deepEqual(
      regressions(base, now, () => false),
      ['keyless'],
    );
  });
  await t.test('regressions does not flag OK -> EMPTY for an EXPECTED_EMPTY source', () => {
    assert.ok(EXPECTED_EMPTY.has('webfetch'));
    const base = { webfetch: { status: 'OK' } } as any;
    const now = { webfetch: { status: 'EMPTY' } } as any;
    assert.deepEqual(regressions(base, now), []);
  });
  await t.test('regressions DOES flag OK -> EMPTY for a source not in EXPECTED_EMPTY', () => {
    const base = { other: { status: 'OK' } } as any;
    const now = { other: { status: 'EMPTY' } } as any;
    assert.deepEqual(regressions(base, now), ['other']);
  });
});

// Final wave, A14: this is the only gate that could have caught A4 -
// legislation.gov.uk's HTML-not-Atom response classified as plain EMPTY,
// indistinguishable from an EXPECTED_EMPTY source or one merely quiet
// today, in the per-source status written to probe-latest.json.
test('withEmptyRegressionLabels', async (t) => {
  await t.test('relabels EMPTY to EMPTY_REGRESSION when the baseline was OK', () => {
    const base = { legislation: { status: 'OK' } };
    const now = { legislation: { status: 'EMPTY', ms: 10, count: 0 } } as any;
    const labeled = withEmptyRegressionLabels(base, now);
    assert.equal(labeled.legislation.status, 'EMPTY_REGRESSION');
    // Every other field is carried through unchanged.
    assert.equal(labeled.legislation.ms, 10);
    assert.equal(labeled.legislation.count, 0);
  });

  await t.test('leaves EMPTY alone when the baseline was already EMPTY (a stale baseline)', () => {
    const base = { legislation: { status: 'EMPTY' } };
    const now = { legislation: { status: 'EMPTY', ms: 10, count: 0 } } as any;
    assert.equal(withEmptyRegressionLabels(base, now).legislation.status, 'EMPTY');
  });

  await t.test(
    'leaves EMPTY alone for an EXPECTED_EMPTY source even when the baseline was OK',
    () => {
      assert.ok(EXPECTED_EMPTY.has('webfetch'));
      const base = { webfetch: { status: 'OK' } };
      const now = { webfetch: { status: 'EMPTY', ms: 10, count: 0 } } as any;
      assert.equal(withEmptyRegressionLabels(base, now).webfetch.status, 'EMPTY');
    },
  );

  await t.test(
    'leaves a non-EMPTY status (OK, ERROR, ...) alone regardless of the baseline',
    () => {
      const base = { arxiv: { status: 'OK' } };
      const now = { arxiv: { status: 'OK', ms: 10, count: 3 } } as any;
      assert.equal(withEmptyRegressionLabels(base, now).arxiv.status, 'OK');
    },
  );

  await t.test('leaves EMPTY alone for a source absent from the baseline', () => {
    const base = {};
    const now = { newsource: { status: 'EMPTY', ms: 10, count: 0 } } as any;
    assert.equal(withEmptyRegressionLabels(base, now).newsource.status, 'EMPTY');
  });
});

test('mcpToolsSnapshotOrDrift', async (t) => {
  const NAME = 'mcp_test_probe_snapshot_tools';
  const file = path.join(MCP_SNAPSHOT_DIR, `${NAME}.json`);
  let handle: TestMcpServerHandle | undefined;

  function removeEntry(name: string) {
    const idx = mcpProbeEntries.findIndex((e) => e.name === name);
    if (idx !== -1) mcpProbeEntries.splice(idx, 1);
  }

  t.after(async () => {
    if (handle) await handle.close();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    removeEntry(NAME);
  });

  await t.test('writes a sorted snapshot file for a configured server', async () => {
    handle = await startTestMcpServer({});
    const serverHandle = handle;
    mcpProbeEntries.push({
      name: NAME,
      resolveServer: () => ({ name: NAME, url: serverHandle.url, timeoutMs: 5000 }),
    });

    await mcpToolsSnapshotOrDrift(true, NAME);

    assert.ok(fs.existsSync(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['read', 'search']);
  });

  await t.test(
    'warns on stderr (no throw) when the live list differs from the recorded snapshot',
    async () => {
      // The previous test recorded ['read', 'search']; overwrite the
      // snapshot on disk to simulate a server that has since dropped a
      // tool, without needing a second live server exposing a different
      // tool set.
      fs.writeFileSync(file, `${JSON.stringify(['search'], null, 2)}\n`);

      const originalError = console.error;
      const lines: string[] = [];
      console.error = ((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }) as typeof console.error;
      try {
        await assert.doesNotReject(mcpToolsSnapshotOrDrift(false, NAME));
      } finally {
        console.error = originalError;
      }

      assert.ok(
        lines.some((l) => l.includes('DRIFT') && l.includes(NAME) && l.includes('read')),
        `expected a DRIFT warning naming ${NAME} and the added "read" tool, got: ${lines.join(' | ')}`,
      );
    },
  );

  await t.test('skips a source with no resolved server (hidden)', async () => {
    const HIDDEN = 'mcp_test_probe_snapshot_hidden';
    mcpProbeEntries.push({ name: HIDDEN, resolveServer: () => null });
    t.after(() => removeEntry(HIDDEN));

    await assert.doesNotReject(mcpToolsSnapshotOrDrift(false, HIDDEN));
    assert.ok(!fs.existsSync(path.join(MCP_SNAPSHOT_DIR, `${HIDDEN}.json`)));
  });
});
