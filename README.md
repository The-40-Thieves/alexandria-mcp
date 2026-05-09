# Alexandria MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

Alexandria is an MCP server that gives Claude (or any MCP-compatible AI) access to 61 public digital libraries — academic papers, classic books, legal records, historical archives, government databases, and software documentation — through a single unified interface.

You can ask it things like:

> *"Find me recent papers on attention mechanisms in transformer models"*
> *"Search ancient Greek texts on the nature of virtue"*
> *"Look up US military records from World War II"*
> *"Get the documentation for the fastify web framework"*

And it automatically figures out which libraries to search, runs the queries in parallel, and returns unified results.

---

## Before you start: what do you actually need?

Here's the honest version:

**46 sources work with zero API keys.** If you just want to search arXiv, Project Gutenberg, Oxford's repository, Cambridge's repository, Europe PMC, PLOS, OpenAlex, the US National Archives, UK legislation, and dozens of others — you can do that right now without signing up for anything.

**The only key that meaningfully upgrades the experience is your OpenAI API key**, which powers the natural language search (`library_ask`). Without it, you can still search specific sources directly — you just have to name the source yourself.

**Everything else is optional.** Each additional key unlocks a specific source. Pick up the ones relevant to what you're researching. Skip the rest.

---

## Step 1: Make sure you have Node.js 22 or later

Open your terminal and check:

```bash
node --version
```

If it shows `v22.x.x` or higher, you're good. If not, download the latest LTS from [nodejs.org](https://nodejs.org).

---

## Step 2: Clone and build Alexandria

```bash
git clone https://github.com/suavecito585/alexandria-mcp.git
cd alexandria-mcp
npm install
npm run build
```

This takes about 30 seconds. When it's done, you'll see a `dist/` folder appear. That's the compiled server.

Note the full path to this folder — you'll need it in the next step. On Mac/Linux you can run `pwd` to print it. On Windows, `cd` by itself prints the current path.

---

## Step 3: Add Alexandria to Claude Desktop

Find your Claude Desktop config file:
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Open it in any text editor. If it already has other MCP servers configured, add Alexandria alongside them. If it's empty or new, use this as your starting point:

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "node",
      "args": ["/full/path/to/alexandria-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

Replace `/full/path/to/alexandria-mcp` with the actual path from Step 2.

**Restart Claude Desktop** after saving the file.

To verify it worked, ask Claude: *"Use library_list_sources to show all available sources."* You should see all 61 sources listed.

---

## Step 4: Add your OpenAI key (recommended)

Without this, you have to name the source every time you search — e.g., *"search arxiv for transformer papers"*. With it, you can just say *"find me papers on transformer models"* and Alexandria figures out which sources to check.

Get your key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). It costs a fraction of a cent per search (the routing call uses `gpt-4o-mini`, ~$0.0002 per query).

Add it to the `env` block in your config:

```json
"env": {
  "TRANSPORT": "stdio",
  "OPENAI_API_KEY": "sk-..."
}
```

Restart Claude Desktop again.

---

## Step 5: Optional — set up vector storage (for saving ingested text)

`library_ingest` lets you chunk, embed, and store full-text content in a vector database for later retrieval. This is only useful if you're building a research RAG pipeline. If you just want to search and read, skip this entirely.

If you do want it:

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to the SQL editor and run this:

```sql
create extension if not exists vector;

create table if not exists source_docs (
  id text primary key,
  mcp_name text not null,
  ingested_at timestamptz default now()
);

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

create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

3. Add to your config env block:

```json
"SUPABASE_URL": "https://your-project.supabase.co",
"SUPABASE_SERVICE_ROLE_KEY": "eyJ..."
```

You'll find both values in your Supabase project under **Settings → API**.

---

## Step 6: Pick up the API keys you actually want

Here's every optional key, grouped by how much effort they take and what you get.

### Instant (takes 2 minutes, form-fill and you're done)

These are all free. Registration is immediate or near-immediate.

| What you get | Where to register | Key name in config |
|---|---|---|
| **CORE** — 57M+ full-text OA papers, the largest collection available | [core.ac.uk/services/api](https://core.ac.uk/services/api) | `CORE_API_KEY` |
| **Semantic Scholar** — 200M+ papers with AI-powered recommendations and citation graphs | [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) | `SEMANTIC_SCHOLAR_API_KEY` |
| **NASA ADS** — the premier portal for astronomy, astrophysics, and physics literature | [ui.adsabs.harvard.edu/user/settings/token](https://ui.adsabs.harvard.edu/user/settings/token) | `NASA_ADS_API_KEY` |
| **Smithsonian** — 14M records across all Smithsonian museums (same key works for GovInfo) | [api.data.gov/signup](https://api.data.gov/signup/) | `SMITHSONIAN_API_KEY` |
| **Springer Nature** — 16M+ articles across Springer and BioMed Central | [dev.springernature.com](https://dev.springernature.com/) | `SPRINGER_OA_API_KEY` and `SPRINGER_META_API_KEY` |
| **Zenodo** — CERN's open research repository, higher rate limits | [zenodo.org/account/settings/applications](https://zenodo.org/account/settings/applications/) | `ZENODO_API_KEY` |
| **BHL** — Biodiversity Heritage Library, centuries of natural history literature | [biodiversitylibrary.org/getapikey.aspx](https://www.biodiversitylibrary.org/getapikey.aspx) | `BHL_API_KEY` |
| **DigitalNZ** — New Zealand's national digital collections | [digitalnz.org/developers](https://digitalnz.org/developers) | `DIGITALNZ_API_KEY` |
| **DPLA** — Digital Public Library of America | [pro.dp.la/developers/api-codex](https://pro.dp.la/developers/api-codex) | `DPLA_API_KEY` |
| **Europeana** — 50M+ items from European museums and archives | [apis.europeana.eu](https://apis.europeana.eu/) | `EUROPEANA_API_KEY` |
| **GitHub Token** — needed for OpenITI (10k+ Islamicate texts). No special scopes required. | [github.com/settings/tokens](https://github.com/settings/tokens) | `GITHUB_TOKEN` |

### Takes a few days (email approval or manual review)

| What you get | Where to register | Key name in config |
|---|---|---|
| **CourtListener** — full-text US federal and state case law | [courtlistener.com/sign-in](https://www.courtlistener.com/sign-in/) | `COURTLISTENER_API_KEY` |
| **Trove** — National Library of Australia, digitized newspapers and books | [trove.nla.gov.au/about/create-something/using-api](https://trove.nla.gov.au/about/create-something/using-api) | `TROVE_API_KEY` |

### Special case: BASE (IP whitelist required)

BASE gives you 400M+ records from 11,000+ academic providers — the largest index we support. It's free but requires emailing their team to whitelist your IP address. Usually takes 2–3 business days.

1. Go to [base-search.net/about/en/contact.php](https://www.base-search.net/about/en/contact.php)
2. Select **"Access BASE's HTTP API"** from the subject dropdown
3. Include your IP address (find it at [whatismyip.com](https://whatismyip.com)) and a brief description of your use case (e.g., "non-commercial research aggregation")
4. Wait for their reply — they'll whitelist your IP

Once approved, add to your config: `"BASE_API_KEY": ""` (the value may be empty if they use IP-only auth, or they'll give you a token).

### Console setup (slightly more involved)

| What you get | Notes | Key name in config |
|---|---|---|
| **Google Books** — 40M+ books, full text for public domain titles | Create a project in [Google Cloud Console](https://console.cloud.google.com/), enable the Books API, create an API key | `GOOGLE_BOOKS_API_KEY` |
| **GovInfo** — US Congressional Record, Federal Register | Register at [api.govinfo.gov/docs](https://api.govinfo.gov/docs/) — same key also works for Smithsonian | `GOVINFO_API_KEY` |

---

## Adding keys to your config

Every key goes in the `env` block. Your final config might look something like this (include only the keys you've actually gotten):

```json
{
  "mcpServers": {
    "alexandria": {
      "command": "node",
      "args": ["/full/path/to/alexandria-mcp/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "OPENAI_API_KEY": "sk-...",
        "CONTACT_EMAIL": "you@example.com",
        "CORE_API_KEY": "your-core-key",
        "SEMANTIC_SCHOLAR_API_KEY": "your-s2-key",
        "NASA_ADS_API_KEY": "your-ads-key",
        "SMITHSONIAN_API_KEY": "your-data-gov-key",
        "GOVINFO_API_KEY": "your-data-gov-key",
        "SPRINGER_OA_API_KEY": "your-springer-oa-key",
        "SPRINGER_META_API_KEY": "your-springer-meta-key",
        "ZENODO_API_KEY": "your-zenodo-key",
        "BHL_API_KEY": "your-bhl-key",
        "DPLA_API_KEY": "your-dpla-key",
        "EUROPEANA_API_KEY": "your-europeana-key",
        "DIGITALNZ_API_KEY": "your-digitalnz-key",
        "GITHUB_TOKEN": "ghp_...",
        "COURTLISTENER_API_KEY": "your-cl-key",
        "TROVE_API_KEY": "your-trove-key",
        "GOOGLE_BOOKS_API_KEY": "your-books-key",
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "eyJ..."
      }
    }
  }
}
```

**Remember to restart Claude Desktop every time you change the config.**

---

## What can I do now?

Here are some things to try once you're set up:

```
Use library_ask to find recent papers on CRISPR gene editing
```

```
Use library_search to search gutenberg for "Marcus Aurelius"
```

```
Use library_read to get the full text of arxiv paper 2401.12345
```

```
Use library_ask to find ancient Greek philosophical texts about justice
```

```
Use library_ask to find the Code Wiki documentation for the fastify/fastify GitHub repo
```

---

## Sources at a glance

**46 sources need no API key.** These work the moment you install:

arXiv, Europe PMC, NASA NTRS, OSTI, ERIC, NSF, NIH, bioRxiv, PLOS, OpenAlex, Crossref, DOAJ, NARA, GovInfo, UK Legislation, Scottish Legislation, Norwegian National Library, OSF (PsyArXiv/SocArXiv), EarlyPrint, Harvard LibraryCloud, Cambridge Apollo, Oxford ORA, Google Code Wiki, Gutenberg, Open Library, Standard Ebooks, Wikisource, Internet Classics Archive, Sacred Texts, Marxists Internet Archive, CCEL, Project Runeberg, Cervantes Virtual, Classical Chinese Texts, Gallica, HathiTrust, Library of Congress, DOAB, OAPEN, Feedbooks, World Digital Library, Data.gov, Chronicling America, NDL (Japan)

**15 sources need a free API key:**

CORE, Semantic Scholar, NASA ADS, Smithsonian, Springer Nature, Zenodo, BHL, DigitalNZ, DPLA, Europeana, GitHub (OpenITI), CourtListener, Trove, Google Books, BASE (IP whitelist)

---

## License

MIT — use it however you like.
