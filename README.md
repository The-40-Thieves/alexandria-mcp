# Alexandria MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

**61-source digital library MCP server.** Natural language search across academic papers, public domain books, legal records, government archives, institutional repositories, and software documentation. Plug into Claude Desktop or any MCP-compatible client in minutes.

---

## What it does

Alexandria exposes 7 MCP tools that let any LLM search, read, chunk, embed, and ingest content from 61 public digital libraries — without writing a single line of integration code.

```
library_ask("recent papers on diffusion models for music generation")
# → routes to arxiv, semanticscholar, openalex, biorxiv, core
# → searches in parallel, deduplicates, returns unified results

library_read("2401.12345", "arxiv")
# → returns full paper text, chunked to 200k chars

library_ingest("2401.12345", "arxiv")
# → chunks → embeds (OpenAI) → stores in Supabase pgvector
```

---

## Prerequisites

- **Node.js ≥ 22** — `node --version`
- **npm ≥ 10** — `npm --version`
- **Claude Desktop** (or any MCP client)
- **OpenAI API key** — required only for `library_ask` and `library_ingest`
- **Supabase project** — required only for `library_ingest` (vector storage)

Most sources work with zero configuration. See [API Keys](#api-keys) for optional keys that unlock additional sources.

---

## Installation

### 1. Clone and build

```bash
git clone https://github.com/suavecito585/alexandria-mcp.git
cd alexandria-mcp
npm install
npm run build
```

Confirm the build succeeded:

```bash
node dist/index.js --help 2>&1 || echo "Build OK"
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum:

```env
# Required only for library_ask and library_ingest:
OPENAI_API_KEY=sk-...

# Required only for library_ingest:
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Optional but recommended — used as a courtesy param in API calls:
CONTACT_EMAIL=your-email@example.com
```

All other variables are optional. Sources without API keys work immediately.

### 3. Add to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "node",
      "args": ["/absolute/path/to/alexandria-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "OPENAI_API_KEY": "sk-...",
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ...",
        "CONTACT_EMAIL": "your-email@example.com"
      }
    }
  }
}
```

Replace `/absolute/path/to/alexandria-mcp` with the actual path where you cloned the repo.

**Restart Claude Desktop.** Alexandria will appear as an available MCP server.

### 4. Verify

In Claude Desktop, ask:

```
Use library_list_sources to show me all available sources.
```

You should see all 61 sources listed with their descriptions.

---

## Optional: Supabase setup for library_ingest

`library_ingest` stores chunked, embedded text in a Supabase pgvector database for later retrieval. Skip this if you only need search and read.

**1. Create a Supabase project** at [supabase.com](https://supabase.com).

**2. Run this SQL** in the Supabase SQL editor:

```sql
-- Enable pgvector
create extension if not exists vector;

-- Source deduplication table
create table if not exists source_docs (
  id text primary key,
  mcp_name text not null,
  ingested_at timestamptz default now()
);

-- Chunk storage table
create table if not exists knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  mcp_name text not null,
  source_id text not null,
  title text,
  authors text[],
  year int,
  language text,
  section text,
  chunk_index int,
  total_chunks int,
  quality_score float,
  content text not null,
  embedding vector(1536),
  created_at timestamptz default now()
);

-- Vector similarity index
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

**3. Add your Supabase URL and service role key** to the env block in your Claude Desktop config.

---

## Tools reference

| Tool | Description |
|---|---|
| `library_ask` | **Natural language search.** Describe what you want in plain English — an LLM routes the query to the best sources and searches in parallel. Returns unified, deduplicated results. |
| `library_search` | Search a specific named source with a keyword query. Use when you know which source to target. |
| `library_read` | Fetch full text or metadata for a specific item by ID. Returns up to 200,000 characters. |
| `library_index` | Dry-run chunking preview. See how text would be chunked and scored without writing to the database. |
| `library_ingest` | Chunk, embed, and store text in Supabase pgvector. Idempotent — safe to re-run. |
| `library_recommend` | Get papers similar to a given Semantic Scholar paper ID. Returns up to 500 recommendations. |
| `library_list_sources` | List all 61 sources with descriptions and capabilities. |

### library_ask examples

```
library_ask("ancient Greek texts about rhetoric and persuasion")
library_ask("US military records from World War II", max_sources=8)
library_ask("open access books on cognitive science", results_per_source=3)
library_ask("source code documentation for the React framework")
library_ask("recent papers on CRISPR gene editing applications")
```

---

## Sources (61)

### No API key required (works immediately)

| Source | Coverage |
|---|---|
| `gutenberg` | 76k+ public domain books |
| `archive` | 41M+ texts, scanned books, films |
| `wikisource` | Multilingual source texts |
| `standardebooks` | ~700 curated, beautifully formatted ebooks |
| `perseus` | Classical Greek and Latin texts |
| `ctext` | Classical Chinese texts |
| `internetclassics` | 440+ classical translations (MIT) |
| `sacredtexts` | Quran, Vedanta, Buddhism, Hermeticism, Taoism |
| `marxists` | Socialist, anarchist, and critical theory |
| `ccel` | Patristics and Reformation theology |
| `projectruneberg` | Scandinavian literature |
| `cervantes` | Borges, Lorca, Neruda, Cervantes, Rulfo |
| `gallica` | BnF 5M+ digitized French documents |
| `chroniclingamerica` | US newspapers 1770–1963 with full OCR |
| `arxiv` | 2M+ preprints — physics, math, CS, biology, economics |
| `europmc` | 43M+ biomedical literature; full XML for PMC OA papers |
| `nasa` | NASA technical reports — space, aviation, engineering |
| `osti` | DOE energy, nuclear, and physics research |
| `eric` | 2M+ US education research documents |
| `nsf` | NSF grant abstracts across all disciplines |
| `biorxiv` | Biology and health sciences preprints |
| `plos` | All PLOS journals — 100% open access |
| `openalex` | 200M+ scholarly works — replaces Scopus/Web of Science |
| `crossref` | 130M+ DOI metadata with PDF links |
| `doaj` | 12M+ peer-reviewed OA journal articles |
| `nara` | 32M US National Archives historical records |
| `govinfo` | US Congressional Record, Federal Register |
| `legislation` | UK statutes with historical versions |
| `legislationscot` | Scottish Parliament Acts and Instruments |
| `nbnorway` | Norwegian National Library with OCR text |
| `osf` | PsyArXiv, SocArXiv, EarthArXiv, engrXiv preprints |
| `nih` | NIH Reporter funded research |
| `earlyprint` | 60k+ Early Modern English texts (EEBO/ECCO/Evans) |
| `harvardlib` | 20M+ records from Harvard Libraries |
| `apollo` | Cambridge University institutional repository |
| `ora` | Oxford University Research Archive + Oxford Text Archive |
| `codewiki` | Google Code Wiki — AI-generated docs for any GitHub repo |
| `openlibrary` | Internet Archive book metadata (38M records) |
| `hathitrust` | 18M digitized volumes from research libraries |
| `dpla` | Digital Public Library of America |
| `loc` | Library of Congress digital collections |
| `europeana` | European cultural heritage (50M+ items) |
| `ndl` | National Diet Library of Japan |
| `doab` | Peer-reviewed open access books |
| `oapen` | Open Access Publishing in European Networks |
| `feedbooks` | Public domain and CC-licensed ebooks |
| `wdl` | World Digital Library primary sources |
| `datagov` | US government open datasets |

### Requires free API key

| Source | Key needed | Coverage |
|---|---|---|
| `core` | `CORE_API_KEY` | 57M+ OA papers with full text |
| `courtlistener` | `COURTLISTENER_API_KEY` | US federal and state case law (125 req/day free) |
| `googlebooks` | `GOOGLE_BOOKS_API_KEY` | 40M+ books; full text for public domain |
| `bhl` | `BHL_API_KEY` | Natural history and biodiversity literature |
| `digitalnz` | `DIGITALNZ_API_KEY` | New Zealand digital collections |
| `trove` | `TROVE_API_KEY` | National Library of Australia |
| `europeana` | `EUROPEANA_API_KEY` | European heritage (higher quota) |
| `zenodo` | `ZENODO_API_KEY` | CERN open research repository |
| `semanticscholar` | `SEMANTIC_SCHOLAR_API_KEY` | 200M+ papers with AI recommendations |
| `nasaads` | `NASA_ADS_API_KEY` | NASA Astrophysics Data System |
| `smithsonian` | `SMITHSONIAN_API_KEY` | 14M Smithsonian Institution records |
| `springer` | `SPRINGER_OA_API_KEY` + `SPRINGER_META_API_KEY` | 16M+ Springer Nature articles |
| `dpla` | `DPLA_API_KEY` | Higher rate limits |
| `openiti` | `GITHUB_TOKEN` | 10k+ Islamicate texts (GitHub code search) |
| `base` | IP whitelist required | 400M+ records from 11k+ providers |

---

## API Keys

All keys are free. Get them from:

| Key | Register at |
|---|---|
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) |
| `CORE_API_KEY` | [core.ac.uk/services/api](https://core.ac.uk/services/api) |
| `COURTLISTENER_API_KEY` | [courtlistener.com/sign-in](https://www.courtlistener.com/sign-in/) |
| `GOVINFO_API_KEY` | [api.govinfo.gov/docs](https://api.govinfo.gov/docs/) |
| `ZENODO_API_KEY` | [zenodo.org/account/settings/applications](https://zenodo.org/account/settings/applications/) |
| `GOOGLE_BOOKS_API_KEY` | [console.cloud.google.com](https://console.cloud.google.com/) |
| `BHL_API_KEY` | [biodiversitylibrary.org/getapikey.aspx](https://www.biodiversitylibrary.org/getapikey.aspx) |
| `DIGITALNZ_API_KEY` | [digitalnz.org/developers](https://digitalnz.org/developers) |
| `DPLA_API_KEY` | [pro.dp.la/developers/api-codex](https://pro.dp.la/developers/api-codex) |
| `EUROPEANA_API_KEY` | [apis.europeana.eu](https://apis.europeana.eu/) |
| `TROVE_API_KEY` | [trove.nla.gov.au/about/create-something/using-api](https://trove.nla.gov.au/about/create-something/using-api) |
| `SEMANTIC_SCHOLAR_API_KEY` | [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) |
| `NASA_ADS_API_KEY` | [ui.adsabs.harvard.edu/user/settings/token](https://ui.adsabs.harvard.edu/user/settings/token) |
| `SMITHSONIAN_API_KEY` | [api.data.gov/signup](https://api.data.gov/signup/) |
| `SPRINGER_OA_API_KEY` / `SPRINGER_META_API_KEY` | [dev.springernature.com](https://dev.springernature.com/) |
| `GITHUB_TOKEN` | [github.com/settings/tokens](https://github.com/settings/tokens) |
| `BASE_API_KEY` | [base-search.net/about/en/contact.php](https://www.base-search.net/about/en/contact.php) — requires IP whitelist approval |

---

## Self-hosting on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com)

1. Fork this repo
2. Create a new Railway project and connect the fork
3. Set `TRANSPORT=http` in Railway environment variables
4. Add your API keys as Railway environment variables
5. Deploy — Railway auto-builds with `npm run build` and starts with `node dist/index.js`

The server exposes `POST /mcp`, `GET /mcp`, `DELETE /mcp` and a health endpoint at `GET /health`.

---

## Adding new sources

Each source is a self-contained adapter in `src/sources/`. To add a new source:

1. Create `src/sources/mysource.ts`
2. Implement `search(query, limit)` and `read(id)` functions
3. Call `register('mysource', { ... })` at module level
4. Add `'mysource'` to the `LibrarySource` union in `src/types.ts`
5. Add `import './sources/mysource.js'` and `'mysource'` to `ALL_SOURCES` in `src/index.ts`
6. Run `npm run build`

See any existing adapter in `src/sources/` for the pattern.

---

## Architecture

```
src/
├── index.ts              # MCP server, tool registration
├── types.ts              # LibrarySource union, shared interfaces
├── sources/              # 61 source adapters + registry
│   ├── registry.ts       # Adapter registration and lookup
│   └── *.ts              # One file per source
├── pipeline/             # Chunking, embedding, ingestion
│   ├── index.ts
│   ├── quality.ts        # OCR quality scoring
│   └── providers/        # OpenAI + Supabase implementations
└── tools/
    └── libraryAsk.ts     # Natural language routing (gpt-4o-mini)
```

**library_ask routing:** A single `gpt-4o-mini` call (~700 tokens, fraction of a cent) selects the best sources and generates optimized search queries for each. All searches run in parallel via `Promise.allSettled` — no single source failure kills the batch.

---

## License

MIT — see [LICENSE](LICENSE)
