// DEPRECATED — 2026-07-16. Not imported or registered in src/index.ts.
//
// Redundant with openalex.ts: both adapters implement the same shallow
// query -> metadata + abstract -> DOI read pattern. OpenAlex ingests
// Crossref data plus PubMed and web-crawled abstracts, and measurably
// has higher abstract coverage (99.4% vs Crossref's 75.4% -- Elsevier
// and ACS don't deposit abstracts to Crossref at all). The one edge
// case Crossref could win on -- near-real-time freshness for a DOI
// deposited in the last few days -- wasn't judged worth keeping a full
// duplicate adapter for.
//
// This file is dead code, kept only because an automated delete_file
// call failed during cleanup. Safe to `git rm src/sources/crossref.ts`.
export {};
