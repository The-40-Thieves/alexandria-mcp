// THE-318: a per-role OpenAI-compatible provider table. Every LLM/embedding
// call in this repo goes through here so the same build runs against
// OpenAI directly, a LiteLLM gateway, or Cloudflare AI Gateway by env alone
// (see README's "Pointing roles at a gateway" section).
//
// Env precedence per role (router | synth | research | embeddings | rerank):
//   1. ALEXANDRIA_<ROLE>_BASE_URL / _API_KEY / _MODEL
//   2. ALEXANDRIA_BASE_URL / ALEXANDRIA_API_KEY (shared across every role)
//   3. OPENAI_API_KEY, with baseURL defaulted to https://api.openai.com/v1
// With only OPENAI_API_KEY set, every role resolves to (1) and (2) empty,
// so this collapses to exactly today's behavior: gpt-4o-mini against
// api.openai.com for router/synth, text-embedding-3-small for embeddings.
import OpenAI from 'openai';
import type { z } from 'zod';
import { config } from '../config.ts';
import { requestContext } from './http.ts';
import { toolMetrics } from './metrics.ts';

// Task 9 adds 'verify' (claim/citation verification, src/utils/claimCheck.ts)
// with its own env-var quartet (ALEXANDRIA_VERIFY_*), but falls all the way
// back to the synth role's already-resolved config, not just the shared
// ALEXANDRIA_BASE_URL/_API_KEY defaults every other role uses - see
// roleConfig() below.
export type Role = 'router' | 'synth' | 'research' | 'embeddings' | 'rerank' | 'verify';

export interface RoleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  fallback?: RoleConfig;
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

// Test-only override for the "direct OpenAI" target used both as the
// no-gateway-configured default and as the gateway-failure fallback target
// below (normally always https://api.openai.com/v1). Same pattern as
// fetchTier.ts's dnsResolver: a plain mutable ref a test can swap so it can
// exercise the fallback path against a local fixture server instead of the
// real OpenAI API.
export const openaiBaseUrlOverride: { value: string } = { value: OPENAI_BASE_URL };

function defaultModel(role: Role): string {
  switch (role) {
    case 'router':
      return 'gpt-4o-mini';
    case 'synth':
      return 'gpt-4o-mini';
    case 'research':
      return 'gpt-4o';
    case 'embeddings':
      return 'text-embedding-3-small';
    case 'rerank':
      return 'gpt-4o-mini'; // same default as synth
    case 'verify':
      return 'gpt-4o-mini'; // same default as synth; only reached when ALEXANDRIA_VERIFY_MODEL is set without a matching base URL/key (see roleConfig's whole-config fallback below for the common case)
  }
}

function envKey(role: Role, suffix: 'BASE_URL' | 'API_KEY' | 'MODEL' | 'JSON_MODE'): string {
  return `ALEXANDRIA_${role.toUpperCase()}_${suffix}`;
}

// Attributed to whichever MCP tool is currently in flight (index.ts wraps
// every tool handler in requestContext.run() with its name - see
// src/utils/http.ts's RequestContextStore), or "unknown" for a call made
// outside that context (a script, a direct unit test).
function recordLlmCall(): void {
  const tool = requestContext.getStore()?.tool ?? 'unknown';
  toolMetrics(tool).llmCalls++;
}

// config's keys are literally the env var names (see config.ts's module
// comment), so envKey()'s dynamic suffix composition still works - just
// indexed against the validated config object instead of raw process.env.
function configValue(key: string): string | undefined {
  return config[key as keyof typeof config] as string | undefined;
}

// env: ALEXANDRIA_<ROLE>_BASE_URL, _API_KEY, _MODEL; then ALEXANDRIA_BASE_URL/
// _API_KEY as shared defaults; then OPENAI_API_KEY with
// https://api.openai.com/v1.
export function roleConfig(role: Role): RoleConfig {
  // Task 9's `verify` role (claim/citation entailment checks) is meant to
  // be free to run out of the box once `synth` is configured, rather than
  // needing its own ALEXANDRIA_VERIFY_* setup - dedicating a whole extra
  // model just to double-check the first one is an opt-in, not a
  // requirement. When NONE of ALEXANDRIA_VERIFY_BASE_URL/_API_KEY/_MODEL are
  // set, `verify` resolves to exactly whatever `synth` resolves to
  // (including synth's own fallback target), rather than falling through to
  // the shared ALEXANDRIA_BASE_URL/_API_KEY/OPENAI_API_KEY chain every other
  // role uses. Setting any one of the three opts back into that normal
  // per-role resolution below (so, e.g., ALEXANDRIA_VERIFY_MODEL alone
  // still inherits the shared base URL/key, only the model differs).
  if (role === 'verify') {
    const hasOwnVerifyConfig = ['BASE_URL', 'API_KEY', 'MODEL'].some((suffix) =>
      configValue(envKey('verify', suffix as 'BASE_URL' | 'API_KEY' | 'MODEL')),
    );
    if (!hasOwnVerifyConfig) return roleConfig('synth');
  }

  const roleBaseURL = configValue(envKey(role, 'BASE_URL'));
  const roleApiKey = configValue(envKey(role, 'API_KEY'));
  const roleModel = configValue(envKey(role, 'MODEL'));
  const sharedBaseURL = config.ALEXANDRIA_BASE_URL;
  const sharedApiKey = config.ALEXANDRIA_API_KEY;
  const openaiApiKey = config.OPENAI_API_KEY;

  const directBaseURL = openaiBaseUrlOverride.value;
  const usingGateway = Boolean(roleBaseURL || sharedBaseURL);
  const baseURL = roleBaseURL || sharedBaseURL || directBaseURL;
  const apiKey = roleApiKey || sharedApiKey || openaiApiKey || '';
  const model = roleModel || defaultModel(role);

  const resolved: RoleConfig = { baseURL, apiKey, model };

  // When the primary points at a gateway rather than OpenAI directly, and a
  // direct OpenAI key is also available, wire it up as a one-shot fallback
  // for chatJSON/chatText to use on a network error or 5xx from the
  // gateway. With only OPENAI_API_KEY set, usingGateway is false, so no
  // fallback is attached and behavior matches today exactly.
  if (usingGateway && openaiApiKey && (baseURL !== directBaseURL || apiKey !== openaiApiKey)) {
    // The fallback targets OpenAI directly. When that is a DIFFERENT origin
    // from the primary, the primary's model name is a gateway-local alias
    // (a LiteLLM route name, a Cloudflare AI Gateway model id, a
    // self-hosted model) that OpenAI answers with 404 model_not_found,
    // turning a recoverable gateway blip into a hard failure. Use the
    // role's own default there. When the fallback shares the primary's
    // origin (same base URL, different key) the model name is still valid,
    // so it is kept.
    const fallbackModel = baseURL === directBaseURL ? model : defaultModel(role);
    resolved.fallback = { baseURL: directBaseURL, apiKey: openaiApiKey, model: fallbackModel };
  }

  return resolved;
}

function requireApiKey(role: Role, config: RoleConfig): void {
  if (!config.apiKey) {
    throw new Error(`${role} requires OPENAI_API_KEY or ${envKey(role, 'API_KEY')}`);
  }
}

// A tool-level "no key configured" check, distinct from requireApiKey()
// above (which names the plain role and backs chatJSON/chatText/getClient).
// library_answer and library_research call this before doing any other
// work, so a missing key surfaces as a clean, tool-named error instead of
// failing partway through a routing/search/read pipeline.
export function requireRoleForTool(tool: string, role: Role): void {
  if (!roleConfig(role).apiKey) {
    throw new Error(
      `${tool} requires a ${role} model: set OPENAI_API_KEY or ${envKey(role, 'API_KEY')}`,
    );
  }
}

const clientCache = new Map<string, OpenAI>();

function clientFor(config: RoleConfig): OpenAI {
  const key = `${config.baseURL}::${config.apiKey}`;
  let client = clientCache.get(key);
  if (!client) {
    // maxRetries: 0 - retry/fallback policy is owned by chatJSON/chatText
    // above (one same-config retry on invalid JSON, one fallback-config
    // attempt on a network error or 5xx), not by the SDK's own hidden
    // exponential-backoff retries stacking on top of that.
    client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, maxRetries: 0 });
    clientCache.set(key, client);
  }
  return client;
}

// Memoized per baseURL+key.
export function getClient(role: Role): OpenAI {
  const config = roleConfig(role);
  requireApiKey(role, config);
  return clientFor(config);
}

// response_format: { type: 'json_object' } is an OpenAI-specific field that
// not every OpenAI-compatible backend honors. Only ask for it when the
// backend is api.openai.com, or the deployer has confirmed (via
// ALEXANDRIA_<ROLE>_JSON_MODE=1) that their gateway/model supports it;
// otherwise fall back to asking for JSON in the prompt.
function supportsJsonMode(role: Role, roleCfg: RoleConfig): boolean {
  if (configValue(envKey(role, 'JSON_MODE')) === '1') return true;
  try {
    return new URL(roleCfg.baseURL).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function withJsonInstruction(system: string): string {
  return `${system}\n\nRespond with valid JSON only. Do not include markdown code fences, explanation, or any text outside the JSON object.`;
}

function buildMessages(system: string, user: string): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function isTransportError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (err instanceof OpenAI.APIError) {
    return typeof err.status === 'number' && err.status >= 500;
  }
  return false;
}

async function callChat(
  config: RoleConfig,
  messages: OpenAI.ChatCompletionMessageParam[],
  jsonMode: boolean,
): Promise<string> {
  const client = clientFor(config);
  recordLlmCall();
  const response = await client.chat.completions.create({
    model: config.model,
    messages,
    ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`chat: empty response from ${config.model}`);
  return content;
}

type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: string };

function validateJson<T>(content: string, schema: z.ZodType<T>): ValidateResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, value: result.data };
}

// Always validates with `schema` and retries once, on the same config, with
// the validation error appended to the user prompt (graceful degradation
// for small/local models that don't reliably follow a JSON schema on the
// first try).
async function chatJSONWithRetry<T>(
  role: Role,
  config: RoleConfig,
  system: string,
  user: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const jsonMode = supportsJsonMode(role, config);
  const sys = jsonMode ? system : withJsonInstruction(system);

  const first = await callChat(config, buildMessages(sys, user), jsonMode);
  const firstResult = validateJson(first, schema);
  if (firstResult.ok) return firstResult.value;

  const retryUser = `${user}\n\nYour previous response was invalid (${firstResult.error}). Respond again with valid JSON only, matching the required schema exactly.`;
  const second = await callChat(config, buildMessages(sys, retryUser), jsonMode);
  const secondResult = validateJson(second, schema);
  if (secondResult.ok) return secondResult.value;

  throw new Error(
    `chatJSON: response for role "${role}" failed schema validation twice: ${secondResult.error}`,
  );
}

async function attemptChatJSON<T>(
  role: Role,
  config: RoleConfig,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  allowFallback: boolean,
): Promise<T> {
  try {
    return await chatJSONWithRetry(role, config, system, user, schema);
  } catch (err) {
    if (allowFallback && config.fallback && isTransportError(err)) {
      return attemptChatJSON(role, config.fallback, system, user, schema, false);
    }
    throw err;
  }
}

// response_format json_object when the backend supports it; always
// validates with zod and retries once with the validation error appended;
// on network/5xx it tries the role's `fallback` config once.
export async function chatJSON<T>(
  role: Role,
  system: string,
  user: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const config = roleConfig(role);
  requireApiKey(role, config);
  return attemptChatJSON(role, config, system, user, schema, true);
}

async function attemptChatText(
  config: RoleConfig,
  system: string,
  user: string,
  allowFallback: boolean,
): Promise<string> {
  try {
    return await callChat(config, buildMessages(system, user), false);
  } catch (err) {
    if (allowFallback && config.fallback && isTransportError(err)) {
      return attemptChatText(config.fallback, system, user, false);
    }
    throw err;
  }
}

export async function chatText(role: Role, system: string, user: string): Promise<string> {
  const config = roleConfig(role);
  requireApiKey(role, config);
  return attemptChatText(config, system, user, true);
}

const EMBED_BATCH_SIZE = 100;
let cachedEmbeddingDimensions: number | undefined;

// Dimension is read from the first response and cached for the life of the
// process rather than requested explicitly, since not every OpenAI-compatible
// embeddings backend supports the `dimensions` request param.
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const config = roleConfig('embeddings');
  requireApiKey('embeddings', config);
  const client = clientFor(config);

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    recordLlmCall();
    const response = await client.embeddings.create({ model: config.model, input: batch });
    for (const item of response.data) {
      if (cachedEmbeddingDimensions === undefined) {
        cachedEmbeddingDimensions = item.embedding.length;
      }
      results.push(item.embedding);
    }
  }
  return results;
}

export function embeddingDimensions(): number | undefined {
  return cachedEmbeddingDimensions;
}

// Whether the embeddings role has enough configuration to call embed()
// without throwing: an OPENAI_API_KEY, or an explicit
// ALEXANDRIA_EMBEDDINGS_* / shared ALEXANDRIA_API_KEY override.
export function hasEmbeddingsConfigured(): boolean {
  return Boolean(roleConfig('embeddings').apiKey);
}
