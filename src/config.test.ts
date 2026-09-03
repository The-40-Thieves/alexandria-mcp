import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_FIELDS, config, loadConfig } from './config.ts';

test('loadConfig', async (t) => {
  await t.test('parses a good env and applies defaults', () => {
    const result = loadConfig({
      OPENAI_API_KEY: 'sk-test',
      ALEXANDRIA_ROUTER_MODEL: 'gpt-4o-mini',
      PORT: '4001',
      TRANSPORT: 'http',
    } as NodeJS.ProcessEnv);

    assert.equal(result.OPENAI_API_KEY, 'sk-test');
    assert.equal(result.ALEXANDRIA_ROUTER_MODEL, 'gpt-4o-mini');
    assert.equal(result.PORT, 4001);
    assert.equal(result.TRANSPORT, 'http');
  });

  await t.test('applies defaults for TRANSPORT and PORT when unset', () => {
    const result = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(result.TRANSPORT, 'stdio');
    assert.equal(result.PORT, 3000);
  });

  await t.test('returns a frozen object', () => {
    const result = loadConfig({} as NodeJS.ProcessEnv);
    assert.ok(Object.isFrozen(result));
  });

  await t.test('rejects a bad TRANSPORT, naming the variable and not its value', () => {
    let threw: unknown;
    try {
      loadConfig({ TRANSPORT: 'carrier-pigeon' } as NodeJS.ProcessEnv);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof Error);
    assert.match(threw.message, /TRANSPORT/);
    assert.doesNotMatch(threw.message, /carrier-pigeon/);
  });

  await t.test('rejects a non-numeric PORT, naming the variable', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-number' } as NodeJS.ProcessEnv), /PORT/);
  });

  await t.test('lists every bad variable by name in one error, not the value', () => {
    let threw: unknown;
    try {
      loadConfig({
        PORT: 'not-a-number',
        TRANSPORT: 'carrier-pigeon',
        ALEXANDRIA_LEDGER: 'dynamodb',
      } as NodeJS.ProcessEnv);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof Error);
    assert.match(threw.message, /PORT/);
    assert.match(threw.message, /TRANSPORT/);
    assert.match(threw.message, /ALEXANDRIA_LEDGER/);
    assert.doesNotMatch(threw.message, /dynamodb/);
  });

  await t.test('strips unrelated env vars (adapter keys, PATH, etc.)', () => {
    const result = loadConfig({
      OPENAI_API_KEY: 'sk-test',
      CORE_API_KEY: 'unrelated-adapter-key',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);
    assert.ok(!('CORE_API_KEY' in result));
    assert.ok(!('PATH' in result));
  });

  // Task 6 fix round 1: an env-file loader commonly emits a declared but
  // unset var as "" (KEY=), which downstream Number('') parsers
  // (resultCache.ts's parseTtlMs, libraryAsk.ts's parseSkipMargin) would
  // otherwise read as a valid, finite 0 instead of "not configured".
  // These two fields normalize that shape to undefined at the schema
  // boundary so neither parser has to special-case it itself.
  await t.test('an empty ALEXANDRIA_ROUTER_SKIP_MARGIN normalizes to undefined, not ""', () => {
    const result = loadConfig({ ALEXANDRIA_ROUTER_SKIP_MARGIN: '' } as NodeJS.ProcessEnv);
    assert.equal(result.ALEXANDRIA_ROUTER_SKIP_MARGIN, undefined);
  });

  await t.test(
    'a whitespace-only ALEXANDRIA_ROUTER_SKIP_MARGIN also normalizes to undefined',
    () => {
      const result = loadConfig({ ALEXANDRIA_ROUTER_SKIP_MARGIN: '   ' } as NodeJS.ProcessEnv);
      assert.equal(result.ALEXANDRIA_ROUTER_SKIP_MARGIN, undefined);
    },
  );

  await t.test('a real ALEXANDRIA_ROUTER_SKIP_MARGIN value passes through unchanged', () => {
    const result = loadConfig({ ALEXANDRIA_ROUTER_SKIP_MARGIN: '0.4' } as NodeJS.ProcessEnv);
    assert.equal(result.ALEXANDRIA_ROUTER_SKIP_MARGIN, '0.4');
  });

  await t.test('an empty ALEXANDRIA_CACHE_TTL_MS normalizes to undefined too (same shape)', () => {
    const result = loadConfig({ ALEXANDRIA_CACHE_TTL_MS: '' } as NodeJS.ProcessEnv);
    assert.equal(result.ALEXANDRIA_CACHE_TTL_MS, undefined);
  });

  // Final wave, A6: an env-file loader emits every declared-but-unset key
  // as KEY= (empty string), not merely the two numeric fields the previous
  // preprocess covered. Before this fix, TRANSPORT=, LOG_LEVEL=,
  // ALEXANDRIA_LEDGER=, ALEXANDRIA_RERANK= (any optional enum) failed the
  // WHOLE parse (an invalid enum value), not just that one field - this
  // builds exactly that shape (every CONFIG_FIELDS name set to '') and
  // asserts it loads cleanly with every field's default/undefined.
  await t.test('an env with every optional key set to the empty string loads with defaults', () => {
    const allEmpty = Object.fromEntries(
      CONFIG_FIELDS.map((f) => [f.name, '']),
    ) as NodeJS.ProcessEnv;

    const result = loadConfig(allEmpty);

    assert.equal(result.TRANSPORT, 'stdio');
    assert.equal(result.PORT, 3000);
    assert.equal(result.LOG_LEVEL, undefined);
    assert.equal(result.ALEXANDRIA_LEDGER, undefined);
    assert.equal(result.ALEXANDRIA_RERANK, undefined);
    assert.equal(
      result.ALEXANDRIA_RERANK_POOL,
      60,
      'a coerced-number field still gets its default',
    );
    assert.equal(result.ALEXANDRIA_MULTI_QUERY, undefined);
    assert.equal(result.ALEXANDRIA_ROUTER_SKIP_MARGIN, undefined);
    assert.equal(result.OPENAI_API_KEY, undefined);
  });

  await t.test('Task 10: ALEXANDRIA_RERANK accepts every backend name', () => {
    for (const backend of ['off', 'llm', 'cohere', 'workers-ai']) {
      const result = loadConfig({ ALEXANDRIA_RERANK: backend } as NodeJS.ProcessEnv);
      assert.equal(result.ALEXANDRIA_RERANK, backend);
    }
  });

  await t.test('Task 10: an explicit ALEXANDRIA_RERANK_POOL passes through unchanged', () => {
    const result = loadConfig({ ALEXANDRIA_RERANK_POOL: '100' } as NodeJS.ProcessEnv);
    assert.equal(result.ALEXANDRIA_RERANK_POOL, 100);
  });

  await t.test('Task 10: ALEXANDRIA_MULTI_QUERY only accepts "1"', () => {
    assert.equal(
      loadConfig({ ALEXANDRIA_MULTI_QUERY: '1' } as NodeJS.ProcessEnv).ALEXANDRIA_MULTI_QUERY,
      '1',
    );
    assert.throws(() => loadConfig({ ALEXANDRIA_MULTI_QUERY: 'true' } as NodeJS.ProcessEnv));
  });
});

test('config singleton', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('is lazy: nothing throws at import, only at first property access', () => {
    process.env.PORT = 'not-a-number';
    // Importing config.ts already happened at module load, before this test
    // mutated process.env - if that import had eagerly parsed, this
    // mutation would be irrelevant. Accessing a property now must be the
    // thing that throws.
    assert.throws(() => config.PORT, /PORT/);
    delete process.env.PORT;
  });

  await t.test(
    're-reads process.env on every access, so a test can set env and see it immediately',
    () => {
      process.env.OPENAI_API_KEY = 'sk-first';
      assert.equal(config.OPENAI_API_KEY, 'sk-first');
      process.env.OPENAI_API_KEY = 'sk-second';
      assert.equal(config.OPENAI_API_KEY, 'sk-second');
      delete process.env.OPENAI_API_KEY;
      assert.equal(config.OPENAI_API_KEY, undefined);
    },
  );
});

test('CONFIG_FIELDS carries a name and non-empty description for every schema field', () => {
  assert.ok(CONFIG_FIELDS.length > 20);
  for (const field of CONFIG_FIELDS) {
    assert.ok(field.name.length > 0);
    assert.ok(field.description.length > 0, `${field.name} has no .describe() text`);
  }
  const names = CONFIG_FIELDS.map((f) => f.name);
  assert.ok(names.includes('ALEXANDRIA_ROUTER_MODEL'));
  assert.ok(names.includes('KNOWLEDGE_MCP_URL'));
});
