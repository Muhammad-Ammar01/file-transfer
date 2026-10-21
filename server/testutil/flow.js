// Shared helpers for tests that run a full sender -> server -> receiver flow.
import WebSocket from 'ws';
import { SessionSender } from '../../client/src/sessionSender.js';
import { SessionReceiver } from '../../client/src/sessionReceiver.js';
import { MemorySink } from '../../client/src/sinks.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for condition');
}

export const toFile = (bytes, name = 'x.bin', type = 'application/octet-stream') => new File([bytes], name, { type });

// Uploads `files` completely; returns { sessionId, code }.
export async function uploadAll(url, files, options = {}) {
  const sender = new SessionSender(url, { WebSocketImpl: WebSocket, chunkSize: 1000, ...options });
  await sender.connect();
  const session = await sender.createSession(files);
  await sender.upload();
  sender.close();
  return session;
}

export async function joinAs(url, code, options = {}) {
  const receiver = new SessionReceiver(url, { WebSocketImpl: WebSocket, ...options });
  await receiver.connect();
  const joined = await receiver.join(code);
  return { receiver, files: joined.files };
}

export async function downloadBytes(receiver, file, options) {
  const sink = new MemorySink();
  await receiver.download(file, sink, options);
  return Buffer.concat(sink.chunks);
}
