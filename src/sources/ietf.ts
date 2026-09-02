// IETF Datatracker: RFC search by title. A custom register() rather than
// defineRest(): read() fetches the RFC's plain-text body from
// rfc-editor.org, not JSON, which defineRest()'s JSON-only read() can't
// handle.
import type { LibraryResult, ReadResult } from '../types.js';
import { fetchJSON, fetchText } from '../utils/http.js';
import { register, truncateText } from './registry.js';

const DATATRACKER = 'https://datatracker.ietf.org/api/v1/doc/document';
const RFC_EDITOR = 'https://www.rfc-editor.org/rfc';

interface IetfDocument {
  name: string;
  title: string;
  time: string;
}

interface IetfSearchResponse {
  objects?: IetfDocument[];
}

export function normalizeIetf(doc: IetfDocument): LibraryResult {
  const year = doc.time ? new Date(doc.time).getFullYear() : undefined;
  return {
    id: doc.name,
    source: 'ietf',
    title: doc.title,
    authors: [],
    year: Number.isFinite(year) ? year : undefined,
    hasFullText: true,
    published: doc.time,
    previewUrl: `${RFC_EDITOR}/${doc.name}`,
  };
}

export async function ietfSearch(query: string, limit: number): Promise<LibraryResult[]> {
  const params = new URLSearchParams({
    type: 'rfc',
    title__icontains: query,
    limit: String(limit),
    format: 'json',
  });
  const data = await fetchJSON<IetfSearchResponse>(`${DATATRACKER}/?${params.toString()}`);
  return (data.objects ?? []).map(normalizeIetf);
}

export async function ietfRead(id: string): Promise<ReadResult> {
  const text = await fetchText(`${RFC_EDITOR}/${encodeURIComponent(id)}.txt`);
  return {
    title: id,
    authors: [],
    ...truncateText(text),
  };
}

register('ietf', {
  description:
    'IETF Datatracker: RFC search by title, full text read from rfc-editor.org. No API key required.',
  supportsIngest: true,
  kind: 'rest',
  cluster: 'standards',
  freshness: 'static',
  homepage: 'https://datatracker.ietf.org',
  verifiedAt: '2026-09-01',
  search: ietfSearch,
  read: ietfRead,
});
