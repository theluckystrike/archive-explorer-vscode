'use strict';
// Our own ZIP central directory reader (ZIP, ZIP64, JAR, VSIX and other ZIP-based files). It reads only the
// end of the file and the central directory; an entry's data is read when that entry is opened.
const { checkEntryName, tooManyEntries, LimitError, fmtSize } = require('./limits');
const { inflateBounded } = require('./inflate');
const { crc32 } = require('./crc32');

const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
const METHODS = { 0: 'Stored', 8: 'Deflate', 9: 'Deflate64', 12: 'BZIP2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 98: 'PPMd', 99: 'AES' };

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');

function decodeName(bytes, isUtf8) {
  if (isUtf8) return utf8Loose.decode(bytes);
  let ascii = true;
  for (const b of bytes) if (b > 0x7f) { ascii = false; break; }
  if (ascii) return String.fromCharCode(...bytes);
  try { return utf8.decode(bytes); } catch { /* not UTF-8: use the old DOS code page */ }
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
  return s;
}

function dosTime(time, date) {
  if (!date) return 0;
  const d = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;

class ZipFormatError extends Error {}

async function findEnd(src) {
  const tail = Math.min(src.size, 22 + 65535 + 20);
  const start = src.size - tail;
  const b = await src.read(start, tail);
  for (let i = b.length - 22; i >= 0; i--) {
    if (u32(b, i) === SIG_EOCD) {
      const commentLen = u16(b, i + 20);
      if (i + 22 + commentLen > b.length) continue;
      return { pos: start + i, b, i };
    }
  }
  return null;
}

/**
 * Reads the entry list. opts: { maxEntries }. Returns { format, zip64, comment, entries, problems, prefix }.
 */
async function readZip(src, opts = {}) {
  const maxEntries = opts.maxEntries || 200000;
  if (src.size < 22) throw new ZipFormatError('This file is too small to be a ZIP archive.');
  const end = await findEnd(src);
  if (!end) throw new ZipFormatError('This is not a ZIP archive: the end-of-archive record is missing. The file may be cut short.');
  const { b, i } = end;
  let count = u16(b, i + 10), cdSize = u32(b, i + 12), cdOffset = u32(b, i + 16);
  const comment = decodeName(b.subarray(i + 22, i + 22 + u16(b, i + 20)), true);
  let zip64 = false;
  if (end.pos >= 20) {
    const loc = await src.read(end.pos - 20, 20);
    if (u32(loc, 0) === SIG_Z64_LOC) {
      const recOff = u64(loc, 8);
      const rec = await src.read(recOff, 56);
      if (rec.length === 56 && u32(rec, 0) === SIG_Z64_EOCD) {
        zip64 = true;
        count = u64(rec, 32); cdSize = u64(rec, 40); cdOffset = u64(rec, 48);
      }
    }
  }
  if (count > maxEntries) throw tooManyEntries(count, maxEntries);
  // Self-extracting archives and files with data in front: the real offsets are shifted by "prefix".
  const cdEnd = zip64 ? end.pos - 20 - 56 : end.pos;
  let prefix = 0;
  if (!zip64 && cdOffset + cdSize < cdEnd && count > 0) prefix = cdEnd - (cdOffset + cdSize);
  if (cdSize > 512 * 1024 * 1024) throw new LimitError(`The central directory is ${fmtSize(cdSize)}, which is too large to read.`, 'entries');
  const cd = await src.read(cdOffset + prefix, cdSize);
  const entries = [];
  const problems = [];
  let p = 0;
  for (let n = 0; n < count || (count === 0xffff && p < cd.length); n++) {
    if (p + 46 > cd.length || u32(cd, p) !== SIG_CEN) {
      if (n < count) problems.push(`The central directory ends after ${n} of ${count} entries. The archive may be damaged.`);
      break;
    }
    if (entries.length >= maxEntries) throw tooManyEntries(entries.length + 1, maxEntries);
    const madeBy = u16(cd, p + 4), flags = u16(cd, p + 8), method = u16(cd, p + 10);
    const time = u16(cd, p + 12), date = u16(cd, p + 14), crc = u32(cd, p + 16);
    let packed = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const extAttr = u32(cd, p + 38);
    let offset = u32(cd, p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    let raw = decodeName(nameBytes, (flags & 0x800) !== 0);
    let mtime = dosTime(time, date);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = u16(extra, e), len = u16(extra, e + 2), d = extra.subarray(e + 4, e + 4 + len);
      if (id === 0x0001) {
        let q = 0;
        if (size === 0xffffffff && q + 8 <= d.length) { size = u64(d, q); q += 8; }
        if (packed === 0xffffffff && q + 8 <= d.length) { packed = u64(d, q); q += 8; }
        if (offset === 0xffffffff && q + 8 <= d.length) { offset = u64(d, q); q += 8; }
        zip64 = true;
      } else if (id === 0x7075 && len > 5 && d[0] === 1) {
        raw = utf8Loose.decode(d.subarray(5));
      } else if (id === 0x5455 && len >= 5 && (d[0] & 1)) {
        mtime = u32(d, 1) * 1000;
      }
      e += 4 + len;
    }
    const host = madeBy >> 8;
    const mode = host === 3 ? extAttr >>> 16 : 0;
    const isDir = raw.endsWith('/') || raw.endsWith('\\') || (host === 0 && (extAttr & 0x10) !== 0 && size === 0) || (mode & 0xf000) === 0x4000;
    const isLink = (mode & 0xf000) === 0xa000;
    const chk = checkEntryName(raw);
    entries.push({
      path: chk.path, raw, unsafe: chk.unsafe, dir: isDir, kind: isDir ? 'dir' : isLink ? 'symlink' : 'file',
      size, packed, method, methodName: METHODS[method] || `method ${method}`, crc, mtime,
      encrypted: (flags & 1) !== 0, flags, offset: offset + prefix, mode,
      supported: isDir || method === 0 || method === 8,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { format: 'zip', zip64, comment, entries, problems, prefix };
}

/** Reads and unpacks one entry. limit = max bytes to produce. Checks the CRC. */
async function readZipEntry(src, entry, limit) {
  if (entry.dir) return new Uint8Array(0);
  if (entry.encrypted) throw new ZipFormatError(`"${entry.path}" is encrypted. Archive Explorer does not open password-protected entries.`);
  if (!entry.supported) throw new ZipFormatError(`"${entry.path}" uses ${entry.methodName} compression, which Archive Explorer cannot unpack. Stored and Deflate are supported.`);
  if (entry.size > limit) throw new LimitError(`"${entry.path}" is ${fmtSize(entry.size)} unpacked. The limit is ${fmtSize(limit)} (setting archiveExplorer.maxEntryMB).`, 'size');
  const h = await src.read(entry.offset, 30);
  if (h.length < 30 || u32(h, 0) !== SIG_LOC) throw new ZipFormatError(`The local header of "${entry.path}" is missing. The archive may be damaged.`);
  const start = entry.offset + 30 + u16(h, 26) + u16(h, 28);
  if (start + entry.packed > src.size) throw new ZipFormatError(`"${entry.path}" runs past the end of the file. The archive is cut short.`);
  const data = await src.read(start, entry.packed);
  let out;
  const over = () => `"${entry.path}" unpacks to more than the ${fmtSize(entry.size)} its header says. It was stopped as a possible zip bomb.`;
  if (entry.method === 0) {
    if (data.length !== entry.size) throw new ZipFormatError(`"${entry.path}" has a stored size that does not match its header.`);
    out = data;
  } else {
    out = inflateBounded(data, entry.size, over);
    if (out.length !== entry.size) throw new ZipFormatError(`"${entry.path}" unpacked to ${out.length} bytes, but its header says ${entry.size}. The entry is damaged.`);
  }
  if (crc32(out) !== entry.crc) throw new ZipFormatError(`"${entry.path}" failed its CRC check. The entry is damaged.`);
  return out;
}

module.exports = { readZip, readZipEntry, decodeName, dosTime, ZipFormatError, METHODS };
