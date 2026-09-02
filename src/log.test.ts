import assert from 'node:assert/strict';
import test from 'node:test';
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
