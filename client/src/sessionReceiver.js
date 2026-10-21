// C13 Session Receiver: joins a session by code, then streams READY files down chunk by chunk.
// C14 (verifier.js) checks every chunk and the whole file. A dropped connection is resumed
// from the next missing chunk.
import { decodeChunkFrame } from './protocol.js';
import { verifyChunk, verifyFile } from './verifier.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connectionError = (msg) => Object.assign(new Error(msg), { connection: true });

export class SessionReceiver {
  constructor(url, {
    WebSocketImpl = globalThis.WebSocket,
    maxReconnects = 3,
    onEvent = () => {}, // READY, PROGRESS, PEER_LEFT, ...
  } = {}) {
    Object.assign(this, { url, WebSocketImpl, maxReconnects, onEvent });
    this.ws = null;
    this.code = null;
    this.pending = null; // the JOINED waiter
    this.stream = null; // the running download
  }

  connect() {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new this.WebSocketImpl(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      const current = (fn) => (...args) => (this.ws === ws ? fn(...args) : undefined);
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = current(() => {
        if (!opened) reject(connectionError(`could not connect to ${this.url}`));
      });
      ws.onclose = current(() => {
        if (!opened) reject(connectionError(`could not connect to ${this.url}`));
        this.#failAll(connectionError('connection closed'));
      });
      ws.onmessage = current((ev) => this.#onMessage(ev));
    });
  }

  // Resolves with { sessionId, files }; each file has fid, name, size, type, chunks, status.
  join(code) {
    this.code = code;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.ws.send(JSON.stringify({ type: 'JOIN', code }));
    });
  }

  close() {
    this.ws?.close();
  }

  // Downloads one READY file into `sink`, verifying as it goes. Resolves when the file is complete
  // and verified; rejects on a failed check or if reconnecting does not work.
  async download(file, sink, { onProgress = () => {} } = {}) {
    const hashes = [];
    let bytesReceived = 0;
    let end = null;

    for (let attempt = 0; ; attempt++) {
      try {
        end = await this.#stream(file.fid, hashes.length, async (chunk) => {
          await verifyChunk(chunk, hashes.length);
          await sink.write(chunk.bytes);
          hashes.push(chunk.hash);
          bytesReceived += chunk.bytes.length;
          onProgress({ fid: file.fid, done: hashes.length, total: file.chunks, bytes: bytesReceived });
        });
        break;
      } catch (err) {
        if (!err.connection || attempt >= this.maxReconnects) throw err;
        await sleep(100 * (attempt + 1));
        await this.connect();
        await this.join(this.code); // rebinds this socket as the session's receiver
      }
    }

    await verifyFile({ fid: file.fid, hashes, bytesReceived }, end);
    await sink.close();
  }

  // Sends GET and feeds chunks to onChunk in order. Resolves with the END message.
  #stream(fid, from, onChunk) {
    return new Promise((resolve, reject) => {
      const s = { fid, onChunk, resolve, reject, chain: Promise.resolve(), failed: false };
      s.fail = (err) => {
        if (s.failed) return;
        s.failed = true;
        reject(err);
      };
      this.stream = s;
      this.ws.send(JSON.stringify({ type: 'GET', fid, from }));
    }).finally(() => {
      this.stream = null;
    });
  }

  #onMessage(ev) {
    if (typeof ev.data !== 'string') {
      const s = this.stream;
      if (!s || s.failed) return;
      const chunk = decodeChunkFrame(ev.data);
      // Chunks are handled strictly in order even though frames can arrive faster than we verify.
      s.chain = s.chain.then(() => (s.failed ? undefined : s.onChunk(chunk))).catch((err) => s.fail(err));
      return;
    }

    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'JOINED':
        this.pending?.resolve({ sessionId: msg.sessionId, files: msg.files });
        this.pending = null;
        return;
      case 'END': {
        const s = this.stream;
        if (s) s.chain.then(() => !s.failed && s.resolve(msg));
        return;
      }
      case 'ERROR': {
        const err = new Error(`${msg.code}: ${msg.msg}`);
        if (this.pending) {
          this.pending.reject(err);
          this.pending = null;
        } else this.stream?.fail(err);
        return;
      }
      default:
        this.onEvent(msg);
    }
  }

  #failAll(err) {
    this.pending?.reject(err);
    this.pending = null;
    this.stream?.fail(err);
  }
}
