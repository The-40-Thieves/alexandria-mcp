// UK Parliament Hansard API (hansard-api.parliament.uk): full-text search
// over debates, contributions, and written answers, plus the verbatim
// record of any one debate. No API key required; no documented rate
// limit. search() and read() are each a single JSON fetch with
// synchronous normalization, so this fits defineRest.
//
// search.json's response bundles several result categories (Contributions,
// WrittenAnswers, Members, ...); this adapter surfaces `Debates` (each a
// whole sitting on a topic, verified live 2026-09-03) rather than
// individual `Contributions`, since a debate is the natural read() unit -
// its `DebateSectionExtId` is exactly the id /debates/debate/{id}.json
// takes.
import type { LibraryResult } from '../types.ts';
import { defineRest } from './kinds/rest.ts';
import { truncateText } from './registry.ts';

const SEARCH_URL = 'https://hansard-api.parliament.uk/search.json';
const DEBATE_URL = 'https://hansard-api.parliament.uk/debates/debate';

interface HansardDebateHit {
  DebateSection: string;
  SittingDate: string;
  House: string;
  Title: string;
  DebateSectionExtId: string;
}
interface HansardSearchResponse {
  Debates?: HansardDebateHit[];
}

interface HansardContributionItem {
  ItemType: string;
  AttributedTo?: string;
  Value?: string;
}
interface HansardDebateResponse {
  Overview?: { Title?: string; Date?: string; House?: string; Location?: string };
  Items?: HansardContributionItem[];
}

export function normalizeHansardDebate(hit: HansardDebateHit): LibraryResult {
  return {
    id: hit.DebateSectionExtId,
    source: 'hansard',
    title: hit.Title,
    authors: [],
    year: hit.SittingDate ? new Date(hit.SittingDate).getFullYear() : undefined,
    subjects: [hit.House],
    hasFullText: true,
    previewUrl: `https://hansard.parliament.uk/${hit.House}/${hit.SittingDate?.slice(0, 10)}/debates/${hit.DebateSectionExtId}`,
    description: hit.DebateSection,
  };
}

defineRest<HansardSearchResponse>({
  name: 'hansard',
  description:
    'UK Parliament Hansard: full-text search over Commons and Lords debates, with the complete member-by-member record of any one debate. No API key required.',
  cluster: 'government',
  freshness: 'daily',
  homepage: 'https://hansard.parliament.uk',
  supportsIngest: true,
  verifiedAt: '2026-09-03',
  search: {
    url: (q, limit) =>
      `${SEARCH_URL}?queryParameters.searchTerm=${encodeURIComponent(q)}&queryParameters.take=${limit}`,
    pick: (raw) => raw.Debates ?? [],
    normalize: normalizeHansardDebate,
  },
  read: {
    url: (id) => `${DEBATE_URL}/${encodeURIComponent(id)}.json`,
    normalize: (raw: HansardDebateResponse, id: string) => {
      const contributions = (raw.Items ?? []).filter(
        (item) => item.ItemType === 'Contribution' && item.Value,
      );
      const text = contributions
        .map((item) => (item.AttributedTo ? `${item.AttributedTo}: ${item.Value}` : item.Value))
        .join('\n\n');
      return {
        title: raw.Overview?.Title || id,
        authors: [],
        year: raw.Overview?.Date ? new Date(raw.Overview.Date).getFullYear() : undefined,
        ...truncateText(text || `No contributions recorded for debate ${id}.`),
      };
    },
  },
});
