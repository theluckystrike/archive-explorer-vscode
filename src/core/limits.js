'use strict';
// Size and count limits against zip bombs, and the path checks against zip slip.
const MB = 1024 * 1024;
const DEFAULTS = Object.freeze({ maxEntries: 200000, maxEntryMB: 512, maxUnpackedMB: 2048 });

class LimitError extends Error {
  constructor(message, code) { super(message); this.name = 'LimitError'; this.code = code || 'limit'; }
}

function fmtSize(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function fmtCount(n) { return Number(n).toLocaleString('en-US'); }

function normalizeLimits(o) {
  const src = o || {};
  const num = (v, d, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : d);
  return {
    maxEntries: num(src.maxEntries, DEFAULTS.maxEntries, 10, 5000000),
    maxEntryMB: num(src.maxEntryMB, DEFAULTS.maxEntryMB, 1, 8192),
    maxUnpackedMB: num(src.maxUnpackedMB, DEFAULTS.maxUnpackedMB, 1, 65536),
  };
}

function tooManyEntries(count, max) {
  return new LimitError(`This archive lists ${fmtCount(count)} entries. Archive Explorer reads up to ${fmtCount(max)} so VS Code stays responsive (setting archiveExplorer.maxEntries).`, 'entries');
}

/**
 * Checks one entry name. Returns { path, unsafe } where path is a clean relative display path with "/"
 * separators, and unsafe is a reason string for names that try to leave the target folder (zip slip),
 * or null. Unsafe entries are listed but never extracted.
 */
function checkEntryName(raw) {
  const s = String(raw == null ? '' : raw);
  let unsafe = null;
  if (s.includes('\0')) unsafe = 'The name contains a NUL character.';
  const slashed = s.replace(/\\/g, '/');
  if (/^\/|^[a-zA-Z]:/.test(slashed) || /^\/\//.test(slashed)) unsafe = unsafe || 'The name is an absolute path.';
  const parts = [];
  for (const p of slashed.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { unsafe = unsafe || 'The name contains "..", which would write outside the target folder.'; continue; }
    parts.push(p.replace(/\0/g, ''));
  }
  if (!unsafe && /^[a-zA-Z]:/.test(parts[0] || '')) unsafe = 'The name starts with a drive letter.';
  return { path: parts.join('/'), unsafe };
}

/**
 * Joins a checked relative path onto a target folder (POSIX paths, as in VS Code URIs) and proves the
 * result stays inside the target. Returns the joined path, or null when it would escape.
 */
function joinInside(targetDir, rel) {
  const path = require('path').posix;
  const base = path.resolve('/', targetDir);
  const c = checkEntryName(rel);
  if (c.unsafe || !c.path) return null;
  const out = path.resolve(base, c.path);
  const prefix = base.endsWith('/') ? base : base + '/';
  return out.startsWith(prefix) ? out : null;
}

module.exports = { MB, DEFAULTS, LimitError, fmtSize, fmtCount, normalizeLimits, tooManyEntries, checkEntryName, joinInside };
