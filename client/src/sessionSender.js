// C3 Session Sender: opens the WebSocket session and uploads files chunk by chunk.
// If the connection drops, upload() reconnects with RESUME and sends only the missing chunks.
import { CHUNK_SIZE, chunkCount, chunkFile, manifestHash } from './chunker.js';
import { encodeChunkFrame } from './protocol.js';
import { fileLabel } from './format.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connectionError = (msg) => Object.assign(new Error(msg), { connection: true });

export class SessionSender {
  // WebSocketImpl is injectable so the same class runs in Node tests (with the `ws` package).
  constructor(url, {
    WebSocketImpl = globalThis.WebSocket,
    windowSize = 4, // chunks in flight at once
    maxRetries = 3, // resends after a NACK
    maxReconnects = 3,
    chunkSize = CHUNK_SIZE,
    onProgress = () => {},
    onEvent = () => {}, // PEER_JOINED, PEER_LEFT, ...
  } = {}) {
    Object.assign(this, { url, WebSocketImpl, windowSize, maxRetries, maxReconnects, chunkSize, onProgress, onEvent });
    this.ws = null;
    this.entries = [];
    this.sessionId = null;
    this.code = null;
    this.plan = null; // per-file { status, missing } from the last RESUMED
    this.needReconnect = false;
    this.error = null;
    this.waiters = new Map(); // key -> resolve
  }

  connect() {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new this.WebSocketImpl(this.url);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      // A socket we already replaced must not fail the new one when it finally closes.
      const current = (fn) => (...args) => (this.ws === ws ? fn(...args) : undefined);
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = current(() => {
        if (opened) this.#fail(connectionError('connection error'));
        else reject(connectionError(`could not connect to ${this.url}`));
      });
      ws.onclose = current(() => {
        if (!opened) reject(connectionError(`could not connect to ${this.url}`));
        this.#fail(connectionError('connection closed'));
      });
      ws.onmessage = current((ev) => this.#onMessage(ev));
    });
  }

  async createSession(files) {
    this.entries = files.map((file, i) => ({ file, fid: `f${i}` }));
    const wait = this.#wait('SESSION');
    this.#sendJson({
      type: 'HELLO',
      files: this.entries.map(({ file, fid }) => ({
        fid,
        name: fileLabel(file),
        size: file.size,
        type: file.type,
        chunkSize: this.chunkSize,
        chunks: chunkCount(file.size, this.chunkSize),
      })),
    });
    const reply = await wait;
    if (this.error) throw this.error;
    this.sessionId = reply.sessionId;
    this.code = reply.code;
    return { sessionId: reply.sessionId, code: reply.code };
  }

  // Continue a session from a fresh SessionSender (e.g. after a page reload). `files` must be the
  // same files in the same order as when the session was created.
  useExistingSession(sessionId, files) {
    this.sessionId = sessionId;
    this.entries = files.map((file, i) => ({ file, fid: `f${i}` }));
    this.needReconnect = true;
  }

  async upload() {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.needReconnect) await this.#reconnect();
        await this.#uploadAll();
        return;
      } catch (err) {
        if (!err.connection || attempt >= this.maxReconnects) throw err;
        this.needReconnect = true;
        await sleep(100 * (attempt + 1));
      }
    }
  }

  close() {
    this.ws?.close();
  }

  async #reconnect() {
    this.error = null;
    this.waiters.clear();
    this.ws?.close?.();
    await this.connect();
    // A file the server was still assembling when we dropped is READY a moment later: ask again.
    for (;;) {
      const wait = this.#wait('RESUMED');
      this.#sendJson({ type: 'RESUME', sessionId: this.sessionId });
      const reply = await wait;
      if (this.error) throw this.error;
      this.code = reply.code;
      this.plan = new Map(reply.files.map((f) => [f.fid, { status: f.status, missing: new Set(f.missing) }]));
      if (![...this.plan.values()].some((p) => p.status === 'ASSEMBLING')) break;
      await sleep(300);
    }
    this.needReconnect = false;
  }

  async #uploadAll() {
    for (const entry of this.entries) {
      const plan = this.plan?.get(entry.fid);
      if (plan?.status === 'READY') continue;
      if (plan?.status === 'FAILED') throw new Error(`${entry.fid} failed on the server`);
      await this.#uploadFile(entry, plan);
    }
  }

  async #uploadFile({ file, fid }, plan) {
    const total = chunkCount(file.size, this.chunkSize);
    const alreadyThere = (n) => plan?.status === 'PENDING' && !plan.missing.has(n);
    const hashes = [];
    const pending = new Set();
    let done = 0;

    for await (const chunk of chunkFile(file, this.chunkSize)) {
      if (this.error) break;
      hashes.push(chunk.hash); // every chunk is hashed, even skipped ones: DONE needs the full list
      if (alreadyThere(chunk.n)) {
        this.onProgress({ fid, done: ++done, total });
        continue;
      }
      while (pending.size >= this.windowSize) await Promise.race(pending);
      if (this.error) break;
      const p = this.#sendChunk(fid, chunk).then(() => {
        pending.delete(p);
        if (!this.error) this.onProgress({ fid, done: ++done, total });
      });
      pending.add(p);
    }
    await Promise.all(pending);
    if (this.error) throw this.error;

    // The server replies READY once it has assembled the file and the hashes match.
    const ready = this.#wait(`ready:${fid}`);
    this.#sendJson({ type: 'DONE', fid, sha256: await manifestHash(hashes) });
    await ready;
    if (this.error) throw this.error;
  }

  // Never rejects: failures go through #fail so the window loop can stop cleanly.
  async #sendChunk(fid, chunk) {
    const frame = encodeChunkFrame({ fid, n: chunk.n, hash: chunk.hash }, chunk.bytes);
    const key = `chunk:${fid}:${chunk.n}`;
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const reply = this.#wait(key);
        this.ws.send(frame);
        const msg = await reply;
        if (this.error || msg?.type === 'ACK') return;
      }
      this.#fail(new Error(`chunk ${chunk.n} of ${fid} rejected after ${this.maxRetries} retries`));
    } catch (err) {
      this.#fail(connectionError(err.message));
    }
  }

  #sendJson(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  #wait(key) {
    return new Promise((resolve) => this.waiters.set(key, resolve));
  }

  #resolve(key, msg) {
    const resolve = this.waiters.get(key);
    if (resolve) {
      this.waiters.delete(key);
      resolve(msg);
    }
  }

  #onMessage(ev) {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'SESSION':
      case 'RESUMED':
        return this.#resolve(msg.type, msg);
      case 'ACK':
      case 'NACK':
        return this.#resolve(`chunk:${msg.fid}:${msg.n}`, msg);
      case 'READY':
        return this.#resolve(`ready:${msg.fid}`, msg);
      case 'ERROR':
        return this.#fail(new Error(`${msg.code}: ${msg.msg}`));
      default:
        return this.onEvent(msg);
    }
  }

  // First error wins; wake everything that is waiting so the upload loop can exit.
  #fail(err) {
    if (!this.error) this.error = err;
    for (const key of [...this.waiters.keys()]) this.#resolve(key, null);
  }
}
