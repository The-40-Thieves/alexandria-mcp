// Regional news RSS/Atom/RDF feeds, spanning Africa, the Middle East, South
// Asia, Australia, Latin America, Europe, East Asia and the Asia-Pacific.
import { defineRssSource } from '../kinds/rss.js';

defineRssSource({
  name: 'allafrica',
  url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf',
  description: 'AllAfrica: pan-African news aggregator, as an RDF feed.',
  cluster: 'news_regional',
  region: 'Africa',
  homepage: 'https://allafrica.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'arabnews',
  url: 'https://www.arabnews.com/rss.xml',
  description: 'Arab News: Saudi Arabia-based English-language daily, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Middle East',
  homepage: 'https://www.arabnews.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'thehindu-intl',
  url: 'https://www.thehindu.com/news/international/feeder/default.rss',
  description: 'The Hindu: international news desk of the Indian daily, as an RSS feed.',
  cluster: 'news_regional',
  region: 'South Asia',
  homepage: 'https://www.thehindu.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'abc-world',
  url: 'https://www.abc.net.au/news/feed/104217382/rss.xml',
  description: 'ABC News (Australia): world news desk, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Australia / Asia-Pacific',
  homepage: 'https://www.abc.net.au/news',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'folha-en',
  url: 'https://feeds.folha.uol.com.br/internacional/en/rss091.xml',
  description: 'Folha de S.Paulo: English-language edition, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Latin America',
  homepage: 'https://www1.folha.uol.com.br/internacional/en/',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'dw',
  url: 'https://rss.dw.com/rdf/rss-en-all',
  description: 'Deutsche Welle: German public international broadcaster, as an RDF feed.',
  cluster: 'news_regional',
  region: 'Europe',
  homepage: 'https://www.dw.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'france24',
  url: 'https://www.france24.com/en/rss',
  description: 'France 24: French public international news channel, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Europe',
  homepage: 'https://www.france24.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'aljazeera',
  url: 'https://www.aljazeera.com/xml/rss/all.xml',
  description: 'Al Jazeera: Qatar-based international news network, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Middle East',
  homepage: 'https://www.aljazeera.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'almonitor',
  url: 'https://www.al-monitor.com/rss',
  description: 'Al-Monitor: independent coverage and analysis of the Middle East, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Middle East',
  homepage: 'https://www.al-monitor.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'thediplomat',
  url: 'https://thediplomat.com/feed/',
  description: 'The Diplomat: current affairs magazine covering the Asia-Pacific, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Asia-Pacific',
  homepage: 'https://thediplomat.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'nikkeiasia',
  url: 'https://asia.nikkei.com/rss/feed/nar',
  description: 'Nikkei Asia: business and economic news from Asia, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Asia',
  homepage: 'https://asia.nikkei.com',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'dailymaverick',
  url: 'https://www.dailymaverick.co.za/rss/',
  description: 'Daily Maverick: South African news and investigative journalism, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Africa',
  homepage: 'https://www.dailymaverick.co.za',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'restofworld',
  url: 'https://restofworld.org/feed/latest/',
  description: 'Rest of World: technology news from the Global South, as an RSS feed.',
  cluster: 'news_regional',
  region: 'Global South',
  homepage: 'https://restofworld.org',
  verifiedAt: '2026-09-01',
});

defineRssSource({
  name: 'scmp',
  url: 'https://www.scmp.com/rss/91/feed',
  description:
    'South China Morning Post: Hong Kong-based news covering China and Asia, as an RSS feed.',
  cluster: 'news_regional',
  region: 'East Asia',
  homepage: 'https://www.scmp.com',
  verifiedAt: '2026-09-01',
});
