'use strict';
// Byte sources for the readers. FileSource does range reads from disk, so big archives are never loaded whole.
// BufferSource wraps bytes already in memory (remote and virtual files, nested archives, unpacked .tar.gz).
const fs = require('fs');

class FileSource {
  constructor(file, size) { this.file = file; this.size = size; this.fh = null; }
  static async open(file) {
    const st = await fs.promises.stat(file);
    return new FileSource(file, st.size);
  }
  async read(offset, length) {
    const len = Math.max(0, Math.min(length, this.size - offset));
    const buf = new Uint8Array(len);
    if (!len) return buf;
    const fh = this.fh || (this.fh = await fs.promises.open(this.file, 'r'));
    let got = 0;
    while (got < len) {
      const r = await fh.read(buf, got, len - got, offset + got);
      if (!r.bytesRead) break;
      got += r.bytesRead;
    }
    return got === len ? buf : buf.subarray(0, got);
  }
  /** Reads the file in chunks, in order. fn(chunk) may return false to stop early. */
  async stream(fn, chunk = 1 << 20) {
    for (let off = 0; off < this.size; off += chunk) {
      if ((await fn(await this.read(off, chunk))) === false) return;
    }
  }
  async close() { const fh = this.fh; this.fh = null; if (fh) await fh.close().catch(() => {}); }
}

class BufferSource {
  constructor(bytes) { this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); this.size = this.bytes.length; }
  async read(offset, length) { return this.bytes.subarray(offset, Math.min(this.size, offset + length)); }
  async stream(fn, chunk = 1 << 20) {
    for (let off = 0; off < this.size; off += chunk) if ((await fn(this.bytes.subarray(off, off + chunk))) === false) return;
  }
  async close() {}
}

module.exports = { FileSource, BufferSource };
