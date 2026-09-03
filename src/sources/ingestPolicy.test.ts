import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIngestAllowed, ingestMetadata } from './ingestPolicy.ts';

test('assertIngestAllowed', async (t) => {
  await t.test('allowed: never throws', () => {
    assert.doesNotThrow(() => assertIngestAllowed({ name: 'gutenberg', ingestPolicy: 'allowed' }));
  });

  await t.test('undefined policy defaults to allowed: never throws', () => {
    assert.doesNotThrow(() => assertIngestAllowed({ name: 'gutenberg' }));
  });

  await t.test('attribution: never throws', () => {
    assert.doesNotThrow(() =>
      assertIngestAllowed({ name: 'semanticscholar', ingestPolicy: 'attribution' }),
    );
  });

  await t.test('forbidden: always throws, naming the source', () => {
    assert.throws(
      () => assertIngestAllowed({ name: 'trove', ingestPolicy: 'forbidden' }),
      /"trove" cannot be ingested/,
    );
  });

  await t.test('timeboxed: throws without ALEXANDRIA_INGEST_TIMEBOXED=1', (t) => {
    const original = process.env.ALEXANDRIA_INGEST_TIMEBOXED;
    delete process.env.ALEXANDRIA_INGEST_TIMEBOXED;
    t.after(() => {
      if (original === undefined) delete process.env.ALEXANDRIA_INGEST_TIMEBOXED;
      else process.env.ALEXANDRIA_INGEST_TIMEBOXED = original;
    });
    assert.throws(
      () => assertIngestAllowed({ name: 'guardian', ingestPolicy: 'timeboxed' }),
      /"guardian" ingest is timeboxed/,
    );
  });

  await t.test('timeboxed: allowed once ALEXANDRIA_INGEST_TIMEBOXED=1 is set', (t) => {
    const original = process.env.ALEXANDRIA_INGEST_TIMEBOXED;
    process.env.ALEXANDRIA_INGEST_TIMEBOXED = '1';
    t.after(() => {
      if (original === undefined) delete process.env.ALEXANDRIA_INGEST_TIMEBOXED;
      else process.env.ALEXANDRIA_INGEST_TIMEBOXED = original;
    });
    assert.doesNotThrow(() => assertIngestAllowed({ name: 'guardian', ingestPolicy: 'timeboxed' }));
  });
});

test('ingestMetadata', async (t) => {
  await t.test('allowed: stamps nothing', () => {
    assert.deepEqual(ingestMetadata({ name: 'gutenberg', ingestPolicy: 'allowed' }), {});
  });

  await t.test('undefined policy defaults to allowed: stamps nothing', () => {
    assert.deepEqual(ingestMetadata({ name: 'gutenberg' }), {});
  });

  await t.test('attribution: stamps name and homepage', () => {
    assert.deepEqual(
      ingestMetadata({
        name: 'semanticscholar',
        ingestPolicy: 'attribution',
        homepage: 'https://www.semanticscholar.org',
      }),
      { attribution: 'semanticscholar (https://www.semanticscholar.org)' },
    );
  });

  await t.test('attribution: falls back to the name alone without a homepage', () => {
    assert.deepEqual(ingestMetadata({ name: 'stackexchange', ingestPolicy: 'attribution' }), {
      attribution: 'stackexchange',
    });
  });

  await t.test('timeboxed: stamps an expiresAt roughly 24h out', () => {
    const before = Date.now();
    const stamp = ingestMetadata({ name: 'guardian', ingestPolicy: 'timeboxed' });
    assert.ok(stamp.expiresAt, 'expiresAt is set');
    const expiresMs = new Date(stamp.expiresAt as string).getTime();
    const deltaMs = expiresMs - before;
    assert.ok(
      deltaMs > 23 * 60 * 60 * 1000 && deltaMs < 25 * 60 * 60 * 1000,
      `expected ~24h out, got ${deltaMs}ms`,
    );
  });

  await t.test(
    'forbidden: stamps nothing (assertIngestAllowed throws before this is reached)',
    () => {
      assert.deepEqual(ingestMetadata({ name: 'trove', ingestPolicy: 'forbidden' }), {});
    },
  );
});
