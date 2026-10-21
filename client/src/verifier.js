// C14 Verifier: the receiver's end-to-end checks against what the sender declared.
import { sha256Hex, manifestHash } from './chunker.js';

export async function verifyChunk({ fid, n, hash, bytes }, expectedN) {
  if (n !== expectedN) throw new Error(`${fid}: expected chunk ${expectedN}, got ${n}`);
  if ((await sha256Hex(bytes)) !== hash) throw new Error(`${fid}: chunk ${n} failed its hash check`);
}

// `hashes` are the chunk hashes in order; `end` is the server's END message.
export async function verifyFile({ fid, hashes, bytesReceived }, end) {
  if (hashes.length !== end.chunks) throw new Error(`${fid}: got ${hashes.length} of ${end.chunks} chunks`);
  if (bytesReceived !== end.size) throw new Error(`${fid}: got ${bytesReceived} of ${end.size} bytes`);
  if ((await manifestHash(hashes)) !== end.sha256) throw new Error(`${fid}: file hash does not match the sender's`);
}
