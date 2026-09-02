// Standards body publication RSS feeds.
import { defineRssSource } from '../kinds/rss.js';

defineRssSource({
  name: 'nist-csrc',
  url: 'https://csrc.nist.gov/CSRC/media/feeds/publications/all.xml',
  description: 'NIST Computer Security Resource Center — all publications, as an RSS feed.',
  cluster: 'standards',
  homepage: 'https://csrc.nist.gov/publications',
});
