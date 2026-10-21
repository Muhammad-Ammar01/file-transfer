// C9 File Storage: local disk for now (swap for S3 later behind the same interface).
import fs from 'node:fs/promises';
import path from 'node:path';

export function createStorage(root) {
  const dirOf = (sessionId, fid) => path.join(root, sessionId, fid);
  const chunkPath = (sessionId, fid, n) => path.join(dirOf(sessionId, fid), `${n}.part`);
  const filePath = (sessionId, fid) => path.join(dirOf(sessionId, fid), 'file');

  return {
    root,
    chunkPath,
    filePath,
    ensureDir: (sessionId, fid) => fs.mkdir(dirOf(sessionId, fid), { recursive: true }),
    async writeChunk(sessionId, fid, n, bytes) {
      await fs.mkdir(dirOf(sessionId, fid), { recursive: true });
      await fs.writeFile(chunkPath(sessionId, fid, n), bytes);
    },
    readChunk: (sessionId, fid, n) => fs.readFile(chunkPath(sessionId, fid, n)),
    openFile: (sessionId, fid) => fs.open(filePath(sessionId, fid), 'r'),
    removeSession: (sessionId) => fs.rm(path.join(root, sessionId), { recursive: true, force: true }),
    removeChunk: (sessionId, fid, n) => fs.rm(chunkPath(sessionId, fid, n), { force: true }),
  };
}
