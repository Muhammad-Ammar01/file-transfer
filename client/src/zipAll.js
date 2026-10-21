// "Download all": packs files into one ZIP while they download, keeping folder paths.
// Files are stored, not compressed: photos and videos are already compressed, so this is fast.
import { Zip, ZipPassThrough } from 'fflate';

// Plain ZIP (no ZIP64) cannot hold more than 4 GB.
export const MAX_ZIP_BYTES = 4 * 1024 ** 3 - 1;

// Turns a sender-supplied name into a safe path inside the ZIP: no "..", no leading "/",
// so unzipping can never write outside the target folder.
export function safeZipPath(name, fallback = 'file') {
  const parts = String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/') || fallback;
}

export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.writes = Promise.resolve(); // keeps sink writes in order
    this.error = null;
    this.paths = new Set();
    this.zip = new Zip((err, data) => {
      if (err) this.error = err;
      else this.writes = this.writes.then(() => sink.write(data));
    });
  }

  // Returns a sink (write/close) for one file inside the ZIP.
  entry(name) {
    const path = this.#uniquePath(safeZipPath(name));
    const file = new ZipPassThrough(path);
    this.zip.add(file);
    return {
      write: async (bytes) => {
        file.push(bytes);
        await this.writes; // backpressure: wait until the sink has taken the bytes
      },
      close: async () => {
        file.push(new Uint8Array(0), true);
        await this.writes;
      },
    };
  }

  async finish() {
    this.zip.end();
    await this.writes;
    if (this.error) throw this.error;
    await this.sink.close();
  }

  // Two files with the same name get "name (2).ext".
  #uniquePath(path) {
    const dot = path.lastIndexOf('.');
    const hasExt = dot > path.lastIndexOf('/') + 1; // ".hidden" files have no extension
    let candidate = path;
    for (let i = 2; this.paths.has(candidate); i++) {
      candidate = hasExt ? `${path.slice(0, dot)} (${i})${path.slice(dot)}` : `${path} (${i})`;
    }
    this.paths.add(candidate);
    return candidate;
  }
}
