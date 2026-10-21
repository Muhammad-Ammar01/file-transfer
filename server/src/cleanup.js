// C11 Cleanup Job: removes sessions (rows, files on disk, in-memory entry) older than the TTL.
import { removeSession } from './sessions.js';

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// Returns how many sessions were removed.
export async function runCleanup({ db, storage }, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  const ids = db.expiredSessionIds(now - ttlMs);
  for (const sessionId of ids) {
    removeSession(sessionId);
    await storage.removeSession(sessionId);
    db.deleteSession(sessionId);
  }
  return ids.length;
}
