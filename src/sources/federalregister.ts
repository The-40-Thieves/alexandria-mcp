// Federal Register: the daily journal of the US federal government. No API
// key required. A custom register() rather than defineRest(): read() is
// metadata only until the fetchTier web-fetch tier lands in Stage 6 (the
// same TODO convention used by mdn.ts, nhk.ts and kinds/rss.ts), since a
// Federal Register document body is an HTML page, not a JSON API.
import type { LibraryResult, ReadResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const BASE = 'https://www.federalregister.gov/api/v1';

interface FederalRegisterDoc {
  document_number: string;
  title: string;
  publication_date?: string;
  html_url?: string;
  abstract?: string;
}

interface FederalRegisterSearchResponse {
  results?: FederalRegisterDoc[];
}

function yearOf(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : undefined;
}

export function normalizeFederalRegister(item: FederalRegisterDoc): LibraryResult {
  return {
    id: item.document_number,
    source: 'federalregister',
    title: item.title,
    authors: [],
    year: yearOf(item.publication_date),
    hasFullText: false,
    description: item.abstract,
    published: item.publication_date,
    url: item.html_url,
  };
}

export async function federalRegisterSearch(
  query: string,
  limit: number,
): Promise<LibraryResult[]> {
  const data = await fetchJSON<FederalRegisterSearchResponse>(
    `${BASE}/documents.json?per_page=${limit}&conditions%5Bterm%5D=${encodeURIComponent(query)}`,
  );
  return (data.results ?? []).map(normalizeFederalRegister);
}

// Federal Register full text does NOT go through the web fetch tier. Its
// html_url is behind bot protection: a plain GET is 302'd to
// unblock.federalregister.gov (measured 2026-09-02), so every tier would
// extract an interstitial rather than the document. The API instead
// publishes the document's plain text at `raw_text_url`, which answers 200
// directly, so read() takes that path. As elsewhere, a fetch failure
// degrades to metadata rather than throwing.
interface FederalRegisterDocument {
  title?: string;
  publication_date?: string;
  html_url?: string;
  raw_text_url?: string;
}

export async function federalRegisterRead(id: string): Promise<ReadResult> {
  const fallbackUrl = `https://www.federalregister.gov/documents/${id}`;
  try {
    const doc = await fetchJSON<FederalRegisterDocument>(`${BASE}/documents/${id}.json`);
    const externalUrl = doc.html_url ?? fallbackUrl;
    if (!doc.raw_text_url) {
      return {
        title: doc.title ?? id,
        authors: [],
        year: yearOf(doc.publication_date),
        metadataOnly: true,
        externalUrl,
        note: 'This document publishes no plain-text rendition; showing metadata only.',
      };
    }
    const text = await fetchText(doc.raw_text_url);
    return {
      title: doc.title ?? id,
      authors: [],
      year: yearOf(doc.publication_date),
      externalUrl,
      ...truncateText(text),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: fallbackUrl,
      note: `Full-text fetch failed; showing metadata only: ${message}`,
    };
  }
}

register('federalregister', {
  description:
    'Federal Register: the daily journal of the US federal government (rules, proposed rules, and notices). No API key required.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://www.federalregister.gov',
  verifiedAt: '2026-09-01',
  search: federalRegisterSearch,
  read: federalRegisterRead,
});
