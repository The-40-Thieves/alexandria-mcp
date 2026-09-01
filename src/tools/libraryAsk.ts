/**
 * Natural language library search router.
 * Uses gpt-4o-mini to parse intent, select relevant sources,
 * and generate optimized per-source queries. Then searches in parallel.
 */

import OpenAI from 'openai';
import { getAdapter, listSources } from '../sources/registry.js';
import type { LibraryResult, LibrarySource } from '../types.js';

interface RouteItem {
  source: string;
  query: string;
  reason: string;
}

interface RoutingDecision {
  intent: string;
  routes: RouteItem[];
}

export interface AskResult {
  query: string;
  intent: string;
  sources_searched: string[];
  total_results: number;
  results: LibraryResult[];
  routing: RouteItem[];
  errors: Array<{ source: string; error: string }>;
}

const SYSTEM_PROMPT = `You are a library search router with access to 60 specialized sources.
Given a natural language query, select the most relevant sources and generate an optimized search string for each.

Return JSON with this exact structure:
{
  "intent": "one sentence describing what the user wants",
  "routes": [
    { "source": "exact_source_name", "query": "optimized search string", "reason": "brief reason" }
  ]
}

Source category guide:
- Academic papers/preprints: arxiv, semanticscholar, openalex, core, europmc, plos, biorxiv, zenodo, osf
- Books/literature: gutenberg, openlibrary, archive, googlebooks, standardebooks, feedbooks
- Historical/cultural: loc, nara, chroniclingamerica, europeana, hathitrust, smithsonian, gallica, dpla, trove, wdl
- Legal/government: courtlistener, govinfo, legislation, legislationscot, nbnorway
- Classical/religious texts: perseus, sacredtexts, ctext, internetclassics, ccel
- Astronomy/physics: nasaads, nasa, arxiv
- Biomedical: europmc, plos, biorxiv, nih
- Education: eric
- Early modern English: earlyprint
- Islamic texts: openiti
- Software documentation: codewiki
- Video/lecture transcripts: youtube
- University repositories: harvardlib, apollo, ora
- Energy/STEM government: osti, nsf
- Open access journals: doaj, springer, doab

Rules:
- source must EXACTLY match one of the available source names
- Generate short, precise queries optimized for each source's search system
- Prioritize open access sources when query is about academic research
- For codewiki, the query should be an owner/repo like "tensorflow/tensorflow" or a project name
- For youtube, the query should be phrased like a natural YouTube search (video title keywords, not a research query)`;

async function routeQuery(query: string, maxSources: number): Promise<RoutingDecision> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for library_ask');

  const client = new OpenAI({ apiKey });
  const sources = listSources();
  // Include name + first sentence of description to keep the prompt compact
  const sourceList = sources
    .map(
      (s) =>
        `${s.name}: ${s.description.split('—')[1]?.split('.')[0]?.trim() ?? s.description.split('.')[0]}`,
    )
    .join('\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}\n\nSelect at most ${maxSources} sources ordered by relevance.\n\nAvailable sources:\n${sourceList}`,
      },
      { role: 'user', content: query },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty routing response from OpenAI');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON from router: ${content.substring(0, 200)}`);
  }

  const decision = parsed as RoutingDecision;
  if (!decision.intent || !Array.isArray(decision.routes)) {
    throw new Error('Router returned unexpected shape');
  }
  return decision;
}

export async function libraryAsk(
  query: string,
  maxSources = 5,
  resultsPerSource = 5,
): Promise<AskResult> {
  const routing = await routeQuery(query, maxSources);

  // Validate — only keep routes whose source names actually exist
  const validNames = new Set(listSources().map((s) => s.name));
  const validRoutes = routing.routes.filter(
    (r) => typeof r.source === 'string' && validNames.has(r.source),
  );

  // Parallel search across all selected sources
  const searches = validRoutes.map(async (route) => {
    try {
      const adapter = getAdapter(route.source as LibrarySource);
      const results = await adapter.search(route.query, resultsPerSource);
      return { source: route.source, results, error: null };
    } catch (err) {
      return {
        source: route.source,
        results: [] as LibraryResult[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const settled = await Promise.allSettled(searches);
  const allResults: LibraryResult[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  for (const r of settled) {
    if (r.status === 'fulfilled') {
      allResults.push(...r.value.results);
      if (r.value.error) {
        errors.push({ source: r.value.source, error: r.value.error });
      }
    } else {
      errors.push({
        source: 'unknown',
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // Deduplicate: normalize title to a short key
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    const key = r.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 60);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    query,
    intent: routing.intent,
    sources_searched: validRoutes.map((r) => r.source),
    total_results: deduped.length,
    results: deduped,
    routing: validRoutes,
    errors,
  };
}
