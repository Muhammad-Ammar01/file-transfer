import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/index.js';

// Starts a server on a random port with a throwaway storage folder.
// Pass an existing storageDir to start a "restarted" server on the same data.
export async function setup(existingDir) {
  const storageDir = existingDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'ft-test-')));
  const wss = startServer(0, { storageDir });
  await wss.listening;
  const url = `ws://localhost:${wss.address().port}`;
  const stop = () => wss.shutdown();
  const cleanup = async () => {
    await stop();
    await fs.rm(storageDir, { recursive: true, force: true });
  };
  return { wss, storageDir, url, stop, cleanup };
}

// Raw client with a message queue: `await ws.next()` returns the next JSON message,
// including ones that arrived before it was called.
export async function connect(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  ws.next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)));
  ws.sendJson = (obj) => ws.send(JSON.stringify(obj));
  await once(ws, 'open');
  return ws;
}

// A file entry for HELLO.
export const fileMeta = (fid, size, chunkSize, extra = {}) => ({
  fid,
  name: `${fid}.bin`,
  type: 'application/octet-stream',
  size,
  chunkSize,
  chunks: Math.ceil(size / chunkSize),
  ...extra,
});
