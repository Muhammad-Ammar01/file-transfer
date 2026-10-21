// C2 Chunker: splits a File/Blob into fixed-size chunks and hashes each one.
// Works in browsers and in Node 18+ (uses Blob.slice and Web Crypto).

import { sha256Bytes } from './sha256.js';

export const CHUNK_SIZE = 5 * 1024 * 1024;

export function chunkCount(size, chunkSize = CHUNK_SIZE) {
  return Math.ceil(size / chunkSize);
}

export async function sha256Hex(bytes) {
  // crypto.subtle only exists on https:// pages and localhost; elsewhere use the JS fallback.
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    : sha256Bytes(bytes);
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Yields { n, bytes, hash } one chunk at a time, so a large video is never fully in memory.
export async function* chunkFile(file, chunkSize = CHUNK_SIZE) {
  const total = chunkCount(file.size, chunkSize);
  for (let n = 0; n < total; n++) {
    const bytes = new Uint8Array(await file.slice(n * chunkSize, (n + 1) * chunkSize).arrayBuffer());
    yield { n, bytes, hash: await sha256Hex(bytes) };
  }
}

// File-level fingerprint: SHA-256 over the concatenated chunk hashes. This avoids needing an
// incremental SHA-256 in the browser, and the receiver can recompute it from the same chunks.
export function manifestHash(chunkHashes) {
  return sha256Hex(new TextEncoder().encode(chunkHashes.join('')));
}
