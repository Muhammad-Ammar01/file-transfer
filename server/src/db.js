// C8 Metadata DB: sessions, files and per-chunk state (SQLite via Node's built-in node:sqlite).
//
// Chunk state:  PENDING -> RECEIVED (stored, hash checked) -> VERIFIED (re-checked during assembly)
// File status:  PENDING -> ASSEMBLING -> READY | FAILED
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      code       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      session_id      TEXT NOT NULL,
      fid             TEXT NOT NULL,
      name            TEXT NOT NULL,
      type            TEXT NOT NULL,
      size            INTEGER NOT NULL,
      chunks          INTEGER NOT NULL,
      chunk_size      INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'PENDING',
      manifest_sha256 TEXT,
      error           TEXT,
      PRIMARY KEY (session_id, fid)
    );
    CREATE TABLE IF NOT EXISTS chunks (
      session_id TEXT NOT NULL,
      fid        TEXT NOT NULL,
      n          INTEGER NOT NULL,
      hash       TEXT,
      state      TEXT NOT NULL DEFAULT 'PENDING',
      PRIMARY KEY (session_id, fid, n)
    );
  `);

  const q = {
    insertSession: db.prepare('INSERT INTO sessions (session_id, code, created_at) VALUES (?, ?, ?)'),
    insertFile: db.prepare(
      'INSERT INTO files (session_id, fid, name, type, size, chunks, chunk_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    insertChunk: db.prepare('INSERT INTO chunks (session_id, fid, n) VALUES (?, ?, ?)'),
    getFile: db.prepare(
      `SELECT fid, name, type, size, chunks, chunk_size AS chunkSize, status, manifest_sha256 AS manifest, error
       FROM files WHERE session_id = ? AND fid = ?`,
    ),
    listFiles: db.prepare(
      `SELECT fid, name, type, size, chunks, chunk_size AS chunkSize, status
       FROM files WHERE session_id = ? ORDER BY rowid`, // rowid = the order the sender listed them
    ),
    chunkReceived: db.prepare(
      "UPDATE chunks SET hash = ?, state = 'RECEIVED' WHERE session_id = ? AND fid = ? AND n = ?",
    ),
    getChunks: db.prepare('SELECT n, hash, state FROM chunks WHERE session_id = ? AND fid = ? ORDER BY n'),
    countChunks: db.prepare(
      'SELECT COUNT(*) AS c FROM chunks WHERE session_id = ? AND fid = ? AND state = ?',
    ),
    chunksVerified: db.prepare("UPDATE chunks SET state = 'VERIFIED' WHERE session_id = ? AND fid = ?"),
    listSessions: db.prepare('SELECT session_id AS sessionId, code, created_at AS createdAt FROM sessions'),
    expired: db.prepare('SELECT session_id AS sessionId FROM sessions WHERE created_at <= ?'),
    pendingChunks: db.prepare(
      "SELECT n FROM chunks WHERE session_id = ? AND fid = ? AND state = 'PENDING' ORDER BY n",
    ),
    resetAssembling: db.prepare("UPDATE files SET status = 'PENDING' WHERE status = 'ASSEMBLING'"),
    setStatus: db.prepare(
      `UPDATE files SET status = ?, error = ?, manifest_sha256 = COALESCE(?, manifest_sha256)
       WHERE session_id = ? AND fid = ?`,
    ),
  };

  const transaction = (fn) => {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    createSession(sessionId, code, files) {
      transaction(() => {
        q.insertSession.run(sessionId, code, Date.now());
        for (const f of files) {
          q.insertFile.run(sessionId, f.fid, f.name, f.type, f.size, f.chunks, f.chunkSize);
          for (let n = 0; n < f.chunks; n++) q.insertChunk.run(sessionId, f.fid, n);
        }
      });
    },
    getFile: (sessionId, fid) => q.getFile.get(sessionId, fid),
    listFiles: (sessionId) => q.listFiles.all(sessionId),
    markChunkReceived: (sessionId, fid, n, hash) => q.chunkReceived.run(hash, sessionId, fid, n),
    getChunks: (sessionId, fid) => q.getChunks.all(sessionId, fid),
    countChunks: (sessionId, fid, state) => q.countChunks.get(sessionId, fid, state).c,
    markChunksVerified: (sessionId, fid) => q.chunksVerified.run(sessionId, fid),
    setFileStatus(sessionId, fid, status, { error = null, manifest = null } = {}) {
      q.setStatus.run(status, error, manifest, sessionId, fid);
    },
    listSessions: () => q.listSessions.all(),
    expiredSessionIds: (createdBefore) => q.expired.all(createdBefore).map((r) => r.sessionId),
    pendingChunks: (sessionId, fid) => q.pendingChunks.all(sessionId, fid).map((r) => r.n),
    // An assembly interrupted by a restart is simply redone when the sender sends DONE again.
    resetAssembling: () => q.resetAssembling.run(),
    deleteSession(sessionId) {
      transaction(() => {
        for (const table of ['chunks', 'files', 'sessions']) {
          db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
        }
      });
    },
    close: () => db.close(),
  };
}
