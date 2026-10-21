// Where downloaded bytes go. A sink has write(bytes) and close().

// Keeps the file in memory; fine for documents and photos, heavy for multi-GB videos.
export class MemorySink {
  kind = 'memory';
  chunks = [];
  write(bytes) {
    this.chunks.push(bytes);
  }
  async close() {}
  blob(type = 'application/octet-stream') {
    return new Blob(this.chunks, { type });
  }
}

// Writes straight to a file the user picks (Chrome/Edge on https:// or localhost): no memory limit.
class DiskSink {
  kind = 'disk';
  constructor(writable) {
    this.writable = writable;
  }
  write(bytes) {
    return this.writable.write(bytes);
  }
  close() {
    return this.writable.close();
  }
}

// Must be called straight from a click handler (the save dialog needs a user gesture).
export async function createSink(suggestedName) {
  if (typeof globalThis.showSaveFilePicker === 'function') {
    const handle = await globalThis.showSaveFilePicker({ suggestedName });
    return new DiskSink(await handle.createWritable());
  }
  return new MemorySink();
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
