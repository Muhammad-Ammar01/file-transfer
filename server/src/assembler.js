// C7 Assembler + Verifier: joins stored chunks into one file and verifies it.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Must match manifestHash() in client/src/chunker.js.
export const manifestHash = (chunkHashes) => sha256Hex(Buffer.from(chunkHashes.join(''), 'utf8'));

class AssembleError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

// Returns { ok: true } or { ok: false, code, msg }.
// On success the file is READY and its .part files are deleted; on failure it is FAILED
// and the parts are kept.
export async function assembleFile({ storage, db, sessionId, file, declaredManifest }) {
  const { fid } = file;
  const target = storage.filePath(sessionId, fid);
  const tmp = `${target}.tmp`;
  let handle;

  try {
    const rows = db.getChunks(sessionId, fid);
    if (rows.length !== file.chunks || rows.some((r) => r.state !== 'RECEIVED')) {
      throw new AssembleError('MISSING_CHUNKS', `${fid} is incomplete`);
    }

    await storage.ensureDir(sessionId, fid);
    handle = await fs.open(tmp, 'w');
    const hashes = [];
    let written = 0;
    for (const row of rows) {
      const bytes = await storage.readChunk(sessionId, fid, row.n);
      const hash = sha256Hex(bytes);
      if (hash !== row.hash) {
        throw new AssembleError('CHUNK_CORRUPT', `chunk ${row.n} of ${fid} changed on disk`);
      }
      hashes.push(hash);
      await handle.write(bytes);
      written += bytes.length;
    }
    await handle.close();
    handle = null;

    if (written !== file.size) {
      throw new AssembleError('SIZE_MISMATCH', `${fid}: expected ${file.size} bytes, got ${written}`);
    }
    if (manifestHash(hashes) !== declaredManifest) {
      throw new AssembleError('MANIFEST_MISMATCH', `${fid}: file hash does not match the sender's`);
    }

    await fs.rename(tmp, target);
    db.markChunksVerified(sessionId, fid);
    db.setFileStatus(sessionId, fid, 'READY', { manifest: declaredManifest });
    await Promise.all(rows.map((r) => storage.removeChunk(sessionId, fid, r.n)));
    return { ok: true };
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    const code = err instanceof AssembleError ? err.code : 'INTERNAL';
    const msg = err instanceof AssembleError ? err.message : 'assembly failed';
    if (code === 'INTERNAL') console.error('assembly error:', err);
    // An incomplete file can still be fixed by sending the missing chunks; anything else is final.
    if (code === 'MISSING_CHUNKS') db.setFileStatus(sessionId, fid, 'PENDING');
    else db.setFileStatus(sessionId, fid, 'FAILED', { error: `${code}: ${msg}` });
    return { ok: false, code, msg };
  }
}
