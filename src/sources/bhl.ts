import type { LibraryResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { normaliseWhitespace } from '../utils/text-clean.ts';
import { register, requireKey, truncateText } from './registry.ts';

const API = 'https://www.biodiversitylibrary.org/api3';

function getKey(): string {
  return requireKey('bhl', 'BHL_API_KEY');
}

interface BHLTitle {
  TitleID: string;
  FullTitle?: string;
  AuthorList?: Array<{ Name: string }>;
  PublicationDate?: string;
  Language?: string;
  Subjects?: string[];
}

interface BHLTextItem {
  ItemID: string;
  PrimaryTitleID: string;
}

interface BHLResponse<T> {
  Result?: T[];
  Status: string;
}

function apiUrl(op: string, params: Record<string, string>): string {
  const p = new URLSearchParams({ op, apikey: getKey(), format: 'json', ...params });
  return `${API}?${p}`;
}

export async function bhlSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const data = await fetchJSON<BHLResponse<BHLTitle>>(
    apiUrl('PublicationSearch', { searchterm: query, searchtype: 'F' }),
  );

  return (data.Result ?? []).slice(0, limit).map((t) => ({
    id: t.TitleID,
    source: 'bhl' as const,
    title: t.FullTitle ?? t.TitleID,
    authors: (t.AuthorList ?? []).map((a) => a.Name),
    year: t.PublicationDate ? parseInt(t.PublicationDate, 10) : undefined,
    language: t.Language,
    subjects: (t.Subjects ?? []).slice(0, 5),
    hasFullText: true,
    previewUrl: `https://www.biodiversitylibrary.org/bibliography/${t.TitleID}`,
  }));
}

export async function bhlRead(titleId: string): Promise<{
  text: string;
  title: string;
  authors: string[];
}> {
  // Get items (volumes) for this title
  const data = await fetchJSON<BHLResponse<BHLTextItem>>(
    apiUrl('GetTitleMetadata', { id: titleId, idtype: 'title', items: 'true' }),
  );

  const item = data.Result?.[0];
  if (!item) throw new Error(`BHL title not found: ${titleId}`);

  // Get OCR text for the first item
  const textUrl = `https://www.biodiversitylibrary.org/itempdf/${item.ItemID}`;
  await new Promise((r) => setTimeout(r, 500));
  const text = await fetchText(textUrl);

  return {
    text: normaliseWhitespace(text),
    title: titleId,
    authors: [],
  };
}

register('bhl', {
  description:
    'Biodiversity Heritage Library — natural history, botany, zoology literature. Requires free BHL_API_KEY.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'science',
  freshness: 'daily',
  homepage: 'https://www.biodiversitylibrary.org',
  verifiedAt: '2026-09-01',
  // Free key from https://www.biodiversitylibrary.org/getapikey.aspx
  auth: { type: 'query', env: 'BHL_API_KEY', param: 'apikey' },
  search: bhlSearch,
  async read(id) {
    const raw = await bhlRead(id);
    return { ...raw, ...truncateText(raw.text) };
  },
});
