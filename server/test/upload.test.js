import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { setup, connect, fileMeta } from '../testutil/helpers.js';
import { SessionSender } from '../../client/src/sessionSender.js';
import { chunkFile, sha256Hex } from '../../client/src/chunker.js';
import { encodeChunkFrame } from '../../client/src/protocol.js';

test('uploads multiple files in chunks and stores them byte-for-byte', async () => {
  const { storageDir, url, cleanup } = await setup();
  const photo = randomBytes(4500); // 5 chunks, last one partial
  const doc = randomBytes(1000); // exactly 1 chunk
  const files = [
    new File([photo], 'photo.jpg', { type: 'image/jpeg' }),
    new File([doc], 'doc.pdf', { type: 'application/pdf' }),
    new File([Buffer.alloc(0)], 'empty.txt', { type: 'text/plain' }), // 0 chunks
  ];

  const progress = [];
  const sender = new SessionSender(url, {
    WebSocketImpl: WebSocket,
    chunkSize: 1000,
    windowSize: 2,
    onProgress: (p) => progress.push(p),
  });
  await sender.connect();
  const { sessionId, code } = await sender.createSession(files);
  assert.match(code, /^\d{6}$/);
  await sender.upload(); // resolves only after the server verified every file
  sender.close();

  // The server leaves one assembled file per fid and no leftover chunk files.
  const dir = (fid) => path.join(storageDir, sessionId, fid);
  assert.deepEqual(await fs.readFile(path.join(dir('f0'), 'file')), photo);
  assert.deepEqual(await fs.readFile(path.join(dir('f1'), 'file')), doc);
  assert.equal((await fs.readFile(path.join(dir('f2'), 'file'))).length, 0);
  assert.deepEqual(await fs.readdir(dir('f0')), ['file']);

  assert.equal(progress.filter((p) => p.fid === 'f0').length, 5);
  assert.equal(progress.filter((p) => p.fid === 'f2').length, 0);

  await cleanup();
});

test('a chunk with a wrong hash gets NACK and is not stored', async () => {
  const { storageDir, url, cleanup } = await setup();
  const ws = await connect(url);

  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 3, 3)] });
  const { sessionId } = await ws.next();

  const bytes = Buffer.from('abc');
  ws.send(encodeChunkFrame({ fid: 'f0', n: 0, hash: 'deadbeef' }, bytes));
  assert.equal((await ws.next()).type, 'NACK');
  await assert.rejects(fs.stat(path.join(storageDir, sessionId, 'f0', '0.part')));

  // Same chunk with the right hash is accepted (this is what a retry does).
  ws.send(encodeChunkFrame({ fid: 'f0', n: 0, hash: await sha256Hex(bytes) }, bytes));
  assert.equal((await ws.next()).type, 'ACK');

  ws.close();
  await cleanup();
});

test('rejects out-of-range chunks and DONE with chunks missing', async () => {
  const { url, cleanup } = await setup();
  const ws = await connect(url);

  ws.sendJson({ type: 'HELLO', files: [fileMeta('f0', 2000, 1000)] });
  await ws.next();

  ws.send(encodeChunkFrame({ fid: 'f0', n: 5, hash: 'x' }, Buffer.from('a')));
  assert.equal((await ws.next()).code, 'BAD_CHUNK_INDEX');

  ws.sendJson({ type: 'DONE', fid: 'f0', sha256: 'x' });
  assert.equal((await ws.next()).code, 'MISSING_CHUNKS');

  ws.close();
  await cleanup();
});

test('chunker splits and hashes correctly', async () => {
  const data = randomBytes(2500);
  const chunks = [];
  for await (const c of chunkFile(new File([data], 'x'), 1000)) chunks.push(c);
  assert.deepEqual(chunks.map((c) => c.bytes.length), [1000, 1000, 500]);
  assert.deepEqual(Buffer.concat(chunks.map((c) => c.bytes)), data);
  assert.equal(chunks[2].hash, await sha256Hex(data.subarray(2000)));
});
