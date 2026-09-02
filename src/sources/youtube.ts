// YouTube — search via the official Data API v3, transcripts via
// YouTube's undocumented Innertube player endpoint + timedtext fetch.
//
// READ THIS BEFORE DEBUGGING A BREAK:
// There is no official transcript API for third-party videos. The Data
// API's captions.download endpoint is owner/OAuth-only — it cannot fetch
// captions for a video you don't own. Every transcript tool in existence
// (youtube-transcript-api, yt-dlp, ytranscript, etc.) uses the same
// undocumented path this file uses: call the internal Innertube `player`
// endpoint to get caption track URLs, then fetch the timedtext endpoint
// directly. This is the same risk category as codewiki.ts — undocumented,
// no contract, changes without notice (empirically every few months) —
// and sits in a Terms-of-Service gray area for automated access. Widely
// tolerated for low-volume personal/research use; this should not be the
// basis of anything commercial or high-volume. If it breaks, check
// whether YouTube changed the Innertube client version/context shape or
// the timedtext response format before assuming the code is wrong.
//
// search() uses the official Data API v3 (requires YOUTUBE_API_KEY, free,
// enable "YouTube Data API v3" in Google Cloud Console). As of the June
// 2026 quota change, search.list bills to its own dedicated bucket capped
// at ~100 calls/day, separate from the shared 10,000-unit pool — plenty
// for personal use. Don't build anything that loops searches.
//
// read() spends zero Data API quota — it only uses the unofficial
// Innertube + timedtext path.

import type { LibraryResult } from '../types.ts';
import { fetchJSON, fetchText } from '../utils/http.ts';
import { register, truncateText } from './registry.ts';

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
// Innertube client. The default WEB client is bot-checked from datacenter
// IPs (Railway, cloud VMs): the player call returns UNPLAYABLE / "Sign in to
// confirm you're not a bot" with no caption tracks. ANDROID_VR is the client
// yt-dlp defaults to for exactly this reason (no PO token required as of
// 2026-09); verified from a cloud IP on 2026-09-01. If read() starts returning
// metadataOnly for every video, check yt-dlp's current default clients first.
const CLIENT = {
  clientName: 'ANDROID_VR',
  clientVersion: '1.57.29',
  deviceModel: 'Quest 3',
  osName: 'Android',
  osVersion: '12L',
  androidSdkVersion: 32,
};
const UA =
  'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

// Caption track URLs already carry a `fmt` parameter (srv3 XML). Appending
// `&fmt=json3` is ignored (first value wins) and the XML then fails JSON.parse,
// so the parameter has to be replaced, not added.
export function captionJsonUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.searchParams.set('fmt', 'json3');
  return u.toString();
}

interface YTSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    publishedAt?: string;
  };
}
interface YTSearchResponse {
  items?: YTSearchItem[];
}

export async function youtubeSearch(query: string, limit = 10): Promise<LibraryResult[]> {
  // Deliberately the standard "<name> requires <ENV>" wording, not a
  // registry `auth` declaration: see the register() call below.
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('youtube requires YOUTUBE_API_KEY');

  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(Math.min(Math.max(limit, 1), 50)),
    key: apiKey,
  });

  const data = await fetchJSON<YTSearchResponse>(`${SEARCH_URL}?${params.toString()}`);

  return (data.items ?? [])
    .filter((item): item is YTSearchItem & { id: { videoId: string } } => Boolean(item.id?.videoId))
    .map((item) => {
      const id = item.id.videoId;
      const yearRaw = item.snippet?.publishedAt
        ? parseInt(item.snippet.publishedAt.substring(0, 4), 10)
        : NaN;
      return {
        id,
        source: 'youtube' as const,
        title: item.snippet?.title ?? id,
        authors: item.snippet?.channelTitle ? [item.snippet.channelTitle] : [],
        year: Number.isNaN(yearRaw) ? undefined : yearRaw,
        // Optimistic — actual caption availability is only known at read() time.
        hasFullText: true,
        previewUrl: `https://www.youtube.com/watch?v=${id}`,
        description: item.snippet?.description?.substring(0, 300),
      };
    });
}

// --- Innertube transcript fetch ---

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string; // 'asr' = auto-generated
}
interface PlayerResponse {
  videoDetails?: {
    title?: string;
    author?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
}

interface TimedTextEvent {
  segs?: Array<{ utf8?: string }>;
}
interface TimedTextResponse {
  events?: TimedTextEvent[];
}

function pickTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  return (
    tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ??
    tracks.find((t) => t.languageCode?.startsWith('en')) ??
    tracks[0]
  );
}

interface YoutubeReadResult {
  text: string;
  title: string;
  authors: string[];
  language?: string;
  metadataOnly?: boolean;
  note?: string;
  externalUrl: string;
}

interface SupadataTranscriptResponse {
  content?: string;
  lang?: string;
  availableLangs?: string[];
}

// Supadata (https://supadata.ai) is a paid third-party transcript API that
// wraps the same kind of undocumented extraction this file does itself,
// but as someone else's maintained service. Preferred when configured
// since it doesn't depend on this file's Innertube client staying current.
export async function supadataRead(id: string): Promise<YoutubeReadResult | undefined> {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) return undefined;

  const externalUrl = `https://www.youtube.com/watch?v=${id}`;
  const params = new URLSearchParams({ videoId: id, text: 'true' });
  const data = await fetchJSON<SupadataTranscriptResponse>(
    `https://api.supadata.ai/v1/youtube/transcript?${params}`,
    { headers: { 'x-api-key': apiKey } },
  );

  if (!data.content) {
    return {
      text: '',
      title: id,
      authors: [],
      metadataOnly: true,
      externalUrl,
      note: 'Supadata returned no transcript content for this video.',
    };
  }

  return {
    text: data.content,
    title: id, // Supadata's transcript endpoint doesn't return video title/author
    authors: [],
    language: data.lang,
    externalUrl,
  };
}

export async function youtubeRead(id: string): Promise<YoutubeReadResult> {
  const externalUrl = `https://www.youtube.com/watch?v=${id}`;

  const player = await fetchJSON<PlayerResponse>(PLAYER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      context: { client: CLIENT },
      videoId: id,
    }),
  });

  const title = player.videoDetails?.title ?? id;
  const authors = player.videoDetails?.author ? [player.videoDetails.author] : [];

  if (player.playabilityStatus?.status && player.playabilityStatus.status !== 'OK') {
    return {
      text: '',
      title,
      authors,
      metadataOnly: true,
      externalUrl,
      note: `Video not accessible: ${player.playabilityStatus.reason ?? player.playabilityStatus.status}`,
    };
  }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    return {
      text: '',
      title,
      authors,
      metadataOnly: true,
      externalUrl,
      note: 'No captions available for this video (creator disabled captions or none were generated).',
    };
  }

  const track = pickTrack(tracks);
  if (!track?.baseUrl) {
    return {
      text: '',
      title,
      authors,
      metadataOnly: true,
      externalUrl,
      note: 'Caption track metadata was present but had no fetchable URL.',
    };
  }

  let parsed: TimedTextResponse;
  try {
    const raw = await fetchText(captionJsonUrl(track.baseUrl), { headers: { 'User-Agent': UA } });
    parsed = JSON.parse(raw) as TimedTextResponse;
  } catch {
    return {
      text: '',
      title,
      authors,
      metadataOnly: true,
      externalUrl,
      note: 'Caption track fetch failed or returned an unparseable response — YouTube likely changed the format.',
    };
  }

  const text = (parsed.events ?? [])
    .flatMap((e) => e.segs ?? [])
    .map((s) => s.utf8 ?? '')
    .join('')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (!text) {
    return {
      text: '',
      title,
      authors,
      metadataOnly: true,
      externalUrl,
      note: 'Caption track had no text segments.',
    };
  }

  return { text, title, authors, language: track.languageCode, externalUrl };
}

register('youtube', {
  description:
    'YouTube: video search via the official Data API v3 (requires YOUTUBE_API_KEY, ~100 searches/day). Transcripts prefer Supadata (SUPADATA_API_KEY, a maintained third-party transcript service) when configured; otherwise fall back to an undocumented endpoint since no official transcript API exists for third-party videos, same risk profile as codewiki (can break without notice, ToS gray area for automated access; low-volume personal/research use only). No ingest: transcripts stay read-only, never indexed.',
  supportsIngest: false,
  kind: 'rest',
  cluster: 'video',
  freshness: 'realtime',
  homepage: 'https://www.youtube.com',
  verifiedAt: '2026-09-01',
  // No `auth` declared on purpose: read() needs no Data API key at all
  // (Supadata when SUPADATA_API_KEY is set, otherwise the keyless
  // Innertube path), so library_read(source='youtube') must keep working
  // without YOUTUBE_API_KEY. Only search() needs the key. `hidden` is the
  // right lever for that half: a hidden source is excluded from routing
  // (so library_ask never fans out to a search that would throw) but stays
  // callable by name, exactly like the REST context7/mdn sources. search()
  // still throws the standard "<name> requires <ENV>" text when called by
  // name without the key, so scripts/probe.ts classifies it KEY_MISSING.
  hidden: !process.env.YOUTUBE_API_KEY,
  optionalEnv: ['YOUTUBE_API_KEY', 'SUPADATA_API_KEY'],
  pacing: { dailyCap: 90 },
  search: youtubeSearch,
  async read(id) {
    let raw: YoutubeReadResult | undefined;
    if (process.env.SUPADATA_API_KEY) {
      try {
        raw = await supadataRead(id);
      } catch {
        /* fall back to the Innertube path below */
      }
    }
    if (!raw || (raw.metadataOnly && !raw.text)) {
      raw = await youtubeRead(id);
    }
    if (raw.metadataOnly || !raw.text) {
      return {
        title: raw.title,
        authors: raw.authors,
        metadataOnly: true,
        externalUrl: raw.externalUrl,
        note: raw.note,
      };
    }
    return {
      title: raw.title,
      authors: raw.authors,
      language: raw.language,
      externalUrl: raw.externalUrl,
      ...truncateText(raw.text),
    };
  },
});
