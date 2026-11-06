'use strict';
// Pure helpers for the webview (no DOM), so tests can call them.

function fmtSize(n) {
  if (n == null || n < 0 || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function ratioText(size, packed) {
  if (packed == null || packed < 0 || !size) return '';
  if (packed === 0) return '∞';
  const r = size / packed;
  if (r < 0.95) return `${r.toFixed(2)}:1`;
  if (r < 1.05) return '1:1';
  return `${r >= 100 ? Math.round(r) : r >= 10 ? r.toFixed(0) : r.toFixed(1)}:1`;
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TYPES = [
  ['image', /\.(png|jpe?g|gif|webp|bmp|ico|svg|tiff?|avif)$/i],
  ['archive', /\.(zip|jar|vsix|war|ear|aar|apk|whl|nupkg|tar|tgz|gz|7z|rar|xz|bz2)$/i],
  ['code', /\.(js|mjs|cjs|ts|tsx|jsx|py|java|kt|go|rs|c|h|cpp|cs|rb|php|swift|sh|ps1|lua|css|scss|html?|vue|svelte|sql|class)$/i],
  ['data', /\.(json|jsonl|ya?ml|toml|xml|csv|tsv|parquet|xlsx?|ini|properties|env|lock)$/i],
  ['doc', /\.(md|txt|rst|log|pdf|docx?|pptx?|rtf|mf)$/i],
];
function kindOf(name, isDir) {
  if (isDir) return 'folder';
  for (const [k, re] of TYPES) if (re.test(name)) return k;
  return 'file';
}

// row = [name, dir, size, packed, mtime, flags, childCount, path]
const COLS = { name: 0, size: 2, packed: 3, ratio: -1, mtime: 4 };
function sortRows(rows, key, desc, byPath) {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const val = (r) => (key === 'ratio' ? (r[3] > 0 ? r[2] / r[3] : -1) : r[COLS[key]]);
  const out = rows.slice();
  out.sort((a, b) => {
    if (a[1] !== b[1] && !byPath) return b[1] - a[1];
    let c;
    if (key === 'name') c = coll.compare(byPath ? a[7] : a[0], byPath ? b[7] : b[0]);
    else c = val(a) - val(b) || coll.compare(a[0], b[0]);
    return desc ? -c : c;
  });
  return out;
}

function crumbs(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

function parentOf(path) {
  const p = String(path || '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

const FLAG_TEXT = [[1, 'unsafe name, never extracted'], [2, 'encrypted'], [4, 'compression not supported'], [8, 'link'], [16, 'special entry'], [32, 'has flagged entries inside']];
function flagText(flags) { return FLAG_TEXT.filter(([b]) => flags & b).map(([, t]) => t).join(', '); }

module.exports = { fmtSize, ratioText, fmtDate, kindOf, sortRows, crumbs, parentOf, flagText };
