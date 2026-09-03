// Server-wide `instructions` (McpServer's `instructions` option, passed at
// src/index.ts's `new McpServer(...)`): a MAY-level MCP hint, honored by
// Claude Code but not by every client, so tool descriptions stay
// self-sufficient (each still names what/when/when-not) and this text adds
// cross-tool guidance instead of repeating them. Return-shape prose that
// used to live in library_ask's and library_answer's descriptions moved
// here and to each tool's outputSchema, which is now the authoritative
// shape (see task-1-brief.md, research/vault-ideas-verdicts.md section 10).
//
// The source count is the one part of this text that drifts: every other
// place it appears (library_list_sources's description, README.md,
// docs/sources.md) is computed from the live registry, never hardcoded, so
// this is too (task 1 review finding 2) - `buildInstructions` takes it as a
// parameter instead of baking a snapshot into a module-level constant.
//
// Kept under 1500 characters (a budget, not a hard protocol limit) so it
// stays cheap to inject on every session; see instructions.test.ts.
const STATIC_INSTRUCTIONS =
  'Start with library_ask for any natural-language request; it routes to the best sources automatically. Use library_search only when you already know which source to query, library_read(id, source) to fetch full text, and library_answer or library_research when you want a cited answer or report instead of raw results. Results are source:id pairs; pass both back to library_read. Sources marked metadata-only return an external URL instead of full text. Search results from every source are cached for up to 10 minutes; full-text reads are cached by source freshness (static 24h, daily 10min, realtime never). Default responses are concise; set response_format: "detailed" for routing reasons, relevance scores, or citation grades. If a source errors, retry with a different source or library_ask rather than repeating the same call.';

export function buildInstructions(sourceCount: number): string {
  return `Alexandria searches ${sourceCount} public research libraries: papers, books, law, government records, security advisories, news, and developer docs. ${STATIC_INSTRUCTIONS}`;
}
