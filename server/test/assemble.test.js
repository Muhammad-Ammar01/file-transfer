import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { setup, connect, fileMeta } from '../testutil/helpers.js';
import { SessionSender } from '../../client/src/sessionSender.js';
import { chunkFile, manifestHash } from '../../client/src/chunker.js';
import { encodeChunkFrame } from '../../client/src/protocol.js';

const readDb = (storageDir) => new DatabaseSync(path.join(storageDir, 'meta.db'), { readOnly: true });

// Sends every chunk of `data` as file f0 and waits for the ACKs. Returns the manifest hash.
async function sendAllChunks(ws, data, chunkSize) {
  const hashes = [];
  for await (const c of chunkFile(new File([data], 'x'), chunkSize)) {
    ws.send(encodeChunkFrame({ fid: 'f0', n: c.n, hash: c.hash }, c.bytes));
    assert.equal((await ws.next()).type, 'ACK');
    hashes.push(c.hash);
  }
  return manifestHash(hashes);
}

test('upload ends with the file READY, chunks VERIFIED, and the receiver notified', async () => {
  const { storageDir, url, cleanup } = await setup();
  const data = randomBytes(2500);
  const sender = new SessionSender(url, { WebSocketImpl: WebSocket, chunkSize: 1000 });
  await sender.connect();
  const { sessionId, code } = await sender.createSession([new File([data], 'pic.png', { type: 'image/png' })]);

  // Receiver joins while the file is still PENDING...
  const early = await connect(url);
  early.sendJson({ type: 'JOIN', code });
  assert.equal((await early.next()).files[0].status, 'PENDING');

  await sender.upload();

  // ...and is told when it becomes READY.
  let ready = await early.next();
  while (ready.type === 'PROGRESS') ready = await early.next(); // progress updates come first
  assert.deepEqual(ready, { type: 'READY', fid: 'f0', name: 'pic.png', size: 2500, mime: 'image/png' });

  // A receiver that joins afterwards sees READY straight away.
  const late = await connect(url);
  late.sendJson({ type: 'JOIN', code });
  const joined = await late.next();
  assert.equal(joined.files[0].status, 'READY');

  const db = readDb(storageDir);
  assert.equal(db.prepare('SELECT status FROM files WHERE session_id = ?').get(sessionId).status, 'READY');
  const states = db.prepare('SELECT DISTINCT state FROM chunks WHERE session_id = ?').all(sessionId);
  assert.deepEqual(states.map((s) => s.state), ['VERIFIED']);
  db.close();

  sender.close();
  early.close();
  late.close();
  await cleanup();
});

test('a wrong file hash in DONE fails the file and writes no output', async () => {
  const { storageDir, url, cleanup } = await setup();
  const ws = await connect(url);
  const data = randomBytes(2000);
  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 2000, 1000)] });
  const { sessionId } = await ws.next();
  await sendAllChunks(ws, data, 1000);

  ws.sendJson({ type: 'DONE', fid: 'f0', sha256: 'not-the-real-hash' });
  assert.equal((await ws.next()).code, 'MANIFEST_MISMATCH');
  await assert.rejects(fs.stat(path.join(storageDir, sessionId, 'f0', 'file')));
  await assert.rejects(fs.stat(path.join(storageDir, sessionId, 'f0', 'file.tmp')));

  const db = readDb(storageDir);
  const row = db.prepare('SELECT status, error FROM files WHERE session_id = ?').get(sessionId);
  assert.equal(row.status, 'FAILED');
  assert.match(row.error, /MANIFEST_MISMATCH/);
  db.close();

  // A failed file takes no more chunks.
  ws.send(encodeChunkFrame({ fid: 'f0', n: 0, hash: 'x' }, Buffer.from('a')));
  assert.equal((await ws.next()).code, 'FILE_CLOSED');

  ws.close();
  await cleanup();
});

test('a chunk that changes on disk before assembly is caught', async () => {
  const { storageDir, url, cleanup } = await setup();
  const ws = await connect(url);
  const data = randomBytes(2000);
  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 2000, 1000)] });
  const { sessionId } = await ws.next();
  const manifest = await sendAllChunks(ws, data, 1000);

  await fs.writeFile(path.join(storageDir, sessionId, 'f0', '0.part'), randomBytes(1000));
  ws.sendJson({ type: 'DONE', fid: 'f0', sha256: manifest });
  assert.equal((await ws.next()).code, 'CHUNK_CORRUPT');

  ws.close();
  await cleanup();
});

test('DONE with a missing chunk is retryable once the chunk arrives', async () => {
  const { url, cleanup } = await setup();
  const ws = await connect(url);
  const data = randomBytes(2000);
  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 2000, 1000)] });
  await ws.next();

  const chunks = [];
  for await (const c of chunkFile(new File([data], 'x'), 1000)) chunks.push(c);
  const manifest = await manifestHash(chunks.map((c) => c.hash));

  ws.send(encodeChunkFrame({ fid: 'f0', n: 0, hash: chunks[0].hash }, chunks[0].bytes));
  await ws.next(); // ACK
  ws.sendJson({ type: 'DONE', fid: 'f0', sha256: manifest });
  assert.equal((await ws.next()).code, 'MISSING_CHUNKS');

  ws.send(encodeChunkFrame({ fid: 'f0', n: 1, hash: chunks[1].hash }, chunks[1].bytes));
  await ws.next(); // ACK
  ws.sendJson({ type: 'DONE', fid: 'f0', sha256: manifest });
  assert.equal((await ws.next()).type, 'READY');

  ws.close();
  await cleanup();
});
