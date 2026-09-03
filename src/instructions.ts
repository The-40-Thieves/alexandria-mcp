// Server-wide `instructions` (McpServer's `instructions` option, passed at
// src/index.ts's `new McpServer(...)`): a MAY-level MCP hint, honored by
// Claude Code but not by every client, so tool descriptions stay
// self-sufficient (each still names what/when/when-not) and this text adds
// cross-tool guidance instead of repeating them. Return-shape prose that
// used to live in library_ask's and library_answer's descriptions moved
// here and to each tool's outputSchema, which is now the authoritative
// shape (see task-1-brief.md, research/vault-ideas-verdicts.md section 10).
//
// Kept under 1500 characters (a budget, not a hard protocol limit) so it
// stays cheap to inject on every session.
export const INSTRUCTIONS =
  'Alexandria searches 138 public research libraries: papers, books, law, government records, security advisories, news, and developer docs. Start with library_ask for any natural-language request; it routes to the best sources automatically. Use library_search only when you already know which source to query, library_read(id, source) to fetch full text, and library_answer or library_research when you want a cited answer or report instead of raw results. Results are source:id pairs; pass both back to library_read. Sources marked metadata-only return an external URL instead of full text. Realtime clusters (news, security, markets) are re-fetched on every call; other results are cached for 10 minutes. Default responses are concise; set response_format: "detailed" for routing reasons, relevance scores, or citation grades. If a source errors, retry with a different source or library_ask rather than repeating the same call.';
