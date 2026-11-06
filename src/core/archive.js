'use strict';
// Detects the archive type and gives one shape for ZIP, TAR, TAR.GZ and single-file GZ archives.
const { readZip, readZipEntry } = require('./zip');
const { readTar, readTarEntry, looksLikeTar } = require('./tar');
const { gunzipSource } = require('./inflate');
const { BufferSource } = require('./source');
const { MB, LimitError, fmtSize, normalizeLimits, checkEntryName } = require('./limits');
const { buildTree } = require('./tree');

const ZIP_EXT = /\.(zip|jar|vsix|war|ear|aar|apk|whl|nupkg|xpi|ipa|epub|crx|egg|zipx)$/i;

class FormatError extends Error {}

function u8eq(b, sig, at = 0) { for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false; return true; }

/** Format from the first bytes and the name: 'zip', 'gzip', 'tar' or null. */
function sniff(head, name) {
  if (u8eq(head, [0x50, 0x4b, 0x03, 0x04]) || u8eq(head, [0x50, 0x4b, 0x05, 0x06]) || u8eq(head, [0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (u8eq(head, [0x1f, 0x8b])) return 'gzip';
  if (looksLikeTar(head)) return 'tar';
  if (ZIP_EXT.test(name || '')) return 'zip'; // self-extracting or prefixed ZIP: the reader finds the end record
  return null;
}

function gzipName(head, archiveName) {
  // FNAME field (flag bit 3) holds the original name
  const flg = head[3];
  let p = 10;
  if (flg & 4) p += 2 + (head[10] | (head[11] << 8));
  if (flg & 8) {
    let e = p;
    while (e < head.length && head[e] !== 0) e++;
    if (e < head.length && e > p) return new TextDecoder('latin1').decode(head.subarray(p, e));
  }
  const base = String(archiveName || 'data.gz').replace(/^.*[\\/]/, '');
  return base.replace(/\.t?gz$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : '')) || 'data';
}

/**
 * Opens an archive. src = FileSource or BufferSource, name = file name (for type hints and .gz names).
 * Returns { format, formatLabel, entries, tree, problems, size, read(entry, limitBytes) }.
 */
async function openArchive(src, name, limitsIn) {
  const limits = normalizeLimits(limitsIn);
  const head = await src.read(0, 1024);
  const kind = sniff(head, name);
  const unpackLimit = limits.maxUnpackedMB * MB;
  let out;
  if (kind === 'zip') {
    const z = await readZip(src, limits);
    out = { format: 'zip', formatLabel: z.zip64 ? 'ZIP64' : labelFor(name, 'ZIP'), entries: z.entries, problems: z.problems, comment: z.comment,
      read: (e, limit) => readZipEntry(src, e, limit) };
  } else if (kind === 'tar') {
    const t = await readTar(src, limits);
    out = { format: 'tar', formatLabel: 'TAR', entries: t.entries, problems: t.problems, read: (e, limit) => readTarEntry(src, e, limit) };
  } else if (kind === 'gzip') {
    const peek = await gunzipSource(src, unpackLimit, null, 512).catch(() => new Uint8Array(0));
    if (looksLikeTar(peek)) {
      const over = (n) => `This .tar.gz unpacks to more than ${fmtSize(unpackLimit)}. Archive Explorer stops there so VS Code stays responsive (setting archiveExplorer.maxUnpackedMB). It may be a zip bomb.`;
      const bytes = await gunzipSource(src, unpackLimit, over);
      const inner = new BufferSource(bytes);
      const t = await readTar(inner, limits);
      out = { format: 'tar.gz', formatLabel: 'TAR.GZ', entries: t.entries, problems: t.problems, unpacked: bytes.length,
        read: (e, limit) => readTarEntry(inner, e, limit) };
    } else {
      const isize = src.size >= 18 ? (await src.read(src.size - 4, 4)) : new Uint8Array(4);
      const declared = (isize[0] | (isize[1] << 8) | (isize[2] << 16) | (isize[3] << 24)) >>> 0;
      const inner = gzipName(head, name);
      const chk = checkEntryName(inner.replace(/^.*[\\/]/, ''));
      const entry = { path: chk.path || 'data', raw: inner, unsafe: null, dir: false, kind: 'file', size: declared, sizeApprox: true,
        packed: src.size, mtime: 0, offset: 0, encrypted: false, supported: true, methodName: 'Deflate' };
      out = { format: 'gz', formatLabel: 'GZ', entries: [entry], problems: [],
        read: async (e, limit) => {
          const bytes = await gunzipSource(src, limit, () => `"${e.path}" unpacks to more than ${fmtSize(limit)}. It was stopped (setting archiveExplorer.maxEntryMB).`);
          e.size = bytes.length; e.sizeApprox = false;
          return bytes;
        } };
    }
  } else {
    throw new FormatError('This file is not a ZIP, TAR or GZIP archive that Archive Explorer can read.');
  }
  out.size = src.size;
  out.limits = limits;
  out.tree = buildTree(out.entries);
  out.problems = out.problems.concat(out.tree.problems);
  return out;
}

function labelFor(name, d) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  const ext = m ? m[1].toUpperCase() : '';
  return ['JAR', 'VSIX', 'WAR', 'EAR', 'APK', 'WHL', 'NUPKG', 'XPI', 'EPUB', 'AAR', 'IPA'].includes(ext) ? `${ext} (ZIP)` : d;
}

module.exports = { openArchive, sniff, gzipName, FormatError, ZIP_EXT, LimitError };
