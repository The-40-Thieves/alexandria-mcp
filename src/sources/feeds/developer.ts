// Developer community RSS/Atom feeds.
import { defineRssSource } from '../kinds/rss.js';

defineRssSource({
  name: 'lobsters',
  url: 'https://lobste.rs/rss',
  description:
    'Lobsters: a computing-focused link aggregation and discussion community, as an RSS feed.',
  cluster: 'developer',
  homepage: 'https://lobste.rs',
  verifiedAt: '2026-09-01',
});
