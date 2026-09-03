import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { registerPrompts } from './prompts.ts';

// In-process client/server pair over InMemoryTransport (the SDK's own
// documented test pattern for a plain 2025-era connection) - no HTTP
// listener, so this exercises registerPrompts() in isolation from
// src/index.ts's dual-era wiring, which src/index.test.ts covers separately.
async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  registerPrompts(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function messageText(content: unknown): string {
  return typeof content === 'object' && content !== null && 'text' in content
    ? String((content as { text: unknown }).text)
    : '';
}

test('registerPrompts registers exactly the three research-workflow prompts', async () => {
  const client = await connectedClient();
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), [
    'fact_check_claim',
    'literature_review',
    'verify_bibliography',
  ]);
});

test('literature_review returns one user message naming its tools in order', async () => {
  const client = await connectedClient();
  const { messages } = await client.getPrompt({
    name: 'literature_review',
    arguments: { topic: 'gut microbiome', depth: '3' },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'user');
  const text = messageText(messages[0]?.content);
  assert.match(text, /gut microbiome/);
  assert.match(text, /depth 3/); // depth arrives as the wire string "3", coerced to a number
  const order = [
    'library_list_sources',
    'library_ask',
    'library_research',
    'library_citations',
  ].map((tool) => text.indexOf(tool));
  assert.ok(
    order.every((i) => i >= 0),
    `expected all four tools named in: ${text}`,
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'tools must be named in the order they should be called',
  );
});

test('literature_review omits the depth clause when depth is not given', async () => {
  const client = await connectedClient();
  const { messages } = await client.getPrompt({
    name: 'literature_review',
    arguments: { topic: 'x' },
  });
  assert.doesNotMatch(messageText(messages[0]?.content), /depth \d/);
});

test('fact_check_claim returns one user message naming its tools in order', async () => {
  const client = await connectedClient();
  const { messages } = await client.getPrompt({
    name: 'fact_check_claim',
    arguments: { claim: 'X causes Y' },
  });
  assert.equal(messages.length, 1);
  const text = messageText(messages[0]?.content);
  assert.match(text, /X causes Y/);
  const order = ['library_ask', 'library_read', 'library_answer'].map((tool) => text.indexOf(tool));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});

test('verify_bibliography returns one user message naming its tools in order', async () => {
  const client = await connectedClient();
  const { messages } = await client.getPrompt({
    name: 'verify_bibliography',
    arguments: { references: 'Smith, 2020\nJones, 2021' },
  });
  assert.equal(messages.length, 1);
  const text = messageText(messages[0]?.content);
  assert.match(text, /Smith, 2020/);
  assert.match(text, /Jones, 2021/);
  const order = ['library_search', 'library_citations', 'library_read'].map((tool) =>
    text.indexOf(tool),
  );
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});
