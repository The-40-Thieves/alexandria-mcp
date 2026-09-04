import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { z } from 'zod';
import {
  chatJSON,
  chatText,
  embed,
  embeddingDimensions,
  getClient,
  openaiBaseUrlOverride,
  roleConfig,
} from './providers.ts';

interface FakeServer {
  url: string;
  chatRequests: Array<{ body: unknown; headers: IncomingMessage['headers'] }>;
  close(): Promise<void>;
}

type ChatHandler = (
  requestNumber: number,
  body: { messages: Array<{ role: string; content: string }> },
) => { status: number; body: unknown };

// A local node:http fixture standing in for an OpenAI-compatible
// /v1/chat/completions and /v1/embeddings endpoint. `onChat` decides the
// response per call (1-indexed), so a test can script "invalid JSON first,
// valid second" or "always 500".
function startFakeServer(onChat: ChatHandler): Promise<FakeServer> {
  const chatRequests: FakeServer['chatRequests'] = [];
  let chatCalls = 0;
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/v1/chat/completions') {
          chatCalls += 1;
          chatRequests.push({ body, headers: req.headers });
          const { status, body: respBody } = onChat(chatCalls, body);
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(respBody));
          return;
        }
        if (req.url === '/v1/embeddings') {
          // The SDK defaults to requesting base64-encoded embeddings on the
          // wire (and decodes them client-side), matching real OpenAI's
          // behavior, so the fixture has to speak that format too.
          const input = (body.input as string[]) ?? [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: input.map((_, i) => ({
                embedding: toBase64Float32([i + 1, i + 2, i + 3]),
                index: i,
              })),
            }),
          );
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        chatRequests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function toBase64Float32(nums: number[]): string {
  const buf = Buffer.alloc(nums.length * 4);
  nums.forEach((n, i) => {
    buf.writeFloatLE(n, i * 4);
  });
  return buf.toString('base64');
}

function chatCompletion(content: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

const ROLE_ENV_SUFFIXES = ['BASE_URL', 'API_KEY', 'MODEL', 'JSON_MODE', 'GATEWAY_ID'] as const;
const ROLES = ['ROUTER', 'SYNTH', 'RESEARCH', 'EMBEDDINGS', 'RERANK', 'VERIFY'] as const;

function clearAlexandriaEnv() {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ALEXANDRIA_BASE_URL;
  delete process.env.ALEXANDRIA_API_KEY;
  delete process.env.ALEXANDRIA_GATEWAY_ID;
  for (const role of ROLES) {
    for (const suffix of ROLE_ENV_SUFFIXES) {
      delete process.env[`ALEXANDRIA_${role}_${suffix}`];
    }
  }
}

test('roleConfig', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('with only OPENAI_API_KEY set, resolves to the pre-v2 defaults', () => {
    clearAlexandriaEnv();
    process.env.OPENAI_API_KEY = 'sk-test';

    const router = roleConfig('router');
    assert.equal(router.baseURL, 'https://api.openai.com/v1');
    assert.equal(router.apiKey, 'sk-test');
    assert.equal(router.model, 'gpt-4o-mini');
    assert.equal(router.fallback, undefined, 'no gateway configured, so no fallback needed');

    assert.equal(roleConfig('synth').model, 'gpt-4o-mini');
    assert.equal(roleConfig('research').model, 'gpt-4o');
    assert.equal(roleConfig('embeddings').model, 'text-embedding-3-small');
    assert.equal(roleConfig('rerank').model, 'gpt-4o-mini', 'rerank defaults to the same as synth');
  });

  await t.test('with no key anywhere, apiKey is empty and baseURL still defaults', () => {
    clearAlexandriaEnv();
    const router = roleConfig('router');
    assert.equal(router.apiKey, '');
    assert.equal(router.baseURL, 'https://api.openai.com/v1');
  });

  await t.test('ALEXANDRIA_BASE_URL/_API_KEY apply as shared defaults for every role', () => {
    clearAlexandriaEnv();
    process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
    process.env.ALEXANDRIA_API_KEY = 'shared-key';

    const router = roleConfig('router');
    assert.equal(router.baseURL, 'http://gateway.example/v1');
    assert.equal(router.apiKey, 'shared-key');
    assert.equal(roleConfig('embeddings').baseURL, 'http://gateway.example/v1');
  });

  await t.test('ALEXANDRIA_<ROLE>_* takes precedence over the shared ALEXANDRIA_* vars', () => {
    clearAlexandriaEnv();
    process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
    process.env.ALEXANDRIA_API_KEY = 'shared-key';
    process.env.ALEXANDRIA_ROUTER_BASE_URL = 'http://router-only.example/v1';
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'router-key';
    process.env.ALEXANDRIA_ROUTER_MODEL = 'custom-router-model';

    const router = roleConfig('router');
    assert.equal(router.baseURL, 'http://router-only.example/v1');
    assert.equal(router.apiKey, 'router-key');
    assert.equal(router.model, 'custom-router-model');
    // A sibling role only sees the shared vars, not router's overrides.
    assert.equal(roleConfig('synth').baseURL, 'http://gateway.example/v1');
    assert.equal(roleConfig('synth').apiKey, 'shared-key');
  });

  await t.test('gatewayId is unset by default, even with a gateway configured', () => {
    clearAlexandriaEnv();
    process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
    process.env.ALEXANDRIA_API_KEY = 'shared-key';
    assert.equal(roleConfig('router').gatewayId, undefined);
  });

  await t.test('ALEXANDRIA_GATEWAY_ID applies as a shared default for every role', () => {
    clearAlexandriaEnv();
    process.env.ALEXANDRIA_GATEWAY_ID = 'shared-gateway';
    assert.equal(roleConfig('router').gatewayId, 'shared-gateway');
    assert.equal(roleConfig('embeddings').gatewayId, 'shared-gateway');
  });

  await t.test(
    'ALEXANDRIA_<ROLE>_GATEWAY_ID takes precedence over the shared ALEXANDRIA_GATEWAY_ID',
    () => {
      clearAlexandriaEnv();
      process.env.ALEXANDRIA_GATEWAY_ID = 'shared-gateway';
      process.env.ALEXANDRIA_ROUTER_GATEWAY_ID = 'router-only-gateway';

      assert.equal(roleConfig('router').gatewayId, 'router-only-gateway');
      // A sibling role only sees the shared gateway id.
      assert.equal(roleConfig('synth').gatewayId, 'shared-gateway');
    },
  );

  await t.test(
    'a gateway base URL plus a real OPENAI_API_KEY attaches a direct-OpenAI fallback',
    () => {
      clearAlexandriaEnv();
      process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
      process.env.ALEXANDRIA_API_KEY = 'gateway-key';
      process.env.OPENAI_API_KEY = 'sk-direct';

      const router = roleConfig('router');
      assert.ok(router.fallback);
      assert.equal(router.fallback?.baseURL, 'https://api.openai.com/v1');
      assert.equal(router.fallback?.apiKey, 'sk-direct');
      // Same default model on both sides here: nothing overrode it.
      assert.equal(router.fallback?.model, 'gpt-4o-mini');
    },
  );

  await t.test('gatewayId never carries over onto the direct-OpenAI fallback', () => {
    // api.openai.com is never behind an AI Gateway - sending
    // cf-aig-gateway-id there would be inert at best.
    clearAlexandriaEnv();
    process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
    process.env.ALEXANDRIA_API_KEY = 'gateway-key';
    process.env.ALEXANDRIA_GATEWAY_ID = 'shared-gateway';
    process.env.OPENAI_API_KEY = 'sk-direct';

    const router = roleConfig('router');
    assert.equal(router.gatewayId, 'shared-gateway');
    assert.ok(router.fallback);
    assert.equal(router.fallback?.gatewayId, undefined);
  });

  await t.test(
    'the fallback does not inherit a gateway-local model name across a different base URL',
    () => {
      // A LiteLLM/self-hosted model name is meaningless at api.openai.com:
      // inheriting it turned a recoverable gateway blip into a 404
      // model_not_found on the fallback attempt.
      clearAlexandriaEnv();
      process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
      process.env.ALEXANDRIA_API_KEY = 'gateway-key';
      process.env.ALEXANDRIA_ROUTER_MODEL = 'litellm/llama-3.1-70b';
      process.env.OPENAI_API_KEY = 'sk-direct';

      const router = roleConfig('router');
      assert.equal(router.model, 'litellm/llama-3.1-70b', 'the primary keeps the gateway model');
      assert.ok(router.fallback);
      assert.equal(router.fallback?.baseURL, 'https://api.openai.com/v1');
      assert.notEqual(router.fallback?.model, router.model);
      assert.equal(router.fallback?.model, 'gpt-4o-mini', 'the role default');

      // Per-role defaults, not the router's, for the other roles.
      process.env.ALEXANDRIA_RESEARCH_MODEL = 'litellm/llama-3.1-70b';
      assert.equal(roleConfig('research').fallback?.model, 'gpt-4o');
      process.env.ALEXANDRIA_EMBEDDINGS_MODEL = 'bge-m3';
      assert.equal(roleConfig('embeddings').fallback?.model, 'text-embedding-3-small');
    },
  );

  await t.test('a fallback on the SAME base URL keeps the configured model', () => {
    // Only the key differs, so the model name is still valid there.
    clearAlexandriaEnv();
    process.env.ALEXANDRIA_BASE_URL = 'https://api.openai.com/v1';
    process.env.ALEXANDRIA_API_KEY = 'sk-project-scoped';
    process.env.ALEXANDRIA_ROUTER_MODEL = 'gpt-4o';
    process.env.OPENAI_API_KEY = 'sk-direct';

    const router = roleConfig('router');
    assert.ok(router.fallback);
    assert.equal(router.fallback?.model, 'gpt-4o');
  });

  await t.test('no fallback is attached when there is no gateway configured', () => {
    clearAlexandriaEnv();
    process.env.OPENAI_API_KEY = 'sk-direct';
    assert.equal(roleConfig('router').fallback, undefined);
  });
});

test('roleConfig: verify falls back to synth', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test(
    'with no ALEXANDRIA_VERIFY_* set, verify resolves to exactly what synth resolves to',
    () => {
      clearAlexandriaEnv();
      process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
      process.env.ALEXANDRIA_API_KEY = 'shared-key';
      process.env.ALEXANDRIA_SYNTH_MODEL = 'custom-synth-model';

      const synth = roleConfig('synth');
      const verify = roleConfig('verify');
      assert.deepEqual(verify, synth);
      assert.equal(verify.model, 'custom-synth-model');
    },
  );

  await t.test(
    'setting ALEXANDRIA_VERIFY_MODEL alone opts back into normal per-role resolution',
    () => {
      clearAlexandriaEnv();
      process.env.ALEXANDRIA_BASE_URL = 'http://gateway.example/v1';
      process.env.ALEXANDRIA_API_KEY = 'shared-key';
      process.env.ALEXANDRIA_SYNTH_MODEL = 'custom-synth-model';
      process.env.ALEXANDRIA_VERIFY_MODEL = 'custom-verify-model';

      const verify = roleConfig('verify');
      assert.equal(verify.model, 'custom-verify-model');
      // Still inherits the shared base URL/key - only the model differs.
      assert.equal(verify.baseURL, 'http://gateway.example/v1');
      assert.equal(verify.apiKey, 'shared-key');
    },
  );

  await t.test('a full ALEXANDRIA_VERIFY_* override is used as-is, independent of synth', () => {
    clearAlexandriaEnv();
    process.env.ALEXANDRIA_SYNTH_API_KEY = 'synth-key';
    process.env.ALEXANDRIA_VERIFY_BASE_URL = 'http://verify-only.example/v1';
    process.env.ALEXANDRIA_VERIFY_API_KEY = 'verify-key';
    process.env.ALEXANDRIA_VERIFY_MODEL = 'verify-model';

    const verify = roleConfig('verify');
    assert.equal(verify.baseURL, 'http://verify-only.example/v1');
    assert.equal(verify.apiKey, 'verify-key');
    assert.equal(verify.model, 'verify-model');
  });

  await t.test('with no key anywhere, verify (via synth) has an empty apiKey, not a throw', () => {
    clearAlexandriaEnv();
    assert.equal(roleConfig('verify').apiKey, '');
  });
});

test('getClient', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('throws a clear error, not an SDK stack trace, when no key is configured', () => {
    clearAlexandriaEnv();
    assert.throws(
      () => getClient('router'),
      /router requires OPENAI_API_KEY or ALEXANDRIA_ROUTER_API_KEY/,
    );
  });

  await t.test('is memoized per baseURL+key', () => {
    clearAlexandriaEnv();
    process.env.OPENAI_API_KEY = 'sk-test';
    const a = getClient('router');
    const b = getClient('router');
    assert.equal(a, b);
  });
});

test('chatJSON', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
    openaiBaseUrlOverride.value = 'https://api.openai.com/v1';
  });

  const Schema = z.object({ intent: z.string(), n: z.number() });

  await t.test('throws a clear error when no api key is configured for the role', async () => {
    clearAlexandriaEnv();
    await assert.rejects(
      () => chatJSON('router', 'sys', 'user', Schema),
      /router requires OPENAI_API_KEY or ALEXANDRIA_ROUTER_API_KEY/,
    );
  });

  await t.test('retries once on invalid JSON, appending the validation error', async () => {
    const server = await startFakeServer((call) => {
      if (call === 1) return { status: 200, body: chatCompletion('not valid json at all') };
      return { status: 200, body: chatCompletion(JSON.stringify({ intent: 'find X', n: 3 })) };
    });
    t.after(() => server.close());

    clearAlexandriaEnv();
    process.env.ALEXANDRIA_ROUTER_BASE_URL = server.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

    const result = await chatJSON('router', 'You are a router.', 'find X', Schema);
    assert.deepEqual(result, { intent: 'find X', n: 3 });
    assert.equal(server.chatRequests.length, 2);
    const retryMessages = server.chatRequests[1].body as {
      messages: Array<{ role: string; content: string }>;
    };
    assert.match(retryMessages.messages[1].content, /previous response was invalid/);
  });

  await t.test(
    'ALEXANDRIA_<ROLE>_GATEWAY_ID reaches the request as the cf-aig-gateway-id header',
    async () => {
      const server = await startFakeServer(() => ({
        status: 200,
        body: chatCompletion(JSON.stringify({ intent: 'x', n: 1 })),
      }));
      t.after(() => server.close());

      clearAlexandriaEnv();
      process.env.ALEXANDRIA_ROUTER_BASE_URL = server.url;
      process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';
      process.env.ALEXANDRIA_ROUTER_GATEWAY_ID = 'my-named-gateway';

      await chatJSON('router', 'sys', 'user', Schema);
      assert.equal(server.chatRequests.length, 1);
      assert.equal(server.chatRequests[0].headers['cf-aig-gateway-id'], 'my-named-gateway');
    },
  );

  await t.test('no cf-aig-gateway-id header is sent when no gateway id is configured', async () => {
    const server = await startFakeServer(() => ({
      status: 200,
      body: chatCompletion(JSON.stringify({ intent: 'x', n: 1 })),
    }));
    t.after(() => server.close());

    clearAlexandriaEnv();
    process.env.ALEXANDRIA_ROUTER_BASE_URL = server.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

    await chatJSON('router', 'sys', 'user', Schema);
    assert.equal(server.chatRequests[0].headers['cf-aig-gateway-id'], undefined);
  });

  await t.test('fails after two invalid responses', async () => {
    const server = await startFakeServer(() => ({
      status: 200,
      body: chatCompletion('still not json'),
    }));
    t.after(() => server.close());

    clearAlexandriaEnv();
    process.env.ALEXANDRIA_ROUTER_BASE_URL = server.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

    await assert.rejects(
      () => chatJSON('router', 'sys', 'user', Schema),
      /failed schema validation twice/,
    );
    assert.equal(server.chatRequests.length, 2);
  });

  await t.test('asks for JSON in the prompt when the backend is not api.openai.com', async () => {
    const server = await startFakeServer(() => ({
      status: 200,
      body: chatCompletion(JSON.stringify({ intent: 'x', n: 1 })),
    }));
    t.after(() => server.close());

    clearAlexandriaEnv();
    process.env.ALEXANDRIA_ROUTER_BASE_URL = server.url;
    process.env.ALEXANDRIA_ROUTER_API_KEY = 'test-key';

    await chatJSON('router', 'sys', 'user', Schema);
    const sent = server.chatRequests[0].body as {
      response_format?: unknown;
      messages: Array<{ content: string }>;
    };
    assert.equal(sent.response_format, undefined);
    assert.match(sent.messages[0].content, /Respond with valid JSON only/);
  });

  await t.test(
    'falls back to the direct-OpenAI config once on a 5xx from the gateway',
    async () => {
      const gateway = await startFakeServer(() => ({
        status: 500,
        body: { error: { message: 'gateway is down' } },
      }));
      t.after(() => gateway.close());
      const direct = await startFakeServer(() => ({
        status: 200,
        body: chatCompletion(JSON.stringify({ intent: 'x', n: 1 })),
      }));
      t.after(() => direct.close());

      clearAlexandriaEnv();
      process.env.ALEXANDRIA_BASE_URL = gateway.url;
      process.env.ALEXANDRIA_API_KEY = 'gateway-key';
      process.env.OPENAI_API_KEY = 'sk-direct';
      openaiBaseUrlOverride.value = direct.url;

      const result = await chatJSON('router', 'sys', 'user', Schema);
      assert.deepEqual(result, { intent: 'x', n: 1 });
      assert.equal(gateway.chatRequests.length, 1);
      assert.equal(direct.chatRequests.length, 1);

      openaiBaseUrlOverride.value = 'https://api.openai.com/v1';
    },
  );
});

test('chatText', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('returns the raw completion text', async () => {
    const server = await startFakeServer(() => ({
      status: 200,
      body: chatCompletion('hello from the fake server'),
    }));
    t.after(() => server.close());

    clearAlexandriaEnv();
    process.env.ALEXANDRIA_SYNTH_BASE_URL = server.url;
    process.env.ALEXANDRIA_SYNTH_API_KEY = 'test-key';

    const text = await chatText('synth', 'sys', 'user');
    assert.equal(text, 'hello from the fake server');
  });
});

test('embed', async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => {
    process.env = originalEnv;
  });

  await t.test('returns [] for an empty input without a network call', async () => {
    clearAlexandriaEnv();
    assert.deepEqual(await embed([]), []);
  });

  await t.test('throws a clear error when no api key is configured', async () => {
    clearAlexandriaEnv();
    await assert.rejects(
      () => embed(['x']),
      /embeddings requires OPENAI_API_KEY or ALEXANDRIA_EMBEDDINGS_API_KEY/,
    );
  });

  await t.test('embeds and caches the dimension from the first response', async () => {
    const server = await startFakeServer(() => ({ status: 200, body: chatCompletion('unused') }));
    t.after(() => server.close());

    clearAlexandriaEnv();
    process.env.ALEXANDRIA_EMBEDDINGS_BASE_URL = server.url;
    process.env.ALEXANDRIA_EMBEDDINGS_API_KEY = 'test-key';

    const vectors = await embed(['a', 'b']);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, 3);
    assert.equal(embeddingDimensions(), 3);
  });
});
