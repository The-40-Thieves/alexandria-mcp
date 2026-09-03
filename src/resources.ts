// Task 14 (2026-07-28 dual-era handler, brief 05): a document resource
// template so a client that supports MCP resources (Claude Code's `@srv:uri`,
// VS Code's Add Context) can pull an item's full text directly, without a
// `library_read` tool round trip. Registered once by `registerResources()`,
// called from `createServer()` in src/index.ts alongside the tool/prompt
// registration, so it serves both eras through the same factory.
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { getAdapter, type SourceAdapter } from './sources/registry.ts';
import type { ReadResult } from './types.ts';

// A URI template variable expands to a string, except when the template
// explodes a list (`{?var*}`) - not the case for either `{source}` or `{id}`
// here, but Variables' declared type is `string | string[]` regardless, so a
// defensive first-element pick keeps this correct if that ever changes.
function firstValue(v: string | string[]): string {
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

/**
 * Registers `library://doc/{source}/{id}`, reading the same text
 * `library_read` returns (including Task 6's open-access fallback) for the
 * given source/id pair.
 */
export function registerResources(
  server: McpServer,
  withOpenAccessFallback: (result: ReadResult) => Promise<ReadResult>,
): void {
  server.registerResource(
    'library_document',
    new ResourceTemplate('library://doc/{source}/{id}', { list: undefined }),
    {
      title: 'Library Document',
      description:
        'Full text (or a metadata note, when no full text is available) for one item from a library source, addressed by the source name and id library_search or library_ask returned.',
      mimeType: 'text/plain',
    },
    async (uri, { source, id }) => {
      const sourceName = firstValue(source);
      const itemId = firstValue(id);
      if (!sourceName || !itemId) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `library://doc/{source}/{id} needs both segments, got "${uri.href}"`,
        );
      }
      // Only the source lookup is translated to "not found" - an error
      // thrown by adapter.read() itself (quota exceeded, rate-limited,
      // timed out, a real upstream network failure) must reach the caller
      // as-is, the way library_read's handler in src/index.ts preserves
      // err.message rather than relabeling every failure "not found".
      let adapter: SourceAdapter;
      try {
        adapter = getAdapter(sourceName);
      } catch {
        throw new ResourceNotFoundError(uri.href);
      }
      const raw = await adapter.read(itemId);
      const result = await withOpenAccessFallback(raw);
      const text =
        result.text ?? result.note ?? `No full text available for ${sourceName}:${itemId}.`;
      return {
        contents: [{ uri: uri.href, mimeType: 'text/plain', text }],
      };
    },
  );
}
