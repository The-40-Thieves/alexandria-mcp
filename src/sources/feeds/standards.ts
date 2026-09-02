// Standards body publication RSS feeds.
import { defineRssSource } from '../kinds/rss.js';

// The Stage 3 URL (.../CSRC/media/feeds/publications/all.xml) 404s as of
// 2026-09-01; CSRC moved its publications feeds under /CSRC/media/feeds/pubs/.
// There is no "all publications" feed there, only this one (linked from
// https://csrc.nist.gov/publications): drafts currently open for public
// comment. It is a real, currently-updating NIST CSRC feed, just narrower
// in scope than the old one.
defineRssSource({
  name: 'nist-csrc',
  url: 'https://csrc.nist.gov/CSRC/media/feeds/pubs/drafts-open-for-comment.xml',
  description:
    'NIST Computer Security Resource Center: draft publications currently open for public comment, as an Atom feed.',
  cluster: 'standards',
  homepage: 'https://csrc.nist.gov/publications/drafts-open-for-comment',
  verifiedAt: '2026-09-01',
});
