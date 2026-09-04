// Wikidata: entity search only (wbsearchentities). Entities are structured
// data (claims/statements), not prose, so there is no meaningful "full
// text" to ingest - supportsIngest: false and read() is a metadata-only
// stub pointing at the entity page, the same convention as digitalnz.ts.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON } from '../utils/http.ts';
import { contactUserAgent } from '../utils/userAgent.ts';
import { register } from './registry.ts';

const API = 'https://www.wikidata.org/w/api.php';

function headers(): Record<string, string> {
  // Final wave (F1): the version comes from package.json via
  // utils/userAgent.ts, not a hardcoded `alexandria-mcp/10` frozen at
  // whatever major this repo was on when this line was written.
  return { 'User-Agent': contactUserAgent() };
}

interface WikidataEntity {
  id: string;
  label?: string;
  description?: string;
}
interface WikidataSearchResponse {
  search: WikidataEntity[];
}

export function normalizeWikidataEntity(entity: WikidataEntity): LibraryResult {
  return {
    id: entity.id,
    source: 'wikidata',
    title: entity.label || entity.id,
    authors: [],
    hasFullText: false,
    subjects: entity.description ? [entity.description] : undefined,
    previewUrl: `https://www.wikidata.org/wiki/${entity.id}`,
    description: entity.description,
  };
}

export async function wikidataSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language: 'en',
    limit: String(limit),
    format: 'json',
  });
  const data = await fetchJSON<WikidataSearchResponse>(`${API}?${params}`, { headers: headers() });
  return (data.search ?? []).map(normalizeWikidataEntity);
}

register('wikidata', {
  description:
    'Wikidata: entity search (wbsearchentities) across 100M+ structured knowledge-base items. Entity search only, no full-text read - use library_read for the entity page URL. Works keyless; set CONTACT_EMAIL for a compliant contact User-Agent.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'web',
  freshness: 'daily',
  homepage: 'https://www.wikidata.org',
  verifiedAt: '2026-09-03',
  optionalEnv: ['CONTACT_EMAIL'],
  search: wikidataSearch,
  async read(id): Promise<ReadResult> {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: `https://www.wikidata.org/wiki/${encodeURIComponent(id)}`,
      note: "Wikidata is entity search only; visit externalUrl for the entity's claims and statements.",
    };
  },
});
