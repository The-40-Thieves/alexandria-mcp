// Security advisory and vulnerability disclosure RSS/Atom feeds.
import { defineRssSource } from '../kinds/rss.ts';

defineRssSource({
  name: 'exploitdb',
  url: 'https://www.exploit-db.com/rss.xml',
  description: 'Exploit-DB: public archive of exploits and vulnerable software, as an RSS feed.',
  cluster: 'security',
  homepage: 'https://www.exploit-db.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'msrc',
  url: 'https://api.msrc.microsoft.com/update-guide/rss',
  description:
    'Microsoft Security Response Center: Microsoft product security update guide, as an RSS feed.',
  cluster: 'security',
  homepage: 'https://msrc.microsoft.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'projectzero',
  url: 'https://projectzero.google/feed.xml',
  description: 'Google Project Zero: vulnerability research blog, as an Atom feed.',
  cluster: 'security',
  homepage: 'https://projectzero.google',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'cisco-psirt',
  url: 'https://sec.cloudapps.cisco.com/security/center/psirtrss20/CiscoSecurityAdvisory.xml',
  description: 'Cisco PSIRT: Cisco security advisories, as an RSS feed.',
  cluster: 'security',
  homepage: 'https://sec.cloudapps.cisco.com/security/center/publicationListing.x',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'bleepingcomputer',
  url: 'https://www.bleepingcomputer.com/feed/',
  description: 'BleepingComputer: computer security and technology news, as an RSS feed.',
  cluster: 'security',
  homepage: 'https://www.bleepingcomputer.com',
  verifiedAt: '2026-09-01',
});
