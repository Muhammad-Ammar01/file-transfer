// Binary CHUNK frame: [uint32 BE header length][JSON header][chunk bytes]
// (same layout as client/src/protocol.js)
export function encodeChunkFrame(header, bytes) {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(head.length);
  return Buffer.concat([prefix, head, bytes]);
}
