// The RSS/Atom/RDF/JSON Feed adapter kind. defineRssSource() registers one
// source per feed; parseFeedItems() normalizes feedsmith's per-format output
// (RSS 2.0, Atom, RDF, JSON Feed) into one flat item shape the rest of this
// file (and googlenews.ts) can share.
import { parseFeed } from 'feedsmith';
import type { LibraryResult, ReadResult } from '../../types.js';
import { fetchText } from '../../utils/http.js';
import { stripHtml } from '../../utils/text-clean.js';
import type { Cluster, Freshness } from '../registry.js';
import { register } from '../registry.js';

export interface FeedConfig {
  name: string;
  url: string;
  description: string;
  cluster: Cluster;
  region?: string;
  homepage: string;
  freshness?: Freshness;
  timeoutMs?: number;
  headers?: Record<string, string>;
  verifiedAt?: string;
}

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  published?: string;
  summary?: string;
  authors: string[];
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => Boolean(v));
}

// Feed summaries routinely arrive as HTML fragments (Google News wraps its
// title in an <a>, some publishers ship full <content:encoded> markup).
// Strip tags/decode entities once, here, so both the token-match filter and
// LibraryResult.description see plain text.
function cleanSummary(summary?: string): string | undefined {
  if (!summary) return undefined;
  const cleaned = stripHtml(summary);
  return cleaned || undefined;
}

// Normalizes feedsmith's parseFeed() output (RSS 2.0, Atom, RDF, JSON Feed)
// into one flat, per-item shape.
export function parseFeedItems(xmlOrJson: string): FeedItem[] {
  const { format, feed } = parseFeed(xmlOrJson);

  if (format === 'rss') {
    return (feed.items ?? []).map((item) => {
      const link = item.link ?? item.guid?.value ?? '';
      const authors =
        item.authors ?? item.dc?.creators ?? (item.dc?.creator ? [item.dc.creator] : []);
      return {
        id: link || (item.guid?.value ?? item.title ?? ''),
        title: item.title ?? '',
        link,
        published: first(item.pubDate, item.dc?.dates?.[0], item.dc?.date),
        summary: cleanSummary(first(item.description, item.content?.encoded)),
        authors,
      };
    });
  }

  if (format === 'atom') {
    return (feed.entries ?? []).map((entry) => {
      const link =
        entry.links?.find((l) => !l.rel || l.rel === 'alternate')?.href ??
        entry.links?.[0]?.href ??
        '';
      return {
        id: entry.id ?? link,
        title: entry.title ?? '',
        link,
        published: first(entry.published, entry.updated),
        summary: cleanSummary(first(entry.summary, entry.content)),
        authors: (entry.authors ?? []).map((a) => a.name).filter((n): n is string => Boolean(n)),
      };
    });
  }

  if (format === 'rdf') {
    return (feed.items ?? []).map((item) => {
      const authors = item.dc?.creators ?? (item.dc?.creator ? [item.dc.creator] : []);
      return {
        id: item.link ?? item.rdf?.about ?? '',
        title: item.title ?? '',
        link: item.link ?? '',
        published: first(item.dc?.dates?.[0], item.dc?.date),
        summary: cleanSummary(item.description),
        authors,
      };
    });
  }

  // format === 'json'
  return (feed.items ?? []).map((item) => ({
    id: item.id ?? item.url ?? '',
    title: item.title ?? '',
    link: item.url ?? item.external_url ?? '',
    published: item.date_published,
    summary: cleanSummary(first(item.summary, item.content_text)),
    authors: (item.authors ?? []).map((a) => a.name).filter((n): n is string => Boolean(n)),
  }));
}

function toTime(published?: string): number {
  if (!published) return 0;
  const t = Date.parse(published);
  return Number.isNaN(t) ? 0 : t;
}

function matchesQuery(item: FeedItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

function toResult(sourceName: string, item: FeedItem): LibraryResult {
  const id = item.link || item.id;
  return {
    id,
    source: sourceName,
    title: item.title || id,
    authors: item.authors,
    hasFullText: false,
    description: item.summary,
    published: item.published,
    url: item.link || undefined,
  };
}

// Registers one source for a single feed. search() fetches the feed fresh
// on every call (the registry's 10-minute search cache handles repeats),
// filters by case-insensitive token match on title+summary (every query
// token must match; an empty query matches everything), and returns up to
// `limit` items newest-first.
export function defineRssSource(cfg: FeedConfig): void {
  const description = cfg.region ? `${cfg.description} (region: ${cfg.region})` : cfg.description;
  const timeoutMs = cfg.timeoutMs ?? 20000;

  async function search(query: string, limit: number): Promise<LibraryResult[]> {
    const body = await fetchText(cfg.url, { headers: cfg.headers }, timeoutMs);
    const items = parseFeedItems(body);
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matched = items.filter((item) => matchesQuery(item, tokens));
    matched.sort((a, b) => toTime(b.published) - toTime(a.published));
    return matched.slice(0, limit).map((item) => toResult(cfg.name, item));
  }

  // TODO(stage-6): fetchTier. Once the web fetch tier lands, read(id) should
  // retrieve and extract the article body at the item's link instead of
  // returning metadata only.
  async function read(id: string): Promise<ReadResult> {
    return {
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl: id,
      note: 'Full-text fetch for RSS sources arrives in a later stage; this is metadata only.',
    };
  }

  register(cfg.name, {
    description,
    supportsIngest: false,
    kind: 'rss',
    cluster: cfg.cluster,
    freshness: cfg.freshness ?? 'realtime',
    homepage: cfg.homepage,
    timeoutMs,
    headers: cfg.headers,
    verifiedAt: cfg.verifiedAt,
    search,
    read,
  });
}
