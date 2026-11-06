'use strict';
// Folder tree, folder listings, name search and the entry list for an extraction.

function node(name, path) {
  return { name, path, dir: true, entry: null, children: new Map(), size: 0, packed: 0, packedKnown: true, files: 0, dirs: 0, mtime: 0, flags: 0 };
}

// flag bits shared with the webview
const F = { UNSAFE: 1, ENCRYPTED: 2, UNSUPPORTED: 4, LINK: 8, SPECIAL: 16, CONTAINS: 32 };

function flagsOf(e) {
  let f = 0;
  if (e.unsafe) f |= F.UNSAFE;
  if (e.encrypted) f |= F.ENCRYPTED;
  if (!e.supported && !e.dir) f |= (e.kind === 'symlink' || e.kind === 'hardlink') ? F.LINK : e.kind === 'other' ? F.SPECIAL : F.UNSUPPORTED;
  if (e.kind === 'symlink' || e.kind === 'hardlink') f |= F.LINK;
  return f;
}

function buildTree(entries) {
  const root = node('', '');
  const problems = [];
  let dupes = 0, unsafe = 0;
  for (const e of entries) {
    if (e.unsafe) unsafe++;
    if (!e.path) continue;
    const parts = e.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let c = cur.children.get(parts[i]);
      if (!c || !c.dir) { c = node(parts[i], parts.slice(0, i + 1).join('/')); cur.children.set(parts[i], c); }
      cur = c;
    }
    const last = parts[parts.length - 1];
    const existing = cur.children.get(last);
    if (e.dir) {
      if (existing && existing.dir) { existing.entry = existing.entry || e; if (e.mtime) existing.mtime = e.mtime; existing.flags |= flagsOf(e); continue; }
      if (existing) { dupes++; continue; }
      const n = node(last, e.path); n.entry = e; n.mtime = e.mtime || 0; n.flags = flagsOf(e);
      cur.children.set(last, n);
      continue;
    }
    if (existing) { dupes++; continue; } // first one wins, like most unzip tools list it
    cur.children.set(last, { name: last, path: e.path, dir: false, entry: e, size: e.size, packed: e.packed, mtime: e.mtime || 0, flags: flagsOf(e) });
  }
  (function sum(n) {
    for (const c of n.children.values()) {
      if (c.dir) { sum(c); n.dirs += 1 + c.dirs; n.files += c.files; } else { n.files++; }
      n.size += c.size || 0;
      if (c.packed == null || (c.dir && !c.packedKnown)) n.packedKnown = false; else n.packed += c.packed || 0;
      if (c.mtime > n.mtime) n.mtime = c.mtime;
      if (c.flags & (F.UNSAFE | F.ENCRYPTED | F.CONTAINS)) n.flags |= F.CONTAINS;
    }
  })(root);
  if (dupes) problems.push(`${dupes} entries repeat a name that is already in the archive. Only the first one is listed.`);
  if (unsafe) problems.push(`${unsafe} entries have unsafe names ("..", or an absolute path). They are listed with a warning and are never extracted.`);
  return { root, problems, dupes, unsafe };
}

function find(tree, path) {
  if (!path) return tree.root;
  let cur = tree.root;
  for (const p of String(path).split('/')) {
    if (!p) continue;
    if (!cur.dir) return null;
    cur = cur.children.get(p);
    if (!cur) return null;
  }
  return cur;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortedChildren(n) {
  return [...n.children.values()].sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
}

/** Compact rows for the webview: [name, dir, size, packed(-1 = unknown), mtime, flags, childCount, path]. */
function row(n) {
  const packed = n.dir ? (n.packedKnown ? n.packed : -1) : (n.packed == null ? -1 : n.packed);
  return [n.name, n.dir ? 1 : 0, n.size || 0, packed, n.mtime || 0, n.flags || 0, n.dir ? n.children.size : 0, n.path];
}

function listFolder(tree, path) {
  const n = find(tree, path);
  if (!n || !n.dir) return null;
  return sortedChildren(n).map(row);
}

/** Name search over every path. Plain text matches anywhere; * and ? work as wildcards. */
function search(tree, query, limit = 2000) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { rows: [], total: 0 };
  const re = /[*?]/.test(q) ? new RegExp(q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'), 'i') : null;
  const rows = [];
  let total = 0;
  (function walk(n) {
    for (const c of n.children.values()) {
      const hit = re ? re.test(c.name) || re.test(c.path) : c.path.toLowerCase().includes(q);
      if (hit) { total++; if (rows.length < limit) rows.push(row(c)); }
      if (c.dir) walk(c);
    }
  })(tree.root);
  rows.sort((a, b) => collator.compare(a[7], b[7]));
  return { rows, total };
}

/**
 * Entries to write when extracting `path` (a file or a folder). Paths in the result are relative to the
 * folder that holds `path`, so a folder is extracted as a folder. Skipped entries come with a reason.
 */
function collect(tree, path) {
  const n = find(tree, path);
  if (!n) return null;
  const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/') + 1) : '';
  const files = [], dirs = [], skipped = [];
  let bytes = 0;
  (function walk(x) {
    const rel = x.path.slice(parent.length);
    if (x.dir) {
      if (x !== tree.root && rel) dirs.push(rel);
      for (const c of x.children.values()) walk(c);
      return;
    }
    const e = x.entry;
    if (e.unsafe) { skipped.push([x.path, 'unsafe name']); return; }
    if (e.encrypted) { skipped.push([x.path, 'encrypted']); return; }
    if (e.kind === 'symlink' || e.kind === 'hardlink') { skipped.push([x.path, 'link']); return; }
    if (!e.supported) { skipped.push([x.path, 'not supported']); return; }
    files.push({ rel, entry: e });
    bytes += e.size || 0;
  })(n);
  return { files, dirs, skipped, bytes, isDir: n.dir };
}

function summary(tree, archiveSize) {
  const r = tree.root;
  return { files: r.files, dirs: r.dirs, size: r.size, packed: r.packedKnown ? r.packed : archiveSize, archiveSize };
}

module.exports = { buildTree, find, listFolder, search, collect, summary, row, F };
