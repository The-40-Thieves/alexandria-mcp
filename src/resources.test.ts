import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { registerResources } from './resources.ts';
import { register } from './sources/registry.ts';
import type { ReadResult } from './types.ts';

// In-process client/server pair over InMemoryTransport, same pattern as
// prompts.test.ts. `withOpenAccessFallback` is injected rather than
// imported from src/index.ts (registerResources takes it as a parameter
// precisely so this file never needs index.ts's HTTP wiring, or a real
// network call, to exercise the resource template).
async function connectedClient(
  withOpenAccessFallback: (result: ReadResult) => Promise<ReadResult>,
): Promise<Client> {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  registerResources(server, withOpenAccessFallback);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('library://doc/{source}/{id} reads through the adapter and the given fallback', async () => {
  register('t_resources_unit_fixture', {
    description: 'fixture source for the resources.ts unit tests',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [], text: 'raw stub text' };
    },
  });

  let fallbackCalls = 0;
  const client = await connectedClient(async (result) => {
    fallbackCalls++;
    // Proves the read path actually routes the adapter's result through
    // the injected fallback rather than returning it untouched.
    return { ...result, text: 'fallback text' };
  });

  const result = await client.readResource({ uri: 'library://doc/t_resources_unit_fixture/x1' });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0]?.uri, 'library://doc/t_resources_unit_fixture/x1');
  assert.equal(result.contents[0]?.mimeType, 'text/plain');
  assert.equal((result.contents[0] as { text?: string }).text, 'fallback text');
});

test('an unknown source rejects rather than returning empty content', async () => {
  const client = await connectedClient(async (result) => result);
  await assert.rejects(() =>
    client.readResource({ uri: 'library://doc/t_resources_unit_no_such_source/x1' }),
  );
});

test('a quota/upstream error from adapter.read() surfaces its own message, not "not found"', async () => {
  register('t_resources_unit_quota_error', {
    description: 'fixture source whose read() fails with a non-lookup error',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      throw new Error('quota exceeded for t_resources_unit_quota_error');
    },
  });
  const client = await connectedClient(async (result) => result);
  await assert.rejects(
    () => client.readResource({ uri: 'library://doc/t_resources_unit_quota_error/x1' }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /quota exceeded for t_resources_unit_quota_error/);
      assert.doesNotMatch(message.toLowerCase(), /not found/);
      return true;
    },
  );
});

test('no text and no note falls back to a "no full text available" message', async () => {
  register('t_resources_unit_metadata_only', {
    description: 'fixture source with no full text',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read() {
      return { title: 'x', authors: [], metadataOnly: true };
    },
  });
  const client = await connectedClient(async (result) => result); // no-op: adds no text/note
  const result = await client.readResource({
    uri: 'library://doc/t_resources_unit_metadata_only/x9',
  });
  assert.match(
    String((result.contents[0] as { text?: string }).text),
    /No full text available for t_resources_unit_metadata_only:x9/,
  );
});

// Final wave (E1): plenty of real ids contain '/' - every DOI (crossref,
// datacite, opencitations) and codewiki/readthedocs' path-shaped ids. The
// resource_link URIs library_search emits encode the id, and this handler
// decodes it, so the id the adapter is asked for is the id the caller was
// given back.
test('a DOI-shaped id survives the resource URI round trip', async () => {
  const DOI = '10.1234/abc.def/2026';
  let readWith: string | undefined;
  register('t_resources_doi_fixture', {
    description: 'fixture source for the E1 encoded-id test',
    supportsIngest: false,
    async search() {
      return [];
    },
    async read(id: string) {
      readWith = id;
      return { title: 'x', authors: [], text: `text for ${id}` };
    },
  });

  const client = await connectedClient(async (result) => result);
  const uri = `library://doc/t_resources_doi_fixture/${encodeURIComponent(DOI)}`;
  const result = await client.readResource({ uri });

  assert.equal(readWith, DOI, 'the adapter must be asked for the decoded id');
  assert.equal((result.contents[0] as { text?: string }).text, `text for ${DOI}`);
});
