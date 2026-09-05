# Privacy policy

Alexandria is a Model Context Protocol server. It runs locally (or on
infrastructure you operate) and has no telemetry of its own; nothing about
your queries, results, or credentials is sent to the Alexandria project.

## What the server sends, and to whom

- **Queries and searches** go to the upstream public library sources the
  agent selects for a given request (arXiv, Project Gutenberg, PubMed,
  CourtListener, and the rest of the 152 sources in
  [docs/sources.md](docs/sources.md)), using each source's own public API
  under that source's own terms.
- **`library_ask`, `library_answer`, `library_research`, and
  `library_ingest`**, when an `OPENAI_API_KEY` (or an OpenAI-compatible
  gateway configured through `ALEXANDRIA_BASE_URL`) is set, also send your
  query text and retrieved excerpts to that LLM and embeddings provider, as
  configured by whoever runs the server. See
  [docs/cloudflare.md](docs/cloudflare.md) for the Cloudflare AI Gateway
  routing path, and [docs/fetch-tier-runtime.md](docs/fetch-tier-runtime.md)
  for how outbound fetches to library sources are guarded.
- **`library_ingest`**, when Supabase credentials are set, writes chunked
  and embedded text to the operator's own Supabase project. That data goes
  nowhere else.

## What the project stores

Nothing. The Alexandria project does not operate a hosted service, collect
analytics, or retain any data itself. Whatever the operator's own `data/`
directory holds (a local SQLite state file, a per-process read cache) stays
on the machine running the server, and is deleted like any other local
file.

## Questions

Report a privacy or security concern the same way as a vulnerability: see
[SECURITY.md](SECURITY.md).
