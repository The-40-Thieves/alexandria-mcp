---
name: alexandria
description: Reach for this when a research question needs cited sources across academic papers, public domain books, legal records, government archives, security advisories, news, or developer documentation. Alexandria is an MCP server backed by 152 public digital libraries; use it whenever an answer should point at real, checkable sources rather than come from memory alone.
---

# Alexandria

Query, read, and ingest texts from 152 public digital libraries through the
`@the-40-thieves/alexandria-mcp` MCP server.

## Install

```bash
npx -y @the-40-thieves/alexandria-mcp
```

Or add it to a client directly, for example Claude Code:

```bash
claude mcp add alexandria -- npx -y @the-40-thieves/alexandria-mcp
```

Search and read need no credentials. `library_ask`, `library_answer`,
`library_research`, and `library_ingest` need `OPENAI_API_KEY`; see the
[README](../../README.md#credentials) for the full list of optional keys.

## Workflow

Start with `library_ask(query)` - it routes a natural-language question to
the best sources and searches them in parallel. Use `library_search(query,
source, limit?)` instead when you already know which of the 152 sources to
query.

Once a result names a `source`/`id` pair, `library_read(id, source)` fetches
the full text.

For a synthesized, cited answer instead of raw results, use
`library_answer(query)` for a single question or `library_research(query,
depth?, breadth?, max_minutes?)` for a recursive multi-round report that
generates its own follow-up queries.

`library_citations(id, source, direction, limit?, format?)` walks the
citation graph around an item forward (`direction: "citations"`) or backward
(`direction: "references"`) for snowball searching, and can export the
result as a `bibtex`, `ris`, or `apa` bibliography.

If a source looks like it is misbehaving (no results, stale data, repeated
errors), call `library_health_check(source?, cluster?)` before trusting or
retrying it.

## response_format

`library_ask`, `library_search`, `library_answer`, `library_research`, and
`library_health_check` take `response_format: "concise" | "detailed"`
(default `concise`). `concise` returns the high-signal fields only (title,
source, id, year, hasFullText, url; the answer/report plus citations; health
name, cluster, status). `detailed` adds routing reasons, relevance scores,
per-stage diagnostics, and per-source error rate, latency, and quota usage -
ask for it when you need to explain or debug a result, not by default.
