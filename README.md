# Alexandria

A Model Context Protocol (MCP) server for querying, reading, and ingesting texts from 61 public digital libraries. Works with any MCP-compatible client (Claude Desktop, Cursor, VS Code Copilot, etc.).

## Tools

| Tool | Description |
|---|---|
| `library_list_sources` | List all 61 sources with descriptions and full-text capabilities |
| `library_ask(query, max_sources?, results_per_source?)` | **Natural language search** — routes your query to the best sources, searches in parallel, returns unified deduplicated results |
| `library_search(query, source, limit?)` | Search a specific source by title, author, or keywords |
| `library_read(id, source)` | Fetch full text or metadata for an item (200k char limit) |
| `library_index(id, source)` | Dry run: chunk and score text quality without writing anything |
| `library_ingest(id, source)` | Chunk → embed → store in your vector database. Idempotent. |
| `library_recommend(id, limit?)` | Get similar papers via Semantic Scholar's recommendation engine (up to 500) |

`library_ask` is the primary entry point. `library_search` is for targeted queries against a known source. `library_index` / `library_ingest` are for building a vector knowledge base from retrieved texts.

## Sources (61)

### Public Domain Literature (29)

| Source | Coverage | Full Text |
|---|---|---|
| `gutenberg` | 76k+ public domain books | Yes |
| `openlibrary` | 30M+ records | Metadata only |
| `archive` | 41M+ texts, newspapers, scanned books | Yes |
| `sacredtexts` | Curated registry: Quran, Sufi corpus, Vedanta, Buddhism, Taoism, Hermeticism, Christian mysticism | Yes (scraped) |
| `wikisource` | Free-content library: historical documents, literary works | Yes |
| `standardebooks` | Carefully formatted, public domain ebooks | Yes |
| `perseus` | Classical Greek and Latin texts with translations | Yes |
| `ctext` | Chinese Text Project — pre-modern Chinese literature | Yes |
| `gallica` | Bibliothèque nationale de France — French heritage texts | Yes |
| `loc` | Library of Congress — US historical collections | Metadata only |
| `hathitrust` | 17M+ volumes from research libraries | Metadata only |
| `dpla` | Digital Public Library of America — US cultural heritage | Metadata only |
| `ndl` | National Diet Library Japan | Metadata only |
| `europeana` | European cultural heritage — 50M+ objects | Metadata only |
| `trove` | National Library of Australia — newspapers, books, images | Yes |
| `bhl` | Biodiversity Heritage Library — natural history literature | Yes |
| `digitalnz` | National Library of New Zealand | Metadata only |
| `internetclassics` | Internet Classics Archive — 441 classical works | Yes |
| `marxists` | Marxists Internet Archive — political theory, philosophy | Yes |
| `projectruneberg` | Nordic literature and history | Yes |
| `cervantes` | Biblioteca Virtual Miguel de Cervantes — Spanish literature | Yes |
| `doab` | Directory of Open Access Books — 70k+ peer-reviewed OA books | Metadata only |
| `oapen` | Open Access Publishing in European Networks — humanities & social sciences | Yes |
| `googlebooks` | Google Books — metadata and preview snippets | Metadata only |
| `chroniclingamerica` | Library of Congress — US historic newspapers 1770–1963 | Yes |
| `ccel` | Christian Classics Ethereal Library | Yes |
| `feedbooks` | Public domain and self-published ebooks | Yes |
| `wdl` | World Digital Library — international manuscripts and maps | Metadata only |
| `datagov` | Data.gov — US government open data catalog | Metadata only |

### Academic & Science (11)

| Source | Coverage | Full Text |
|---|---|---|
| `arxiv` | 2M+ preprints: physics, math, CS, biology, economics | Yes |
| `core` | 57M+ open access research papers across all disciplines | Yes |
| `europmc` | Europe PubMed Central — life sciences literature | Yes |
| `nasa` | NASA Technical Reports Server | Yes |
| `osti` | DOE Office of Scientific and Technical Information | Yes |
| `eric` | Education Resources Information Center | Yes |
| `nsf` | NSF Award Search — funded research abstracts | Yes |
| `courtlistener` | US federal and state court opinions (Free Law Project). 125 req/day. | Yes |
| `biorxiv` | bioRxiv preprints — biology | Yes |
| `zenodo` | CERN open repository — papers, datasets, software. 2M+ records. | Yes |
| `semanticscholar` | Semantic Scholar — 200M+ papers with AI-powered metadata | Yes |

### Government, Law & International (5)

| Source | Coverage | Full Text |
|---|---|---|
| `govinfo` | US Government Publishing Office — laws, regulations, congressional records | Yes |
| `nih` | NIH Office of Portfolio Analysis | Yes |
| `nbnorway` | National Library of Norway | Metadata only |
| `legislation` | legislation.gov.uk — UK Acts and Statutory Instruments | Yes |
| `osf` | Open Science Framework — preprints and research data | Yes |

### Specialized Corpora (3)

| Source | Coverage | Full Text |
|---|---|---|
| `earlyprint` | Early English print 1473–1700 | Yes |
| `openiti` | OpenITI — Arabic/Persian Islamic texts (GitHub-based) | Yes |
| `legislationscot` | Scottish legislation | Yes |

### Research Aggregators (8)

| Source | Coverage | Full Text |
|---|---|---|
| `openalex` | OpenAlex — 240M+ scholarly works, open catalog | Metadata only |
| `plos` | PLOS journals — open access science | Yes |
| `crossref` | Crossref — 150M+ DOI metadata records | Metadata only |
| `nasaads` | NASA Astrophysics Data System | Yes |
| `smithsonian` | Smithsonian Institution — collections and research | Metadata only |
| `doaj` | Directory of Open Access Journals — 20k+ journals | Metadata only |
| `nara` | National Archives — US federal records | Metadata only |
| `springer` | SpringerNature — OA and metadata | Metadata only |

### Institutional Repositories (4)

| Source | Coverage | Full Text |
|---|---|---|
| `harvardlib` | Harvard Library Digital Collections | Metadata only |
| `apollo` | Cambridge University repository | Yes |
| `ora` | Oxford Research Archive | Yes |
| `base` | Bielefeld Academic Search Engine — 300M+ documents (pending IP whitelist) | Metadata only |

### Software Documentation (1)

| Source | Coverage | Full Text |
|---|---|---|
| `codewiki` | Google Code Wiki — open source project documentation | Yes |

## Credentials

Most tools query external library APIs directly and need no credentials at all. The two optional dependencies are scoped to specific tools:

### OpenAI — optional ([platform.openai.com](https://platform.openai.com/api-keys))

Required by two tools only:

- **`library_ask`** — uses `gpt-4o-mini` to route your natural language query to the right sources and generate optimized per-source search terms. Without this key, use `library_search` to query sources directly.
- **`library_ingest`** — uses `text-embedding-3-small` to embed chunked text before writing to the vector store.

`library_list_sources`, `library_search`, `library_read`, `library_index`, and `library_recommend` all work without an OpenAI key.

### Supabase — optional ([supabase.com](https://supabase.com/dashboard))

Required by one tool only:

- **`library_ingest`** — writes chunked, embedded text into a pgvector table for semantic search. Without this, retrieved texts stay in-context and are not persisted anywhere.

Everything else — searching, reading, browsing, getting recommendations — queries external sources in real time and needs no database.

### Source-specific keys

Some sources require their own API key. These are free registrations. Sources without a key listed here work without any credentials.

| Env Var | Source(s) | Get It |
|---|---|---|
| `CORE_API_KEY` | `core` | [core.ac.uk/services/api](https://core.ac.uk/services/api) |
| `COURTLISTENER_API_KEY` | `courtlistener` | [courtlistener.com/profile/tokens](https://www.courtlistener.com/profile/tokens/) |
| `GOVINFO_API_KEY` | `govinfo`, `smithsonian` | [api.data.gov/signup](https://api.data.gov/signup/) — one key covers both |
| `GOOGLE_BOOKS_API_KEY` | `googlebooks` | [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Books API |
| `BHL_API_KEY` | `bhl` | [biodiversitylibrary.org/getapikey](https://www.biodiversitylibrary.org/getapikey.aspx) |
| `DIGITALNZ_API_KEY` | `digitalnz` | [digitalnz.org/developers](https://digitalnz.org/developers) |
| `DPLA_API_KEY` | `dpla` | [pro.dp.la/developers/api-codex](https://pro.dp.la/developers/api-codex) |
| `EUROPEANA_API_KEY` | `europeana` | [apis.europeana.eu](https://apis.europeana.eu/en/) — test key immediate, personal ~1 week |
| `GITHUB_TOKEN` | `openiti` | [github.com/settings/tokens](https://github.com/settings/tokens) — public repo read scope, optional but prevents rate limiting |
| `NASA_ADS_API_KEY` | `nasaads` | [ui.adsabs.harvard.edu/user/settings/token](https://ui.adsabs.harvard.edu/user/settings/token) |
| `SPRINGER_OA_API_KEY` + `SPRINGER_META_API_KEY` | `springer` | [dev.springernature.com](https://dev.springernature.com/) — same registration, two keys |
| `ZENODO_API_KEY` | `zenodo` | [zenodo.org/account/settings/applications/tokens/new](https://zenodo.org/account/settings/applications/tokens/new/) — optional, increases rate limits |
| `SEMANTIC_SCHOLAR_API_KEY` | `semanticscholar` | [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) — optional, increases rate limits |
| `TROVE_API_KEY` | `trove` | [trove.nla.gov.au/about/create-something/using-api](https://trove.nla.gov.au/about/create-something/using-api) — ~1 week approval |
| `BASE_API_KEY` | `base` | [base-search.net/about/en/contact](https://www.base-search.net/about/en/contact.php) — requires IP whitelist |

## Setup

```bash
git clone https://github.com/suavecito585/alexandria-mcp
cd alexandria-mcp
npm install
npm run build
```

Copy `.env.example` to `.env`. Minimum configuration to run with no credentials (search and read only):

```env
TRANSPORT=stdio
```

To enable `library_ask`:

```env
TRANSPORT=stdio
OPENAI_API_KEY=sk-...
```

To enable `library_ingest`:

```env
TRANSPORT=stdio
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

## Supabase Schema

Required only if using `library_ingest`:

```sql
create table if not exists knowledge_chunks (
  id bigserial primary key,
  content text not null,
  embedding vector(1536),
  mcp_name text,
  metadata jsonb,
  created_at timestamptz default now()
);

create table if not exists source_docs (
  id bigserial primary key,
  source_url text not null,
  mcp_name text not null,
  title text,
  source text,
  chunk_count int,
  indexed_at timestamptz,
  unique (source_url, mcp_name)
);

create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

## Claude Desktop (stdio)

Minimum config (search and read only):

```json
{
  "mcpServers": {
    "library": {
      "command": "node",
      "args": ["/path/to/alexandria-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

With `library_ask` and `library_ingest` enabled:

```json
{
  "mcpServers": {
    "library": {
      "command": "node",
      "args": ["/path/to/alexandria-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "OPENAI_API_KEY": "sk-...",
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ..."
      }
    }
  }
}
```

## Railway (HTTP)

Set env vars in the Railway dashboard and deploy:

```bash
railway up
```

Register in Claude Desktop:

```json
{
  "mcpServers": {
    "library": {
      "url": "https://your-service.up.railway.app/mcp"
    }
  }
}
```

Health check: `GET /health` returns `{ status: "ok", sources: 61 }`.

## Adding Custom Providers

The pipeline is provider-agnostic. To add a new embedding model or vector store:

1. Implement `EmbeddingProvider` or `VectorStoreProvider` from `src/types.ts`
2. Add your implementation to `src/pipeline/providers/`
3. Register it in `src/pipeline/providers/index.ts`
4. Set `EMBEDDING_PROVIDER` or `VECTOR_STORE_PROVIDER` in your env

```typescript
// Example: Ollama embedding provider
import type { EmbeddingProvider } from '../../types.js';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 768;

  async embed(texts: string[]): Promise<number[][]> {
    // your implementation
  }
}
```
