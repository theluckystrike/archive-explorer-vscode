'use strict';
// Our own TAR reader: v7, ustar, GNU long names (L, K) and pax headers (x). Base-256 sizes are supported.
const { checkEntryName, tooManyEntries, LimitError, fmtSize } = require('./limits');

class TarFormatError extends Error {}
const dec = new TextDecoder('utf-8');

function str(b, o, n) {
  let e = o;
  while (e < o + n && b[e] !== 0) e++;
  return dec.decode(b.subarray(o, e));
}

function num(b, o, n) {
  if (b[o] & 0x80) { // base-256 (GNU) for big values
    let v = b[o] & 0x7f;
    for (let i = 1; i < n; i++) v = v * 256 + b[o + i];
    return v;
  }
  const s = str(b, o, n).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) return NaN;
  return parseInt(s, 8);
}

function checksumOk(h) {
  const want = num(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return want === sum;
}

function isZeroBlock(h) { for (let i = 0; i < 512; i++) if (h[i]) return false; return true; }

/** True when the 512-byte block looks like a tar header (ustar magic or a valid checksum). */
function looksLikeTar(h) {
  if (!h || h.length < 512) return false;
  if (str(h, 257, 5) === 'ustar') return true;
  return !isZeroBlock(h) && checksumOk(h);
}

function parsePax(b) {
  const out = {};
  let p = 0;
  while (p < b.length) {
    let sp = p;
    while (sp < b.length && b[sp] !== 0x20) sp++;
    const len = parseInt(dec.decode(b.subarray(p, sp)), 10);
    if (!len || len < 0 || p + len > b.length) break;
    const rec = dec.decode(b.subarray(sp + 1, p + len - 1));
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

const KINDS = { '0': 'file', '\0': 'file', '': 'file', '7': 'file', '5': 'dir', '2': 'symlink', '1': 'hardlink', '3': 'other', '4': 'other', '6': 'other' };

/** Reads the entry list. opts: { maxEntries }. Data is never read here, only the headers. */
async function readTar(src, opts = {}) {
  const maxEntries = opts.maxEntries || 200000;
  const entries = [];
  const problems = [];
  let off = 0;
  let longName = null, longLink = null, pax = null;
  while (off + 512 <= src.size) {
    const h = await src.read(off, 512);
    if (isZeroBlock(h)) break;
    if (!checksumOk(h)) {
      if (off === 0) throw new TarFormatError('This is not a TAR archive: the first header has a bad checksum.');
      problems.push(`The header at byte ${off} is damaged. The list stops there.`);
      break;
    }
    const type = String.fromCharCode(h[156]);
    const size = num(h, 124, 12);
    if (!Number.isFinite(size) || size < 0) { problems.push(`The header at byte ${off} has a bad size. The list stops there.`); break; }
    const dataOff = off + 512;
    const next = dataOff + Math.ceil(size / 512) * 512;
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      if (size > 1024 * 1024) throw new LimitError(`An extended header at byte ${off} is ${fmtSize(size)}, which is too large.`, 'entries');
      const body = await src.read(dataOff, size);
      if (type === 'L') longName = str(body, 0, body.length);
      else if (type === 'K') longLink = str(body, 0, body.length);
      else if (type === 'x') pax = parsePax(body);
      off = next;
      continue;
    }
    if (entries.length >= maxEntries) throw tooManyEntries(entries.length + 1, maxEntries);
    let name = str(h, 0, 100);
    const magic = str(h, 257, 6);
    if (magic.startsWith('ustar')) { const prefix = str(h, 345, 155); if (prefix && magic === 'ustar') name = prefix + '/' + name; }
    if (longName != null) name = longName;
    if (pax && pax.path) name = pax.path;
    let link = str(h, 157, 100);
    if (longLink != null) link = longLink;
    if (pax && pax.linkpath) link = pax.linkpath;
    let realSize = size;
    if (pax && pax.size && /^\d+$/.test(pax.size)) realSize = parseInt(pax.size, 10);
    let mtime = num(h, 136, 12) * 1000;
    if (pax && pax.mtime && Number.isFinite(parseFloat(pax.mtime))) mtime = Math.round(parseFloat(pax.mtime) * 1000);
    let kind = KINDS[type] || (type === 'S' ? 'other' : 'file');
    if (kind === 'file' && name.endsWith('/')) kind = 'dir';
    const chk = checkEntryName(name);
    entries.push({
      path: chk.path, raw: name, unsafe: chk.unsafe, dir: kind === 'dir', kind, link: link || '',
      size: kind === 'file' ? realSize : 0, packed: null, mtime: Number.isFinite(mtime) ? mtime : 0,
      offset: dataOff, mode: num(h, 100, 8) || 0, encrypted: false, supported: kind === 'file' || kind === 'dir',
      methodName: type === 'S' ? 'GNU sparse' : '',
    });
    longName = null; longLink = null; pax = null;
    const realNext = dataOff + Math.ceil(realSize / 512) * 512;
    off = Math.max(next, realNext);
    if (dataOff + realSize > src.size) { problems.push(`"${chk.path}" runs past the end of the file. The archive is cut short.`); entries[entries.length - 1].supported = false; break; }
  }
  return { format: 'tar', entries, problems };
}

async function readTarEntry(src, entry, limit) {
  if (entry.dir) return new Uint8Array(0);
  if (!entry.supported) throw new TarFormatError(entry.kind === 'symlink' || entry.kind === 'hardlink'
    ? `"${entry.path}" is a link to "${entry.link}". Links are listed but not opened or extracted.`
    : `"${entry.path}" is a special entry (${entry.methodName || entry.kind}) that Archive Explorer cannot open.`);
  if (entry.size > limit) throw new LimitError(`"${entry.path}" is ${fmtSize(entry.size)}. The limit is ${fmtSize(limit)} (setting archiveExplorer.maxEntryMB).`, 'size');
  const data = await src.read(entry.offset, entry.size);
  if (data.length !== entry.size) throw new TarFormatError(`"${entry.path}" is cut short.`);
  return data.slice ? data.slice() : data;
}

module.exports = { readTar, readTarEntry, looksLikeTar, parsePax, TarFormatError };
