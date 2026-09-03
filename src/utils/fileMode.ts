// Final wave, A5: `data/` was created with the process umask (typically
// 775) and the sqlite files inside it (alexandria.db, http-cache.db) with
// 644 - world/group readable, even though http-cache.db holds third-party
// response bodies and alexandria.db holds the quota ledger and cached
// routing/search decisions. dispatcher.ts and stateStore.ts both create a
// data directory and open a sqlite file there; this module gives both the
// same two primitives instead of duplicating the chmod dance.
import fs from 'node:fs';

// Owner-only directory permissions, passed straight to fs.mkdirSync's
// `mode` option. Only takes effect on a directory this call actually
// creates - mkdirSync does not retroactively chmod an already-existing
// directory, so an existing install's data/ keeps whatever mode it already
// has until something else fixes it up.
export const SECURE_DIR_MODE = 0o700;

// Owner-only file permissions for a sqlite database and its WAL/SHM
// siblings (present under `PRAGMA journal_mode = WAL`, absent otherwise).
const SECURE_FILE_MODE = 0o600;

function chmodIfExists(path: string): void {
  try {
    fs.chmodSync(path, SECURE_FILE_MODE);
  } catch (err) {
    // ENOENT: this sibling doesn't exist yet (e.g. -wal/-shm before the
    // first write, or a store that opened in-memory). Anything else is a
    // real problem, but a permissions tighten-up is best-effort and must
    // never take down the store that already opened successfully.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // Swallow deliberately; nothing downstream depends on this
      // succeeding, and there is no logger dependency worth adding here.
    }
  }
}

// Chmods a sqlite db file plus its -wal and -shm siblings to owner-only.
// Call after the database is open (SqliteCacheStore/DatabaseSync create
// the file themselves; chmod-after-open is the only hook available).
// A no-op for ':memory:' or any other path with no on-disk file.
export function secureSqliteFile(dbPath: string): void {
  if (dbPath === ':memory:') return;
  chmodIfExists(dbPath);
  chmodIfExists(`${dbPath}-wal`);
  chmodIfExists(`${dbPath}-shm`);
}
