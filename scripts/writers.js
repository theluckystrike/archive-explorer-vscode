'use strict';
// Small ZIP and TAR writers for the sample archives and the tests. Not shipped in the VSIX.
// They can write things normal tools refuse to write (zip-slip names, ZIP64 records, lying sizes) so the
// reader's safety checks can be tested.
const { deflateSync, gzipSync } = require('fflate');
const { crc32 } = require('../src/core/crc32');

const enc = new TextEncoder();
const bytes = (d) => (typeof d === 'string' ? enc.encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

function le(n, size) {
  const b = new Uint8Array(size);
  let v = n;
  for (let i = 0; i < size; i++) { b[i] = v % 256; v = Math.floor(v / 256); }
  return b;
}
function cat(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function dos(ms) {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * entries: [{ name, data?, method?: 0|8, dir?, mtime?, unixMode?, encrypted?, declaredSize?, extTime? }]
 * opts: { zip64?: bool, prefix?: Uint8Array (bytes before the archive), comment?: string, cp437?: bool }
 */
function writeZip(entries, opts = {}) {
  const parts = [];
  const cen = [];
  let off = opts.prefix ? opts.prefix.length : 0;
  if (opts.prefix) parts.push(opts.prefix);
  const z64 = !!opts.zip64;
  for (const e of entries) {
    const name = e.rawName || bytes(e.name + (e.dir && !e.name.endsWith('/') ? '/' : ''));
    const data = e.dir ? new Uint8Array(0) : bytes(e.data || '');
    const method = e.dir ? 0 : (e.method ?? 8);
    const body = method === 8 ? deflateSync(data, { level: 9 }) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    const { time, date } = dos(e.mtime ?? Date.UTC(2026, 10, 6, 10, 30));
    const flags = (e.encrypted ? 1 : 0) | (opts.cp437 ? 0 : 0x800);
    const x64 = z64 ? cat([le(1, 2), le(24, 2), le(size, 8), le(body.length, 8), le(off, 8)]) : new Uint8Array(0);
    const xt = e.extTime ? cat([le(0x5455, 2), le(5, 2), new Uint8Array([1]), le(Math.floor(e.extTime / 1000), 4)]) : new Uint8Array(0);
    const extra = cat([x64, xt]);
    const lh = cat([le(0x04034b50, 4), le(z64 ? 45 : 20, 2), le(flags, 2), le(method, 2), le(time, 2), le(date, 2), le(crc, 4),
      le(z64 ? 0xffffffff : body.length, 4), le(z64 ? 0xffffffff : size, 4), le(name.length, 2), le(extra.length, 2), name, extra]);
    const madeBy = e.unixMode != null ? (3 << 8) | 20 : 20;
    const ext = e.unixMode != null ? (e.unixMode << 16) >>> 0 : (e.dir ? 0x10 : 0);
    cen.push(cat([le(0x02014b50, 4), le(madeBy, 2), le(z64 ? 45 : 20, 2), le(flags, 2), le(method, 2), le(time, 2), le(date, 2), le(crc, 4),
      le(z64 ? 0xffffffff : body.length, 4), le(z64 ? 0xffffffff : size, 4), le(name.length, 2), le(extra.length, 2), le(0, 2), le(0, 2), le(0, 2),
      le(ext, 4), le(z64 ? 0xffffffff : off, 4), name, extra]));
    parts.push(lh, body);
    off += lh.length + body.length;
  }
  const cd = cat(cen);
  const cdOff = off;
  parts.push(cd);
  const comment = bytes(opts.comment || '');
  if (z64) {
    const rec = cat([le(0x06064b50, 4), le(44, 8), le(45, 2), le(45, 2), le(0, 4), le(0, 4), le(entries.length, 8), le(entries.length, 8), le(cd.length, 8), le(cdOff, 8)]);
    const loc = cat([le(0x07064b50, 4), le(0, 4), le(cdOff + cd.length, 8), le(1, 4)]);
    parts.push(rec, loc);
  }
  parts.push(cat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(z64 ? 0xffff : entries.length, 2), le(z64 ? 0xffff : entries.length, 2),
    le(z64 ? 0xffffffff : cd.length, 4), le(z64 ? 0xffffffff : cdOff, 4), le(comment.length, 2), comment]));
  return cat(parts);
}

function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }

function tarHeader(name, size, type, opts = {}) {
  const h = new Uint8Array(512);
  const put = (s, o, n) => { const b = bytes(s); h.set(b.subarray(0, n), o); };
  put(name, 0, 100);
  put(octal(opts.mode ?? (type === '5' ? 0o755 : 0o644), 8), 100, 8);
  put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor((opts.mtime ?? Date.UTC(2026, 10, 6, 10, 30)) / 1000), 12), 136, 12);
  put('        ', 148, 8);
  h[156] = type.charCodeAt(0);
  if (opts.link) put(opts.link, 157, 100);
  put('ustar\0', 257, 6); put('00', 263, 2);
  put('zovo', 265, 32); put('zovo', 297, 32);
  if (opts.prefix) put(opts.prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 7) + ' ', 148, 8);
  return h;
}
function pad(d) { const r = d.length % 512; return r ? cat([d, new Uint8Array(512 - r)]) : d; }
function paxRecord(k, v) {
  const body = ` ${k}=${v}\n`;
  let len = bytes(body).length + 1;
  while (String(len).length + bytes(body).length !== len) len = String(len).length + bytes(body).length;
  return `${len}${body}`;
}

/**
 * entries: [{ name, data?, dir?, symlink?: target, hardlink?: target, longName?: 'gnu'|'pax', mtime? }]
 */
function writeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = e.dir || e.symlink || e.hardlink ? new Uint8Array(0) : bytes(e.data || '');
    const type = e.dir ? '5' : e.symlink ? '2' : e.hardlink ? '1' : '0';
    let name = e.name + (e.dir && !e.name.endsWith('/') ? '/' : '');
    if (bytes(name).length > 100 || e.longName) {
      if (e.longName === 'pax') {
        const rec = bytes(paxRecord('path', name));
        parts.push(tarHeader('PaxHeader/x', rec.length, 'x'), pad(rec));
      } else {
        const ln = bytes(name + '\0');
        parts.push(tarHeader('././@LongLink', ln.length, 'L'), pad(ln));
      }
      name = name.slice(0, 99);
    }
    parts.push(tarHeader(name, data.length, type, { link: e.symlink || e.hardlink, mtime: e.mtime }));
    if (data.length) parts.push(pad(data));
  }
  parts.push(new Uint8Array(1024));
  return cat(parts);
}

function gzip(data, name) { return gzipSync(bytes(data), { level: 9, filename: name, mtime: Date.UTC(2026, 10, 6) }); }

module.exports = { writeZip, writeTar, gzip, cat, bytes };
