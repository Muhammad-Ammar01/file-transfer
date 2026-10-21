// Binary CHUNK frame: [uint32 BE header length][JSON header][chunk bytes]
// Header is { fid, n, hash }. Everything else in the protocol is a JSON text message.

export function encodeChunkFrame(header, bytes) {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + head.length + bytes.length);
  new DataView(frame.buffer).setUint32(0, head.length);
  frame.set(head, 4);
  frame.set(bytes, 4 + head.length);
  return frame;
}

// Takes an ArrayBuffer, returns { fid, n, hash, bytes }.
export function decodeChunkFrame(buffer) {
  const headLen = new DataView(buffer).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headLen)));
  return { ...header, bytes: new Uint8Array(buffer, 4 + headLen) };
}
