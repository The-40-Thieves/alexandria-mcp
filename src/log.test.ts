import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_FIELDS } from './config.ts';
import { destinationOverride, log, redactLogObject, requestLogger } from './log.ts';
import { requestContext } from './utils/http.ts';

function capture(): { lines: string[]; stream: { write(msg: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (msg: string) => void lines.push(msg) } };
}

test('redactLogObject', async (t) => {
  await t.test('masks a top-level field named like a key or token', () => {
    const out = redactLogObject({ apiKey: 'sk-secret', message: 'hello' });
    assert.equal(out.apiKey, '[Redacted]');
    assert.equal(out.message, 'hello');
  });

  await t.test('masks nested fields at any depth, case-insensitively', () => {
    const out = redactLogObject({
      config: { ALEXANDRIA_API_KEY: 'sk-1', nested: { Authorization: 'Bearer xyz' } },
      ok: 'kept',
    });
    const config = out.config as Record<string, unknown>;
    assert.equal(config.ALEXANDRIA_API_KEY, '[Redacted]');
    const nested = config.nested as Record<string, unknown>;
    assert.equal(nested.Authorization, '[Redacted]');
    assert.equal(out.ok, 'kept');
  });

  await t.test('masks token/secret/password fields inside an array', () => {
    const out = redactLogObject({ list: [{ token: 'tok-1' }, { logme: 'kept' }] });
    const list = out.list as Array<Record<string, unknown>>;
    assert.equal(list[0].token, '[Redacted]');
    assert.equal(list[1].logme, 'kept');
  });

  await t.test('does not mutate the input object', () => {
    const input = { apiKey: 'sk-secret' };
    redactLogObject(input);
    assert.equal(input.apiKey, 'sk-secret');
  });

  await t.test('a circular reference does not throw or hang', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj.self = obj;
    assert.doesNotThrow(() => redactLogObject(obj));
  });

  // Regression: SUPABASE_SERVICE_ROLE_KEY (full table write access) went
  // unredacted under the old regex, which only matched "key" when
  // immediately preceded by "api" - this name has no "api" in it at all.
  await t.test('masks a "...ROLE_KEY"-shaped field, not just "...API_KEY"', () => {
    const out = redactLogObject({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret' });
    assert.equal(out.SUPABASE_SERVICE_ROLE_KEY, '[Redacted]');
  });

  await t.test('does not over-match a field that merely contains "key" as a substring', () => {
    const out = redactLogObject({ monkeyPatchCount: 3, keyboardLayout: 'us' });
    assert.equal(out.monkeyPatchCount, 3);
    assert.equal(out.keyboardLayout, 'us');
  });

  await t.test(
    'replaces a container past the depth cap instead of passing it through unredacted',
    () => {
      // 8 levels of nesting, deeper than MAX_DEPTH (6), with a sensitive key
      // at the very bottom - the old behavior returned the whole subtree
      // verbatim once the cap was hit, leaking it in full.
      let deep: Record<string, unknown> = { apiKey: 'buried-secret' };
      for (let i = 0; i < 8; i++) deep = { child: deep };
      const out = redactLogObject({ deep });
      assert.ok(JSON.stringify(out).includes('[Truncated]'));
      assert.ok(!JSON.stringify(out).includes('buried-secret'));
    },
  );

  // The requirement this guards: the redaction list must not silently
  // drift from config.ts's own schema. Every CONFIG_FIELDS name that looks
  // like a credential by a SEPARATE, deliberately naive notion (a bare
  // substring test, not log.ts's own tokenizer) must actually come back
  // redacted - if a future config field is added whose name contains
  // "key"/"token"/"secret"/"password"/"credential" and log.ts's real
  // implementation somehow misses it, this fails without anyone having to
  // remember to hand-add it to a list.
  await t.test('every key/token/secret/password/credential-shaped config field is redacted', () => {
    const looksSecret = /key|token|secret|password|credential/i;
    const secretFieldNames = CONFIG_FIELDS.map((f) => f.name).filter((name) =>
      looksSecret.test(name),
    );

    // Sanity floor: this must find a non-trivial set (including the
    // per-role API keys and SUPABASE_SERVICE_ROLE_KEY), or the filter
    // itself is broken and the test would vacuously pass on zero fields.
    assert.ok(
      secretFieldNames.length >= 10,
      `expected several secret-shaped fields, got ${secretFieldNames.length}`,
    );
    assert.ok(secretFieldNames.includes('SUPABASE_SERVICE_ROLE_KEY'));

    for (const name of secretFieldNames) {
      const out = redactLogObject({ [name]: 'the-actual-secret-value' });
      assert.equal(out[name], '[Redacted]', `${name} was not redacted`);
    }
  });
});

test('log writes redacted JSON to the configured destination, not stdout', async (t) => {
  const { lines, stream } = capture();
  destinationOverride.value = stream;
  t.after(() => {
    destinationOverride.value = undefined;
  });

  log.warn({ apiKey: 'sk-secret', reason: 'test' }, 'a warning happened');

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.msg, 'a warning happened');
  assert.equal(parsed.apiKey, '[Redacted]');
  assert.equal(parsed.reason, 'test');
});

test('requestLogger', async (t) => {
  const { lines, stream } = capture();
  destinationOverride.value = stream;
  t.after(() => {
    destinationOverride.value = undefined;
  });

  await t.test('outside a request context, behaves like the base logger (no reqId/tool)', () => {
    lines.length = 0;
    requestLogger().info('no context');
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.reqId, undefined);
    assert.equal(parsed.tool, undefined);
  });

  await t.test('inside a request context, carries reqId and tool as bindings', () => {
    lines.length = 0;
    requestContext.run({ reqId: 'req-123', tool: 'library_ask' }, () => {
      requestLogger().info('inside a tool call');
    });
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.reqId, 'req-123');
    assert.equal(parsed.tool, 'library_ask');
  });
});
