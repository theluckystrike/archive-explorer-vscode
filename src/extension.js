'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { FileSource, BufferSource } = require('./core/source');
const { openArchive } = require('./core/archive');
const { find, listFolder, search, summary, F } = require('./core/tree');
const { MB, LimitError, fmtSize, fmtCount, normalizeLimits } = require('./core/limits');
const { validateWebviewMessage, ratioText, ratioWarning } = require('./core/protocol');
const { extract } = require('./extract');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const PREFIX = 'archiveExplorer';
const SELF_ID = 'zovo.zip-archive-explorer';
const VIEW_TYPE = 'archiveExplorer.editor';
const TREE_ID = 'archiveExplorer.tree';
const SCHEME = 'zovo-archive';
const MAX_CACHED = 6;
let rating = { success() {} };

function limits() {
  const c = vscode.workspace.getConfiguration(PREFIX);
  return normalizeLimits({ maxEntries: c.get('maxEntries'), maxEntryMB: c.get('maxEntryMB'), maxUnpackedMB: c.get('maxUnpackedMB') });
}

const files = (n) => `${fmtCount(n)} ${n === 1 ? 'file' : 'files'}`;
const baseName = (uri) => path.posix.basename(uri.path) || 'archive';

/** URI of one entry: zovo-archive:/<archive name>/<entry path>?<archive URI>. The name keeps file icons and languages right. */
function entryUri(archiveUri, entryPath) {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + baseName(archiveUri) + (entryPath ? '/' + entryPath : ''), query: archiveUri.toString() });
}
function parseEntryUri(uri) {
  return { archive: vscode.Uri.parse(uri.query), path: uri.path.split('/').slice(2).join('/') };
}

/** Opened archives, newest last. Local files are re-read when they change on disk. */
class ArchiveStore {
  constructor() { this.map = new Map(); }
  async get(uri) {
    const key = uri.toString();
    let stamp = '';
    if (uri.scheme === 'file') { const st = await vscode.workspace.fs.stat(uri); stamp = `${st.size}:${st.mtime}`; }
    const hit = this.map.get(key);
    if (hit && hit.stamp === stamp) { this.map.delete(key); this.map.set(key, hit); return hit.promise; }
    if (hit) this.drop(key);
    const promise = this.load(uri);
    const rec = { promise, stamp };
    this.map.set(key, rec);
    promise.catch(() => { if (this.map.get(key) === rec) this.map.delete(key); });
    while (this.map.size > MAX_CACHED) this.drop(this.map.keys().next().value);
    return promise;
  }
  async load(uri) {
    const lim = limits();
    let src;
    if (uri.scheme === 'file') src = await FileSource.open(uri.fsPath);
    else {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size > lim.maxUnpackedMB * MB) throw new LimitError(`This archive is not on local disk and is ${fmtSize(st.size)}. Such archives are read whole, and the limit is ${fmtSize(lim.maxUnpackedMB * MB)} (setting archiveExplorer.maxUnpackedMB).`);
      src = new BufferSource(await vscode.workspace.fs.readFile(uri));
    }
    try {
      const arc = await openArchive(src, baseName(uri), lim);
      arc.uri = uri; arc.name = baseName(uri); arc.src = src;
      return arc;
    } catch (e) { await src.close(); throw e; }
  }
  drop(key) {
    const rec = this.map.get(key);
    this.map.delete(key);
    if (rec) rec.promise.then((a) => a.src.close(), () => {});
  }
  dispose() { for (const k of [...this.map.keys()]) this.drop(k); }
}

const store = new ArchiveStore();

function fsError(e) {
  return vscode.FileSystemError.Unavailable(e && e.message ? e.message : String(e));
}

/** Read-only file system for archive entries, so they open in normal editor tabs. */
class ArchiveFileSystem {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeFile = this.emitter.event; }
  watch() { return new vscode.Disposable(() => {}); }
  async resolve(uri) {
    const { archive, path: p } = parseEntryUri(uri);
    const arc = await store.get(archive);
    const node = find(arc.tree, p);
    if (!node) throw vscode.FileSystemError.FileNotFound(uri);
    return { arc, node };
  }
  async stat(uri) {
    const { node } = await this.resolve(uri);
    return { type: node.dir ? vscode.FileType.Directory : vscode.FileType.File, ctime: node.mtime || 0, mtime: node.mtime || 0, size: node.size || 0, permissions: vscode.FilePermission ? vscode.FilePermission.Readonly : 1 };
  }
  async readDirectory(uri) {
    const { node } = await this.resolve(uri);
    if (!node.dir) throw vscode.FileSystemError.FileNotADirectory(uri);
    return [...node.children.values()].map((c) => [c.name, c.dir ? vscode.FileType.Directory : vscode.FileType.File]);
  }
  async readFile(uri) {
    const { arc, node } = await this.resolve(uri);
    if (node.dir) throw vscode.FileSystemError.FileIsADirectory(uri);
    try { return await arc.read(node.entry, limits().maxEntryMB * MB); } catch (e) { throw fsError(e); }
  }
  readonly() { throw vscode.FileSystemError.NoPermissions('Archive entries are read-only. Extract the file to change it.'); }
  writeFile() { this.readonly(); }
  createDirectory() { this.readonly(); }
  delete() { this.readonly(); }
  rename() { this.readonly(); }
}

/** Why an entry cannot be opened, or '' when it can. */
function blockReason(node, lim) {
  const e = node.entry;
  if (!e) return '';
  if (e.encrypted) return `"${node.path}" is encrypted. Archive Explorer does not open password-protected entries.`;
  if (e.kind === 'symlink' || e.kind === 'hardlink') return `"${node.path}" is a link to "${e.link || '?'}". Links are listed but not opened.`;
  if (!e.supported) return `"${node.path}" uses ${e.methodName || 'a format'} that Archive Explorer cannot unpack.`;
  if (!e.sizeApprox && e.size > lim.maxEntryMB * MB) return `"${node.path}" is ${fmtSize(e.size)} unpacked. Archive Explorer opens entries up to ${fmtSize(lim.maxEntryMB * MB)} (setting archiveExplorer.maxEntryMB). You can extract it instead.`;
  return '';
}

async function openEntry(archiveUri, entryPath, side) {
  const arc = await store.get(archiveUri);
  const node = find(arc.tree, entryPath);
  if (!node) throw new Error(`"${entryPath}" is not in this archive.`);
  if (node.dir) return false;
  const why = blockReason(node, arc.limits);
  if (why) {
    const pick = await vscode.window.showWarningMessage(why, ...(node.entry.supported && !node.entry.encrypted ? ['Extract...'] : []));
    if (pick === 'Extract...') await runExtract(archiveUri, entryPath);
    return false;
  }
  await vscode.commands.executeCommand('vscode.open', entryUri(archiveUri, node.path), { preview: !side, viewColumn: side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active });
  return true;
}

function folderOf(uri) { return uri.with({ path: path.posix.dirname(uri.path), query: '', fragment: '' }); }

function defaultFolder(archiveUri) {
  if (archiveUri.scheme === 'file') return folderOf(archiveUri);
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri : undefined;
}

/** Extract one file (save dialog) or a folder / the whole archive (folder picker). */
async function runExtract(archiveUri, entryPath) {
  const arc = await store.get(archiveUri);
  const node = find(arc.tree, entryPath || '');
  if (!node) throw new Error(`"${entryPath}" is not in this archive.`);
  let base;
  let single = null;
  const start = defaultFolder(archiveUri);
  if (!node.dir) {
    const why = blockReason(node, { maxEntryMB: Infinity });
    if (why) { vscode.window.showWarningMessage(why); return null; }
    const target = await vscode.window.showSaveDialog({ defaultUri: start ? vscode.Uri.joinPath(start, node.name) : undefined, saveLabel: 'Extract', title: `Extract ${node.name}` });
    if (!target) return null;
    if (target.toString() === archiveUri.toString()) { vscode.window.showWarningMessage('Pick another file name. The archive itself is never overwritten.'); return null; }
    base = target; single = target.path;
  } else {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: start, openLabel: 'Extract here',
      title: entryPath ? `Extract the folder ${node.name} into...` : `Extract all of ${arc.name} into...` });
    if (!picked || !picked[0]) return null;
    base = picked[0];
  }
  const at = (p) => base.with({ path: p });
  const io = {
    exists: async (p) => { try { await vscode.workspace.fs.stat(at(p)); return true; } catch { return false; } },
    mkdir: (p) => vscode.workspace.fs.createDirectory(at(p)),
    write: (p, d) => vscode.workspace.fs.writeFile(at(p), d),
  };
  let res;
  try {
    res = await extractWithProgress(arc, entryPath, base, single, io);
  } catch (e) {
    vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
    return { error: e && e.message ? e.message : String(e), written: 0 };
  }
  if (res.cancelled && !res.written) return res;
  const where = single ? single : base.path;
  const skippedText = res.skipped.length ? ` Skipped ${res.skipped.length}: ${res.skipped.slice(0, 3).map(([p, r]) => `${p} (${r})`).join(', ')}${res.skipped.length > 3 ? ', ...' : ''}.` : '';
  const msg = `Extracted ${fmtCount(res.written)} ${res.written === 1 ? 'file' : 'files'} (${fmtSize(res.bytes)}) to ${where}.${skippedText}`;
  const btn = base.scheme === 'file' ? 'Reveal' : undefined;
  (res.skipped.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(msg, ...(btn ? [btn] : [])).then((p) => {
    if (p === 'Reveal') vscode.commands.executeCommand('revealFileInOS', base);
  });
  return res;
}

function extractWithProgress(arc, entryPath, base, single, io) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Extracting from ${arc.name}`, cancellable: true }, (progress, token) => {
    let last = 0;
    return extract({
      arc, path: entryPath || '', targetDir: base.path, single, io,
      onConflict: async (n) => {
        const o = await vscode.window.showWarningMessage(`${fmtCount(n)} ${n === 1 ? 'file already exists' : 'files already exist'} in the target folder.`, { modal: true }, 'Overwrite', 'Skip existing');
        return o === 'Overwrite' ? 'overwrite' : o === 'Skip existing' ? 'skip' : undefined;
      },
      progress: (done, total) => { const pct = Math.floor((done / total) * 100); if (pct > last) { progress.report({ increment: pct - last, message: `${done} of ${total}` }); last = pct; } },
      cancelled: () => token.isCancellationRequested,
    });
  });
}

/* ---------- Explorer tree ---------- */

class ArchiveTree {
  constructor() {
    this.roots = []; // archive URIs
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.items = new Map();
  }
  has(uri) { return this.roots.some((u) => u.toString() === uri.toString()); }
  add(uri) { if (!this.has(uri)) { this.roots.push(uri); this.refresh(); } return this.rootItem(uri); }
  remove(uri) { this.roots = this.roots.filter((u) => u.toString() !== uri.toString()); store.drop(uri.toString()); this.refresh(); }
  clear() { for (const u of this.roots) store.drop(u.toString()); this.roots = []; this.refresh(); }
  refresh() { vscode.commands.executeCommand('setContext', 'archiveExplorer.hasArchives', this.roots.length > 0); this.emitter.fire(undefined); }
  rootItem(uri) { return this.item({ kind: 'archive', uri, path: '' }); }
  item(x) { const k = x.uri.toString() + '::' + x.path; if (!this.items.has(k)) this.items.set(k, x); return this.items.get(k); }
  getParent(x) {
    if (x.kind === 'archive') return undefined;
    const i = x.path.lastIndexOf('/');
    return i < 0 ? this.rootItem(x.uri) : this.item({ kind: 'node', uri: x.uri, path: x.path.slice(0, i) });
  }
  async getChildren(x) {
    if (!x) return this.roots.map((u) => this.rootItem(u));
    try {
      const arc = await store.get(x.uri);
      const rows = listFolder(arc.tree, x.path) || [];
      return rows.map((r) => this.item({ kind: 'node', uri: x.uri, path: r[7] }));
    } catch (e) {
      return [this.item({ kind: 'error', uri: x.uri, path: '#error', message: e.message })];
    }
  }
  async getTreeItem(x) {
    if (x.kind === 'error') {
      const t = new vscode.TreeItem(x.message, vscode.TreeItemCollapsibleState.None);
      t.iconPath = new vscode.ThemeIcon('warning'); t.tooltip = x.message; t.contextValue = 'error';
      return t;
    }
    if (x.kind === 'archive') {
      const t = new vscode.TreeItem(baseName(x.uri), vscode.TreeItemCollapsibleState.Expanded);
      t.id = x.uri.toString() + '::';
      t.resourceUri = x.uri;
      t.contextValue = 'archive';
      try {
        const arc = await store.get(x.uri);
        const s = summary(arc.tree, arc.size);
        t.description = `${arc.formatLabel} · ${files(s.files)} · ${fmtSize(s.size)}`;
        t.tooltip = `${x.uri.scheme === 'file' ? x.uri.fsPath : x.uri.toString()}\n${arc.formatLabel}, ${fmtCount(s.files)} files in ${fmtCount(s.dirs)} folders\nUnpacked ${fmtSize(s.size)}, packed ${fmtSize(s.packed)}${ratioText(s.size, s.packed) ? ` (${ratioText(s.size, s.packed)})` : ''}`;
      } catch (e) { t.description = 'cannot read'; t.tooltip = e.message; }
      return t;
    }
    const arc = await store.get(x.uri);
    const n = find(arc.tree, x.path);
    const t = new vscode.TreeItem(n ? n.name : x.path, n && n.dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    t.id = x.uri.toString() + '::' + x.path;
    if (!n) return t;
    t.resourceUri = entryUri(x.uri, n.path);
    const packed = n.dir ? (n.packedKnown ? n.packed : null) : n.packed;
    const ratio = ratioText(n.size, packed);
    t.description = n.dir ? `${files(n.files)} · ${fmtSize(n.size)}` : `${fmtSize(n.size)}${ratio ? ' · ' + ratio : ''}`;
    const warn = n.dir ? '' : n.flags & F.UNSAFE ? 'unsafe name' : n.flags & F.ENCRYPTED ? 'encrypted' : n.flags & F.LINK ? 'link' : n.flags & (F.UNSUPPORTED | F.SPECIAL) ? 'not supported' : '';
    if (warn && !n.dir) { t.description += ` · ${warn}`; t.iconPath = new vscode.ThemeIcon('warning'); }
    t.contextValue = n.dir ? 'entry.dir' : 'entry.file';
    const lines = [n.path, n.dir ? `${files(n.files)}, ${fmtSize(n.size)} unpacked` : `${fmtSize(n.size)} unpacked${packed != null ? `, ${fmtSize(packed)} packed` : ''}${ratio ? ` (${ratio})` : ''}`];
    if (n.mtime) lines.push(new Date(n.mtime).toLocaleString());
    if (n.entry && n.entry.unsafe) lines.push(n.entry.unsafe + ' It is never extracted.');
    if (n.entry && n.entry.link) lines.push('Link to ' + n.entry.link);
    t.tooltip = lines.join('\n');
    if (!n.dir) t.command = { command: 'archiveExplorer.openEntry', title: 'Open', arguments: [x] };
    return t;
  }
}

/* ---------- Custom editor ---------- */

class ArchiveEditorProvider {
  constructor(context, tree, treeView) { this.context = context; this.tree = tree; this.treeView = treeView; this.panels = new Set(); }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    // Command links only for the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris(PREFIX) };
    const name = baseName(uri);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name, showSupportLinks: showLinks(vscode, PREFIX),
    });
    let disposed = false, counted = false;
    const post = (m) => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));
    const rec = { uri, panel };
    this.panels.add(rec);
    panel.webview.onDidReceiveMessage(async (raw) => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') {
          const t0 = Date.now();
          const arc = await store.get(uri);
          const s = summary(arc.tree, arc.size);
          if (this.tree) this.tree.add(uri);
          await post({
            type: 'init', name, format: arc.format, formatLabel: arc.formatLabel, summary: s, ratio: arc.format === 'tar' ? '' : ratioText(s.size, s.packed),
            ratioWarning: ratioWarning(s.size, s.packed) || bombWarning(arc), problems: arc.problems.slice(0, 20), comment: arc.comment || '',
            rows: listFolder(arc.tree, ''), path: '', ms: Date.now() - t0, maxEntryMB: arc.limits.maxEntryMB,
            approx: arc.format === 'gz',
          });
          return;
        }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        const arc = await store.get(uri);
        if (msg.type === 'list') {
          const rows = listFolder(arc.tree, msg.path);
          await post(rows ? { type: 'listing', path: msg.path, rows } : { type: 'error', message: `"${msg.path}" is not a folder in this archive.`, soft: true });
        } else if (msg.type === 'search') {
          const r = search(arc.tree, msg.query, 5000);
          await post({ type: 'results', query: msg.query, rows: r.rows, total: r.total });
        } else if (msg.type === 'open') {
          const n = find(arc.tree, msg.path);
          if (n && n.dir) await post({ type: 'listing', path: n.path, rows: listFolder(arc.tree, n.path) });
          else await openEntry(uri, msg.path, msg.side);
        } else if (msg.type === 'extract') {
          await runExtract(uri, msg.path);
        } else if (msg.type === 'extractAll') {
          await runExtract(uri, '');
        } else if (msg.type === 'copyPath') {
          await vscode.env.clipboard.writeText(msg.path);
          await post({ type: 'toast', text: `Copied ${msg.path}` });
        } else if (msg.type === 'revealTree') {
          if (this.tree) {
            const item = this.tree.add(uri);
            await vscode.commands.executeCommand(`${TREE_ID}.focus`);
            if (this.treeView) await this.treeView.reveal(item, { expand: true, focus: true, select: true }).catch(() => {});
          }
        }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e), soft: msg.type !== 'ready' });
      }
    });
    panel.onDidDispose(() => { disposed = true; this.panels.delete(rec); });
  }
}

function bombWarning(arc) {
  const lim = arc.limits.maxUnpackedMB * MB;
  const s = summary(arc.tree, arc.size);
  if (s.size > lim) return `This archive unpacks to ${fmtSize(s.size)}, more than the ${fmtSize(lim)} extraction limit (setting archiveExplorer.maxUnpackedMB). You can still browse it and open small entries.`;
  return '';
}

/* ---------- Commands ---------- */

const ARCHIVE_RE = /\.(zip|jar|vsix|war|ear|aar|apk|whl|nupkg|xpi|ipa|epub|tar|tgz|gz)$/i;

function targetArchive(arg, tree) {
  if (arg && arg.kind && arg.uri) return arg.uri;
  if (arg instanceof vscode.Uri || (arg && arg.scheme && arg.path)) return arg;
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab && tab.input && tab.input.viewType === VIEW_TYPE && tab.input.uri) return tab.input.uri;
  if (tree.roots.length === 1) return tree.roots[0];
  return null;
}

async function pickArchive() {
  const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Browse', filters: { Archives: ['zip', 'jar', 'vsix', 'war', 'ear', 'whl', 'nupkg', 'tar', 'tgz', 'gz'], 'All files': ['*'] } });
  return r && r[0];
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: SELF_ID, section: PREFIX, message: (n) => `Archive Explorer has opened ${n} archives for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: SELF_ID });
  const tree = new ArchiveTree();
  const treeView = vscode.window.createTreeView(TREE_ID, { treeDataProvider: tree, showCollapseAll: true });
  const provider = new ArchiveEditorProvider(context, tree, treeView);
  const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(e && e.message ? e.message : String(e)); return undefined; } };
  const browse = async (uri) => {
    const target = uri || targetArchive(undefined, tree) || (await pickArchive());
    if (!target) return;
    await store.get(target); // show errors before the tree changes
    const item = tree.add(target);
    await vscode.commands.executeCommand(`${TREE_ID}.focus`);
    await treeView.reveal(item, { expand: true, focus: true, select: true }).catch(() => {});
  };
  const nodeArgs = (x) => (x && x.kind ? [x.uri, x.path] : null);
  context.subscriptions.push(
    treeView, { dispose: () => store.dispose() },
    vscode.workspace.registerFileSystemProvider(SCHEME, new ArchiveFileSystem(), { isCaseSensitive: true, isReadonly: true }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('archiveExplorer.browse', guard((uri) => browse(uri && uri.scheme ? uri : undefined))),
    vscode.commands.registerCommand('archiveExplorer.pickArchive', guard(async () => { const u = await pickArchive(); if (u) await browse(u); })),
    vscode.commands.registerCommand('archiveExplorer.openWith', guard(async (uri) => {
      const target = uri && uri.scheme ? uri : targetArchive(uri, tree);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    })),
    vscode.commands.registerCommand('archiveExplorer.openEntry', guard(async (x) => { const a = nodeArgs(x); if (a) await openEntry(a[0], a[1], false); })),
    vscode.commands.registerCommand('archiveExplorer.openEntryToSide', guard(async (x) => { const a = nodeArgs(x); if (a) await openEntry(a[0], a[1], true); })),
    vscode.commands.registerCommand('archiveExplorer.extract', guard(async (x) => {
      const a = nodeArgs(x) || [targetArchive(x, tree), ''];
      if (a[0]) await runExtract(a[0], a[1]);
    })),
    vscode.commands.registerCommand('archiveExplorer.copyPath', guard(async (x) => {
      if (!x || !x.uri) return;
      const text = x.kind === 'archive' ? (x.uri.scheme === 'file' ? x.uri.fsPath : x.uri.toString()) : x.path;
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`Copied ${text}`, 2500);
    })),
    vscode.commands.registerCommand('archiveExplorer.search', guard(async (x) => {
      let uri = targetArchive(x, tree);
      if (!uri && tree.roots.length > 1) {
        const p = await vscode.window.showQuickPick(tree.roots.map((u) => ({ label: baseName(u), description: u.scheme === 'file' ? u.fsPath : u.toString(), uri: u })), { placeHolder: 'Search names in which archive?' });
        uri = p && p.uri;
      }
      if (!uri) uri = await pickArchive();
      if (!uri) return;
      const arc = await store.get(uri);
      const all = search(arc.tree, '*', 50000);
      const items = all.rows.map((r) => ({ label: r[0], description: r[7].includes('/') ? r[7].slice(0, r[7].lastIndexOf('/')) : '', detail: undefined, path: r[7], dir: r[1] === 1,
        iconPath: r[1] ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File, resourceUri: entryUri(uri, r[7]) }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Search ${fmtCount(all.total)} names in ${arc.name}${all.total > items.length ? ` (first ${fmtCount(items.length)})` : ''}`, matchOnDescription: true });
      if (!pick) return;
      if (pick.dir) {
        tree.add(uri);
        await vscode.commands.executeCommand(`${TREE_ID}.focus`);
        await treeView.reveal(tree.item({ kind: 'node', uri, path: pick.path }), { expand: true, focus: true, select: true }).catch(() => {});
      } else await openEntry(uri, pick.path, false);
    })),
    vscode.commands.registerCommand('archiveExplorer.close', (x) => { if (x && x.uri) tree.remove(x.uri); }),
    vscode.commands.registerCommand('archiveExplorer.closeAll', () => tree.clear()),
    vscode.commands.registerCommand('archiveExplorer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${SELF_ID}#archiveExplorer.start`, false)),
  );
  tree.refresh();
  return { tree, store, provider };
}

function deactivate() { store.dispose(); }

module.exports = { activate, deactivate, ArchiveEditorProvider, ArchiveFileSystem, ArchiveTree, ArchiveStore, entryUri, parseEntryUri, runExtract, openEntry, blockReason, VIEW_TYPE, SCHEME, TREE_ID, ARCHIVE_RE, store };
