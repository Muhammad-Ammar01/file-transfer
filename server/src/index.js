// C4 WS Gateway: accepts WebSocket connections and routes messages by type.
// C6 Frame Receiver: handles binary CHUNK frames from the sender (handleChunk).
// Also streams READY files to the receiver (handleGet) and serves the built client over HTTP.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  createSession, restoreSession, joinSession, resumeSession,
  findBySender, findByReceiver, handleDisconnect, send,
} from './sessions.js';
import { createStorage } from './storage.js';
import { openDb } from './db.js';
import { assembleFile, sha256Hex } from './assembler.js';
import { runCleanup, DEFAULT_TTL_MS } from './cleanup.js';
import { createStaticHandler } from './static.js';
import { encodeChunkFrame } from './frame.js';

const FID_RE = /^[A-Za-z0-9_-]{1,64}$/; // fid becomes a folder name, so keep it simple
const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = MAX_CHUNK_SIZE + 64 * 1024; // chunk + frame header
const MAX_CHUNKS_PER_FILE = 100_000;
const MAX_FILES = 10_000;
const MAX_NAME_LENGTH = 1024; // names can include folder paths, e.g. "Holiday/Day 1/IMG_001.jpg"
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Returns a normalized copy of the file list, or { error }.
function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return { error: 'files[] required' };
  if (files.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per session` };
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (!f || !FID_RE.test(f.fid ?? '')) return { error: 'each file needs a valid fid' };
    if (seen.has(f.fid)) return { error: `duplicate fid: ${f.fid}` };
    seen.add(f.fid);
    if (!Number.isSafeInteger(f.size) || f.size < 0) return { error: `bad size for ${f.fid}` };
    if (!Number.isInteger(f.chunkSize) || f.chunkSize < 1 || f.chunkSize > MAX_CHUNK_SIZE) {
      return { error: `bad chunkSize for ${f.fid}` };
    }
    if (f.chunks !== Math.ceil(f.size / f.chunkSize) || f.chunks > MAX_CHUNKS_PER_FILE) {
      return { error: `bad chunk count for ${f.fid}` };
    }
    out.push({
      fid: f.fid,
      name: String(f.name ?? '').slice(0, MAX_NAME_LENGTH),
      type: String(f.type ?? '').slice(0, 255),
      size: f.size,
      chunks: f.chunks,
      chunkSize: f.chunkSize,
    });
  }
  return { files: out };
}

// ---- sender side -------------------------------------------------------------------------

async function handleChunk(ws, buf, ctx) {
  const session = findBySender(ws);
  if (!session) return send(ws, 'ERROR', { code: 'NO_SESSION', msg: 'send HELLO first' });

  const headerLen = buf.length >= 4 ? buf.readUInt32BE(0) : 0;
  if (headerLen === 0 || 4 + headerLen > buf.length) {
    return send(ws, 'ERROR', { code: 'BAD_FRAME', msg: 'malformed chunk frame' });
  }
  let header;
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
  } catch {
    return send(ws, 'ERROR', { code: 'BAD_FRAME', msg: 'chunk header is not JSON' });
  }

  const { fid, n, hash } = header;
  const file = ctx.db.getFile(session.sessionId, fid);
  if (!file) return send(ws, 'ERROR', { code: 'UNKNOWN_FILE', msg: `unknown fid: ${fid}` });
  if (file.status !== 'PENDING') {
    return send(ws, 'ERROR', { code: 'FILE_CLOSED', msg: `${fid} is ${file.status}, no more chunks accepted` });
  }
  if (!Number.isInteger(n) || n < 0 || n >= file.chunks) {
    return send(ws, 'ERROR', { code: 'BAD_CHUNK_INDEX', msg: `chunk ${n} out of range for ${fid}` });
  }

  const bytes = buf.subarray(4 + headerLen);
  const actual = sha256Hex(bytes);
  if (actual !== hash) return send(ws, 'NACK', { fid, n, reason: 'HASH_MISMATCH' });

  await ctx.storage.writeChunk(session.sessionId, fid, n, bytes);
  ctx.db.markChunkReceived(session.sessionId, fid, n, actual);
  send(ws, 'ACK', { fid, n });
  send(session.receiver, 'PROGRESS', {
    fid,
    done: ctx.db.countChunks(session.sessionId, fid, 'RECEIVED'),
    total: file.chunks,
  });
}

// Goes to whoever is connected now, which after a RESUME is not the socket that sent DONE.
function announceReady(session, file) {
  send(session.sender, 'READY', { fid: file.fid });
  // "mime", not "type": send() spreads this next to the message's own "type" field.
  send(session.receiver, 'READY', { fid: file.fid, name: file.name, size: file.size, mime: file.type });
}

async function handleDone(ws, msg, ctx) {
  const session = findBySender(ws);
  if (!session) return send(ws, 'ERROR', { code: 'NO_SESSION', msg: 'send HELLO first' });

  const { sessionId } = session;
  const file = ctx.db.getFile(sessionId, msg.fid);
  if (!file) return send(ws, 'ERROR', { code: 'UNKNOWN_FILE', msg: `unknown fid: ${msg.fid}` });
  if (typeof msg.sha256 !== 'string') return send(ws, 'ERROR', { code: 'BAD_DONE', msg: 'sha256 required' });

  if (file.status === 'READY') return announceReady(session, file); // repeated DONE is harmless
  if (file.status === 'ASSEMBLING') return; // READY follows when the running assembly finishes
  if (file.status !== 'PENDING') {
    return send(ws, 'ERROR', { code: 'FILE_CLOSED', msg: `${msg.fid} is ${file.status}` });
  }
  if (ctx.db.countChunks(sessionId, msg.fid, 'RECEIVED') !== file.chunks) {
    return send(ws, 'ERROR', { code: 'MISSING_CHUNKS', msg: `${msg.fid} is incomplete` });
  }

  ctx.db.setFileStatus(sessionId, msg.fid, 'ASSEMBLING');
  const result = await assembleFile({
    storage: ctx.storage,
    db: ctx.db,
    sessionId,
    file,
    declaredManifest: msg.sha256,
  });
  if (!result.ok) return send(session.sender, 'ERROR', { code: result.code, msg: result.msg });
  return announceReady(session, file);
}

function handleResume(ws, msg, ctx) {
  const session = resumeSession(String(msg.sessionId ?? ''), ws);
  if (!session) return send(ws, 'ERROR', { code: 'NO_SUCH_SESSION', msg: 'unknown or expired session' });
  const files = ctx.db.listFiles(session.sessionId).map((f) => ({
    fid: f.fid,
    status: f.status,
    missing: f.status === 'PENDING' ? ctx.db.pendingChunks(session.sessionId, f.fid) : [],
  }));
  return send(ws, 'RESUMED', { sessionId: session.sessionId, code: session.code, files });
}

// ---- receiver side -----------------------------------------------------------------------

// Streams chunks [from..end] of a READY file, then END with the file's manifest hash.
async function handleGet(ws, msg, ctx) {
  const session = findByReceiver(ws);
  if (!session) return send(ws, 'ERROR', { code: 'NOT_JOINED', msg: 'JOIN first' });
  const { sessionId } = session;

  const file = ctx.db.getFile(sessionId, msg.fid);
  if (!file) return send(ws, 'ERROR', { code: 'UNKNOWN_FILE', msg: `unknown fid: ${msg.fid}` });
  if (file.status !== 'READY') return send(ws, 'ERROR', { code: 'NOT_READY', msg: `${msg.fid} is ${file.status}` });
  const from = msg.from ?? 0;
  if (!Number.isInteger(from) || from < 0 || from > file.chunks) {
    return send(ws, 'ERROR', { code: 'BAD_RANGE', msg: 'bad "from" chunk index' });
  }
  if (ws.streaming) return send(ws, 'ERROR', { code: 'BUSY', msg: 'a download is already running' });

  ws.streaming = true;
  const hashes = ctx.db.getChunks(sessionId, msg.fid).map((r) => r.hash);
  const handle = await ctx.storage.openFile(sessionId, msg.fid);
  try {
    for (let n = from; n < file.chunks; n++) {
      if (ws.readyState !== ws.OPEN) return;
      const position = n * file.chunkSize;
      const buf = Buffer.alloc(Math.min(file.chunkSize, file.size - position));
      await handle.read(buf, 0, buf.length, position);
      // Waiting for the send callback gives backpressure: the next chunk is read only once
      // this one has been flushed to the socket.
      await new Promise((resolve, reject) => {
        ws.send(encodeChunkFrame({ fid: msg.fid, n, hash: hashes[n] }, buf), (err) => (err ? reject(err) : resolve()));
      });
    }
    send(ws, 'END', { fid: msg.fid, sha256: file.manifest, chunks: file.chunks, size: file.size });
  } catch {
    // socket went away mid-stream; the receiver resumes with GET {from}
  } finally {
    ws.streaming = false;
    await handle.close();
  }
}

// ---- routing -----------------------------------------------------------------------------

async function handleMessage(ws, raw, isBinary, ctx) {
  if (isBinary) return handleChunk(ws, raw, ctx);

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return send(ws, 'ERROR', { code: 'BAD_JSON', msg: 'message must be JSON' });
  }

  switch (msg.type) {
    case 'HELLO': {
      if (findBySender(ws)) return send(ws, 'ERROR', { code: 'ALREADY_STARTED', msg: 'session already created' });
      const { files, error } = validateFiles(msg.files);
      if (error) return send(ws, 'ERROR', { code: 'BAD_HELLO', msg: error });
      const session = createSession(ws);
      ctx.db.createSession(session.sessionId, session.code, files);
      return send(ws, 'SESSION', { sessionId: session.sessionId, code: session.code });
    }
    case 'JOIN': {
      const session = joinSession(String(msg.code ?? ''), ws);
      if (!session) return send(ws, 'ERROR', { code: 'NO_SUCH_CODE', msg: 'unknown code' });
      // Status is included so a receiver that joins late sees which files are already READY.
      send(ws, 'JOINED', { sessionId: session.sessionId, files: ctx.db.listFiles(session.sessionId) });
      return send(session.sender, 'PEER_JOINED');
    }
    case 'RESUME':
      return handleResume(ws, msg, ctx);
    case 'DONE':
      return handleDone(ws, msg, ctx);
    case 'GET':
      return handleGet(ws, msg, ctx);
    default:
      return send(ws, 'ERROR', { code: 'UNKNOWN_TYPE', msg: `unknown type: ${msg.type}` });
  }
}

export function startServer(port = 8080, {
  storageDir = path.resolve('storage'),
  staticDir = path.resolve(HERE, '../../client/dist'),
  ttlMs = DEFAULT_TTL_MS,
  cleanupIntervalMs = 10 * 60 * 1000,
} = {}) {
  fs.mkdirSync(storageDir, { recursive: true });
  const ctx = { storage: createStorage(storageDir), db: openDb(path.join(storageDir, 'meta.db')) };

  ctx.db.resetAssembling();
  for (const row of ctx.db.listSessions()) restoreSession(row);

  const server = http.createServer(createStaticHandler(staticDir));
  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
  wss.on('connection', (ws) => {
    ws.on('message', (raw, isBinary) => {
      handleMessage(ws, raw, isBinary, ctx).catch((err) => {
        console.error('handler error:', err);
        send(ws, 'ERROR', { code: 'INTERNAL', msg: 'server error' });
      });
    });
    ws.on('close', () => handleDisconnect(ws));
  });

  const timer = setInterval(() => {
    runCleanup(ctx, ttlMs).catch((err) => console.error('cleanup error:', err));
  }, cleanupIntervalMs);
  timer.unref();

  server.listen(port);
  wss.httpServer = server;
  wss.ctx = ctx;
  wss.listening = once(server, 'listening');
  // Drops connections, stops listening, then closes the database.
  wss.shutdown = async () => {
    clearInterval(timer);
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ctx.db.close();
  };
  return wss;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const wss = startServer(port, { storageDir: process.env.STORAGE_DIR || path.resolve('storage') });
  await wss.listening;
  console.log(`File Transfer is running:\n  http://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${port}  (other devices on your network)`);
  }
  process.on('SIGINT', () => wss.shutdown().then(() => process.exit(0)));
}
