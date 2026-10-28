import { test } from 'vitest';
import '../src/sources/all.ts';
import { catalog } from '../src/sources/registry.ts';
import { dropDanglingCitations, removeCitationMarkers } from '../src/tools/libraryAnswer.ts';
import { detectFreshnessPreference } from '../src/tools/libraryAsk.ts';
import {
  bm25Candidates,
  type CatalogEntry,
  cosineSimilarity,
  withClusterFloor,
} from '../src/utils/catalogIndex.ts';

// The same "name: description (cluster X)" entries buildCatalog() ranks in
// BM25 mode, built from the registry directly so no embeddings role (and
// no network) is ever involved.
const ENTRIES: CatalogEntry[] = catalog().map((s) => ({
  name: s.name,
  text: `${s.name}: ${s.description} (cluster ${s.cluster})`,
  cluster: s.cluster,
  freshness: s.freshness,
}));

const QUERIES = [
  'recent preprints on transformer neural network interpretability',
  'court ruling on copyright fair use for software',
  'latest CVE vulnerability advisory for openssl',
  'public domain poetry books by Emily Dickinson',
  'US inflation and unemployment rate over the last decade',
];

function vector(seed: number, dims: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < dims; i++) v.push(Math.sin(seed * 997 + i * 13));
  return v;
}
const VEC_A = vector(1, 1536);
const VEC_B = vector(2, 1536);

const ANSWER = Array.from(
  { length: 60 },
  (_, i) =>
    `Finding number ${i} is reported across the archive and confirmed by a later study [${(i % 12) + 1}][${(i % 5) + 1}].`,
).join(' ');

test('stage-1 routing', async ({ bench }) => {
  await bench('bm25Candidates', () => {
    for (const q of QUERIES) bm25Candidates(q, ENTRIES, 20);
  }).run();
  await bench('withClusterFloor', () => {
    withClusterFloor(ENTRIES, 20);
  }).run();
  await bench('cosineSimilarity 1536d', () => {
    cosineSimilarity(VEC_A, VEC_B);
  }).run();
  await bench('detectFreshnessPreference', () => {
    for (const q of QUERIES) detectFreshnessPreference(q);
  }).run();
});

test('answer post-processing', async ({ bench }) => {
  await bench('dropDanglingCitations', () => {
    dropDanglingCitations(ANSWER, 8);
  }).run();
  await bench('removeCitationMarkers', () => {
    removeCitationMarkers(ANSWER);
  }).run();
});
