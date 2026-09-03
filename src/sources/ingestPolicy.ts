// A source's ingest policy governs whether its retrieved text may be
// written into the vector store by library_ingest. This is a separate
// concept from `supportsIngest` (registry.ts): `supportsIngest` says the
// source HAS retrievable plain text at all; `ingestPolicy` says what the
// source's terms allow doing with that text once retrieved. Four values:
//   - 'allowed' (the default): no restriction beyond supportsIngest.
//   - 'attribution': ingest is allowed, but every stored chunk must carry
//     an attribution stamp so a downstream reader can credit the source.
//   - 'timeboxed': ingest is allowed only once the deployer opts in via
//     ALEXANDRIA_INGEST_TIMEBOXED=1, because the source's terms require
//     deleting stored text after a retention window; stored chunks carry
//     an expiresAt so a retention sweep can find them.
//   - 'forbidden': ingest is never allowed, regardless of config. Sources
//     with this policy should also set supportsIngest: false so search
//     results never advertise library_ingest as available.
import { config } from '../config.ts';

export type IngestPolicy = 'allowed' | 'attribution' | 'timeboxed' | 'forbidden';

// The retention window for a 'timeboxed' source. guardian.ts is the only
// timeboxed source today (its terms give 24h); this isn't yet
// per-source configurable because nothing else needs a different window.
const TIMEBOX_WINDOW_MS = 24 * 60 * 60 * 1000;

// The minimal shape assertIngestAllowed()/ingestMetadata() need out of a
// registered source: its name (for the error/attribution text), its
// declared policy, and (for 'attribution') a homepage to credit. A full
// SourceMeta satisfies this; tests can pass a bare object.
export interface IngestPolicySource {
  name: string;
  ingestPolicy?: IngestPolicy;
  homepage?: string;
}

// Stamped onto every chunk's metadata by src/pipeline/index.ts's
// ingestText() before it's written, so provenance survives in the vector
// store even though IngestResult itself only reports counts.
export interface IngestMetadata {
  license?: string;
  attribution?: string;
  expiresAt?: string;
}

/**
 * Throws when `source`'s ingest policy blocks storing its text right now.
 * 'forbidden' always throws. 'timeboxed' throws unless the deployer has
 * opted in via ALEXANDRIA_INGEST_TIMEBOXED=1. 'allowed' and 'attribution'
 * never throw here - attribution's obligation is met by ingestMetadata()'s
 * stamp, not by refusing the call.
 */
export function assertIngestAllowed(source: IngestPolicySource): void {
  const policy = source.ingestPolicy ?? 'allowed';
  if (policy === 'forbidden') {
    throw new Error(
      `"${source.name}" cannot be ingested: its terms forbid storing retrieved text ` +
        '(ingestPolicy: "forbidden"). Use library_read instead.',
    );
  }
  if (policy === 'timeboxed' && config.ALEXANDRIA_INGEST_TIMEBOXED !== '1') {
    throw new Error(
      `"${source.name}" ingest is timeboxed by its terms: stored text must be deleted within ` +
        'a retention window. Set ALEXANDRIA_INGEST_TIMEBOXED=1 to confirm you will honor that ' +
        'window before ingesting.',
    );
  }
}

/**
 * Builds the provenance stamp to merge onto every chunk's metadata before
 * it's written. Returns {} for 'allowed' (nothing to stamp) and
 * 'forbidden' (a caller should never reach this for 'forbidden' -
 * assertIngestAllowed throws first).
 */
export function ingestMetadata(source: IngestPolicySource): IngestMetadata {
  const policy = source.ingestPolicy ?? 'allowed';
  switch (policy) {
    case 'attribution':
      return { attribution: source.homepage ? `${source.name} (${source.homepage})` : source.name };
    case 'timeboxed':
      return { expiresAt: new Date(Date.now() + TIMEBOX_WINDOW_MS).toISOString() };
    default:
      return {};
  }
}
