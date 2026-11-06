'use strict';
// Archive Explorer webview. All archive text goes into the page with textContent; styles are set through
// CSSOM (the CSP blocks style attributes).
const { fmtSize, ratioText, fmtDate, kindOf, sortRows, crumbs, parentOf, flagText } = require('./view');

const vscode = acquireVsCodeApi();
const ROW_H = 22;
const S = { init: null, path: '', rows: [], view: [], sel: -1, sort: 'name', desc: false, query: '', results: null, total: 0, rendered: false, searchTimer: 0 };

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(label, title, fn, cls) {
  const b = h('button', cls || 'btn', label);
  b.title = title; b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

const app = document.getElementById('app');
let el = {};

function build() {
  app.textContent = '';
  const top = h('div', 'top');
  el.crumbs = h('nav', 'crumbs');
  el.crumbs.setAttribute('aria-label', 'Folder path');
  el.up = button('Up', 'Go to the parent folder (Backspace)', () => go(parentOf(S.path)), 'btn icon-up');
  el.search = h('input', 'search');
  el.search.type = 'search'; el.search.placeholder = 'Search names (* and ? work)'; el.search.setAttribute('aria-label', 'Search names');
  el.search.addEventListener('input', () => { clearTimeout(S.searchTimer); S.searchTimer = setTimeout(runSearch, 150); });
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { el.search.value = ''; runSearch(); el.list.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (S.sel < 0 && S.view.length) select(0); el.list.focus(); }
  });
  el.extractAll = button('Extract all...', 'Extract the whole archive into a folder you pick', () => vscode.postMessage({ type: 'extractAll' }), 'btn primary');
  el.tree = button('Show in Explorer', 'Show this archive in the Archive Explorer tree in the side bar', () => vscode.postMessage({ type: 'revealTree' }));
  top.append(el.up, el.crumbs, el.search, el.tree, el.extractAll);
  el.summary = h('div', 'summary');
  el.banner = h('div', 'banner');
  el.head = h('div', 'row head');
  for (const [key, label] of [['name', 'Name'], ['size', 'Size'], ['packed', 'Packed'], ['ratio', 'Ratio'], ['mtime', 'Modified']]) {
    const c = h('div', `cell c-${key} sortable`, label);
    c.dataset.key = key; c.setAttribute('role', 'columnheader');
    c.addEventListener('click', () => { if (S.sort === key) S.desc = !S.desc; else { S.sort = key; S.desc = key !== 'name'; } applySort(); });
    el.head.append(c);
  }
  el.list = h('div', 'list');
  el.list.tabIndex = 0; el.list.setAttribute('role', 'grid'); el.list.setAttribute('aria-label', 'Archive entries');
  el.spacer = h('div', 'spacer');
  el.rowsBox = h('div', 'rows');
  el.empty = h('div', 'empty');
  el.list.append(el.spacer, el.rowsBox, el.empty);
  el.list.addEventListener('scroll', () => drawRows());
  el.list.addEventListener('keydown', onKey);
  el.status = h('div', 'status');
  el.info = h('span', 'info');
  el.actions = h('span', 'actions');
  el.open = button('Open', 'Open the selected entry in an editor tab (Enter)', () => openSel(false));
  el.side = button('Open to the side', 'Open the selected entry beside this tab', () => openSel(true));
  el.extract = button('Extract...', 'Extract the selected file or folder', () => { const r = cur(); if (r) vscode.postMessage({ type: 'extract', path: r[7] }); });
  el.copy = button('Copy path', 'Copy the path inside the archive', () => { const r = cur(); if (r) vscode.postMessage({ type: 'copyPath', path: r[7] }); });
  el.actions.append(el.open, el.side, el.extract, el.copy);
  el.toast = h('span', 'toast');
  el.status.append(el.info, el.actions, el.toast);
  const foot = document.getElementById('zovo-support');
  if (foot) el.status.append(foot);
  app.append(top, el.summary, el.banner, el.head, el.list, el.status);
  new ResizeObserver(() => drawRows()).observe(el.list);
}

function cur() { return S.sel >= 0 ? S.view[S.sel] : null; }

function go(path) { vscode.postMessage({ type: 'list', path }); }

function runSearch() {
  const q = el.search.value.trim();
  S.query = q;
  if (!q) { S.results = null; vscode.postMessage({ type: 'list', path: S.path }); return; }
  vscode.postMessage({ type: 'search', query: q });
}

function openSel(side) {
  const r = cur();
  if (!r) return;
  if (r[1]) { if (S.results) { el.search.value = ''; S.query = ''; S.results = null; } go(r[7]); return; }
  vscode.postMessage({ type: 'open', path: r[7], side });
}

function applySort() {
  const keep = cur();
  S.view = sortRows(S.results || S.rows, S.sort, S.desc, !!S.results);
  S.sel = keep ? S.view.findIndex((r) => r[7] === keep[7]) : -1;
  for (const c of el.head.children) {
    c.classList.toggle('sorted', c.dataset.key === S.sort);
    c.classList.toggle('desc', c.dataset.key === S.sort && S.desc);
  }
  layout();
}

function layout() {
  viewVer++;
  el.spacer.style.height = `${S.view.length * ROW_H}px`;
  el.empty.textContent = S.view.length ? '' : S.results ? `No names match "${S.query}".` : 'This folder is empty.';
  drawCrumbs();
  drawRows(true);
  drawStatus();
}

function drawCrumbs() {
  el.crumbs.textContent = '';
  const root = h('button', 'crumb root', S.init.name);
  root.type = 'button'; root.title = 'Archive root';
  root.addEventListener('click', () => { el.search.value = ''; S.query = ''; S.results = null; go(''); });
  el.crumbs.append(root);
  if (S.results) {
    el.crumbs.append(h('span', 'sep', '›'), h('span', 'crumb here', `${S.total.toLocaleString('en-US')} ${S.total === 1 ? 'match' : 'matches'}${S.total > S.results.length ? ` (first ${S.results.length.toLocaleString('en-US')})` : ''}`));
  } else {
    const list = crumbs(S.path);
    list.forEach((c, i) => {
      el.crumbs.append(h('span', 'sep', '›'));
      const b = h('button', i === list.length - 1 ? 'crumb here' : 'crumb', c.name);
      b.type = 'button';
      b.addEventListener('click', () => go(c.path));
      el.crumbs.append(b);
    });
  }
  el.up.disabled = !S.path && !S.results;
}

let drawn = { first: -1, last: -1, ver: -1 };
let viewVer = 0;
const rowEls = new Map();
function drawRows(force) {
  if (!el.list) return;
  const top = el.list.scrollTop;
  const hgt = el.list.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / ROW_H) - 4);
  const last = Math.min(S.view.length, Math.ceil((top + hgt) / ROW_H) + 4);
  // Rows are rebuilt only when the visible range or the data changes, so a double click hits the same element twice.
  if (!force && first === drawn.first && last === drawn.last && drawn.ver === viewVer) return;
  drawn = { first, last, ver: viewVer };
  el.rowsBox.textContent = '';
  rowEls.clear();
  for (let i = first; i < last; i++) { const e = rowEl(S.view[i], i); rowEls.set(i, e); el.rowsBox.append(e); }
}

function rowEl(r, i) {
  const [name, dir, size, packed, mtime, flags, count, path] = r;
  const e = h('div', 'row item' + (i === S.sel ? ' selected' : '') + (flags & 1 ? ' unsafe' : ''));
  e.style.transform = `translateY(${i * ROW_H}px)`;
  e.setAttribute('role', 'row');
  const n = h('div', 'cell c-name');
  const icon = h('span', `ico ${flags & 31 && !dir ? 'warn' : kindOf(name, dir)}`);
  n.append(icon, h('span', 'nm', S.results ? path : name));
  if (dir) n.append(h('span', 'count', `${count.toLocaleString('en-US')}`));
  if (flags) { const f = h('span', 'flag', flagText(flags)); n.append(f); }
  n.title = path + (flags ? ` (${flagText(flags)})` : '');
  const approx = S.init.approx && !dir;
  e.append(n,
    h('div', 'cell c-size num', (approx ? '≈ ' : '') + fmtSize(size)),
    h('div', 'cell c-packed num', packed >= 0 ? fmtSize(packed) : ''),
    h('div', 'cell c-ratio num', ratioText(size, packed)),
    h('div', 'cell c-mtime', fmtDate(mtime)));
  e.addEventListener('mousedown', () => select(i, true));
  e.addEventListener('dblclick', (ev) => { select(i); openSel(ev.altKey || ev.ctrlKey || ev.metaKey); });
  return e;
}

function select(i, noScroll) {
  if (!S.view.length) { S.sel = -1; drawStatus(); return; }
  const prev = rowEls.get(S.sel);
  S.sel = Math.max(0, Math.min(S.view.length - 1, i));
  if (prev) prev.classList.remove('selected');
  const now = rowEls.get(S.sel);
  if (now) now.classList.add('selected');
  if (!noScroll) {
    const y = S.sel * ROW_H, top = el.list.scrollTop, hgt = el.list.clientHeight;
    if (y < top) el.list.scrollTop = y;
    else if (y + ROW_H > top + hgt) el.list.scrollTop = y + ROW_H - hgt;
    drawRows();
    const again = rowEls.get(S.sel);
    if (again) again.classList.add('selected');
  }
  drawStatus();
}

function drawStatus() {
  const r = cur();
  if (!r) {
    const files = S.view.filter((x) => !x[1]).length, dirs = S.view.length - files;
    const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
    el.info.textContent = S.results ? plural(S.view.length, 'match', 'matches') : `${dirs ? `${plural(dirs, 'folder', 'folders')}, ` : ''}${plural(files, 'file', 'files')} here`;
  } else {
    const [name, dir, size, packed] = r;
    const ratio = ratioText(size, packed);
    el.info.textContent = `${name}: ${fmtSize(size)}${packed >= 0 ? `, packed ${fmtSize(packed)}` : ''}${ratio ? ` (${ratio})` : ''}${dir ? `, ${r[6]} items` : ''}`;
  }
  const off = !r;
  el.open.disabled = off; el.side.disabled = off || !!(r && r[1]); el.extract.disabled = off || !!(r && (r[5] & 31) && !r[1]); el.copy.disabled = off;
  el.open.textContent = r && r[1] ? 'Open folder' : 'Open';
}

function onKey(e) {
  const page = Math.max(1, Math.floor(el.list.clientHeight / ROW_H) - 1);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); el.search.focus(); el.search.select(); return; }
  if (mod && e.key.toLowerCase() === 'c' && cur()) { e.preventDefault(); vscode.postMessage({ type: 'copyPath', path: cur()[7] }); return; }
  switch (e.key) {
    case 'ArrowDown': select(S.sel + 1); break;
    case 'ArrowUp': select(S.sel - 1); break;
    case 'PageDown': select(S.sel + page); break;
    case 'PageUp': select(S.sel - page); break;
    case 'Home': select(0); break;
    case 'End': select(S.view.length - 1); break;
    case 'Enter': openSel(e.altKey); break;
    case 'Backspace': if (S.results) { el.search.value = ''; runSearch(); } else if (S.path) go(parentOf(S.path)); break;
    default: return;
  }
  e.preventDefault();
}

function showSummary() {
  const i = S.init, s = i.summary;
  el.summary.textContent = '';
  el.summary.append(h('span', 'badge', i.formatLabel));
  const parts = [`${s.files.toLocaleString('en-US')} ${s.files === 1 ? 'file' : 'files'} in ${s.dirs.toLocaleString('en-US')} ${s.dirs === 1 ? 'folder' : 'folders'}`, `${i.approx ? '≈ ' : ''}${fmtSize(s.size)} unpacked`, `${fmtSize(s.archiveSize)} on disk`];
  if (i.ratio) parts.push(`ratio ${i.ratio}`);
  el.summary.append(h('span', 'facts', parts.join(' · ')));
  if (i.comment) { const c = h('span', 'comment', `“${i.comment.slice(0, 200)}”`); c.title = 'Archive comment'; el.summary.append(c); }
  const notes = [i.ratioWarning, ...(i.problems || [])].filter(Boolean);
  el.banner.textContent = '';
  el.banner.classList.toggle('show', notes.length > 0);
  for (const n of notes.slice(0, 5)) el.banner.append(h('div', 'note', n));
}

let toastTimer = 0;
function toast(text, bad) {
  el.toast.textContent = text;
  el.toast.classList.toggle('bad', !!bad);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.textContent = ''; }, 4000);
}

function fatal(message) {
  app.textContent = '';
  const box = h('div', 'fatal');
  box.append(h('h2', null, 'Archive Explorer cannot show this file'), h('p', null, message));
  app.append(box);
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') {
    S.init = m; S.path = ''; S.rows = m.rows || []; S.results = null; S.sel = -1;
    build(); showSummary(); applySort();
    el.list.focus();
    if (!S.rendered) { S.rendered = true; vscode.postMessage({ type: 'rendered' }); }
  } else if (m.type === 'listing') {
    if (S.results) { el.search.value = ''; S.query = ''; S.results = null; }
    const back = S.path.startsWith(m.path) && S.path !== m.path ? S.path : null;
    S.path = m.path; S.rows = m.rows || []; S.sel = -1;
    el.list.scrollTop = 0;
    applySort();
    if (back) { const i = S.view.findIndex((r) => r[7] === back); if (i >= 0) select(i); }
  } else if (m.type === 'results') {
    if (m.query !== el.search.value.trim()) return;
    S.results = m.rows || []; S.total = m.total || 0; S.sel = -1;
    el.list.scrollTop = 0;
    applySort();
  } else if (m.type === 'toast') {
    toast(m.text);
  } else if (m.type === 'error') {
    if (m.soft && el.toast) toast(m.message, true); else fatal(m.message);
  }
});

vscode.postMessage({ type: 'ready' });
