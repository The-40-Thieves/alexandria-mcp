import type { LibraryResult } from '../types.js';
import { fetchJSON } from '../utils/http.js';
import { register } from './registry.js';

// HathiTrust's Data API (the old /api/v2/volumes/search) was retired.
// There is no public keyword-search API left — catalog.hathitrust.org/api
// only supports a brief lookup by a known identifier (OCLC number, ISBN,
// or HathiTrust volume id). search() therefore always returns [] (see
// hathitrustSearch below); read() is the only working entry point.
const BRIEF_API = 'https://catalog.hathitrust.org/api/volumes/brief';

interface HTBriefRecord {
  recordURL?: string;
  titles?: string[];
  isbns?: string[];
  oclcs?: string[];
  lccns?: string[];
  publishDates?: string[];
}

interface HTBriefItem {
  htid?: string;
  itemURL?: string;
  rightsCode?: string;
}

interface HTBriefResponse {
  records?: Record<string, HTBriefRecord>;
  items?: HTBriefItem[];
}

export async function hathitrustSearch(
  _query: string,
  _limit: number,
): Promise<LibraryResult[]> {
  return Promise.resolve([]);
}

const ID_PATTERN = /^(oclc|isbn|htid):(.+)$/;

function parseId(id: string): { kind: 'oclc' | 'isbn' | 'htid'; value: string } {
  const m = ID_PATTERN.exec(id);
  if (!m) {
    throw new Error(
      `Unrecognized HathiTrust id "${id}". Expected "oclc:<number>", "isbn:<number>", or "htid:<id>".`,
    );
  }
  return { kind: m[1] as 'oclc' | 'isbn' | 'htid', value: m[2] };
}

export function normalizeHathiTrustBrief(
  data: HTBriefResponse,
  id: string,
): {
  title: string;
  authors: string[];
  year?: number;
  metadataOnly: boolean;
  externalUrl: string;
  note: string;
} {
  const records = Object.values(data.records ?? {});
  const record = records[0];
  const item = data.items?.[0];

  if (!record && !item) {
    throw new Error(`No HathiTrust record found for ${id}.`);
  }

  const title = record?.titles?.[0] ?? id;
  const year = record?.publishDates?.[0]
    ? parseInt(record.publishDates[0].slice(0, 4), 10)
    : undefined;
  const externalUrl = item?.itemURL ?? record?.recordURL ?? 'https://catalog.hathitrust.org/';

  return {
    title,
    authors: [],
    year,
    metadataOnly: true,
    externalUrl,
    note:
      'HathiTrust full-text download requires the HathiTrust Data API / HTRC for programmatic access. ' +
      `Public domain texts are readable at externalUrl (rights: ${item?.rightsCode ?? 'unknown'}).`,
  };
}

export async function hathitrustRead(id: string): Promise<{
  title: string;
  authors: string[];
  year?: number;
  metadataOnly: boolean;
  externalUrl: string;
  note: string;
}> {
  const { kind, value } = parseId(id);
  const data = await fetchJSON<HTBriefResponse>(
    `${BRIEF_API}/${kind}/${encodeURIComponent(value)}.json`,
  );
  return normalizeHathiTrustBrief(data, id);
}

register('hathitrust', {
  description:
    'HathiTrust — 18M+ volumes digitized from research libraries. The Data API keyword-search endpoint was retired; search() always returns []. Look up a known volume by OCLC number, ISBN, or HathiTrust id via read("oclc:<n>" | "isbn:<n>" | "htid:<id>").',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'literature',
  freshness: 'static',
  homepage: 'https://www.hathitrust.org',
  search: hathitrustSearch,
  async read(id) {
    return hathitrustRead(id);
  },
});
