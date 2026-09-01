// DEPRECATED — 2026-07-16. Not imported or registered in src/index.ts.
//
// Superseded by doab.ts: this adapter was a hardcoded 7-book curated
// list (Piketty, Foucault, Habermas, Arendt, Benjamin, Latour, Deleuze)
// plus a best-effort OAI-PMH scrape that silently fell back to just
// those 7 on any failure. doab.ts hits DOAB's live search API (70k+
// books, 600+ publishers) and already indexes OAPEN's shareable
// catalog — both are run by the OAPEN Foundation.
//
// This file is dead code, kept only because an automated delete_file
// call failed during cleanup. Safe to `git rm src/sources/oapen.ts`.
export {};
