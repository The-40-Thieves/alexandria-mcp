// Task 5 (review 3.6): structured logs. stdout is the stdio MCP transport
// (the JSON-RPC wire), so every log line goes to stderr - pino's default
// destination is stdout, which this file overrides everywhere.
//
// Level comes from config (LOG_LEVEL, or "debug" when DEBUG is set,
// otherwise "info"). Redaction recurses the whole log object and masks any
// field whose NAME looks like a credential (apiKey, token, Authorization,
// ...), at any nesting depth - pino's own `redact` option only matches a
// fixed list of paths, which can't express "any field shaped like this,
// wherever it appears" the way this server's own config (per-role API
// keys, KNOWLEDGE_MCP_TOKEN, bearer headers passed to mcpClientPool) needs.
//
// A pino instance is constructed fresh on every log call rather than once
// at module load, deliberately mirroring config.ts's own "always re-read,
// never cache" choice: cheap (microseconds, and these call sites are not a
// hot loop), and it means both the level (from config) and the destination
// (see destinationOverride below) are always current, with the exact same
// per-test-file setup/teardown cost as every other env-driven module here
// (zero - existing tests need no changes to keep working).
import pino from 'pino';
import { config } from './config.ts';
import { requestContext } from './utils/http.ts';

const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|authoriz(?:ation|ed)|bearer|credential)/i;
const REDACTED = '[Redacted]';
const MAX_DEPTH = 6;

function redactDeep(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactDeep(v, depth + 1, seen);
  }
  return out;
}

/** Exported for direct unit testing without spinning up a full logger. */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactDeep(object, 0, new WeakSet()) as Record<string, unknown>;
}

function level(): pino.LevelWithSilent {
  if (config.LOG_LEVEL) return config.LOG_LEVEL;
  return config.DEBUG ? 'debug' : 'info';
}

const noopDestination: pino.DestinationStream = { write() {} };

// Test-only indirection, the same mutable-ref pattern providers.ts's
// openaiBaseUrlOverride and fetchTier.ts's dnsResolver already use to make
// a real dependency swappable per test: a test points this at its own
// capturing stream, asserts on what was written, then resets it to
// undefined. Left unset, the default is a no-op sink under
// NODE_ENV=test (see config.ts - npm test sets it) so the suite's own
// terminal stays clean, or real stderr otherwise.
export const destinationOverride: { value: pino.DestinationStream | undefined } = {
  value: undefined,
};

function destination(): pino.DestinationStream {
  if (destinationOverride.value) return destinationOverride.value;
  if (config.NODE_ENV === 'test') return noopDestination;
  return pino.destination({ fd: 2, sync: false });
}

function buildLogger(): pino.Logger {
  return pino(
    {
      level: level(),
      formatters: { log: redactLogObject },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination(),
  );
}

type LogArgs = [obj: object, msg?: string, ...args: unknown[]] | [msg: string, ...args: unknown[]];

function call(method: 'info' | 'warn' | 'error' | 'debug', args: LogArgs): void {
  const logger = buildLogger();
  (logger[method] as (...a: LogArgs) => void)(...args);
}

// The base logger. stdout is never touched; every call here goes to
// stderr (or a test's capturing stream - see destinationOverride).
export const log = {
  info: (...args: LogArgs): void => call('info', args),
  warn: (...args: LogArgs): void => call('warn', args),
  error: (...args: LogArgs): void => call('error', args),
  debug: (...args: LogArgs): void => call('debug', args),
};

// A child logger carrying the current MCP request's id and tool name, read
// off the requestContext AsyncLocalStorage index.ts's withRequestContext()
// populates (src/utils/http.ts). Falls back to the base logger outside a
// request (a script, a direct unit test, module-load-time code).
export function requestLogger(): pino.Logger {
  const store = requestContext.getStore();
  const base = buildLogger();
  if (!store?.reqId) return base;
  return base.child({ reqId: store.reqId, tool: store.tool });
}
