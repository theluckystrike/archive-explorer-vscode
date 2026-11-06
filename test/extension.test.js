'use strict';
// The extension host on a mocked VS Code API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { samples } = require('./helpers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zae-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

class Uri {
  constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.query = query; this.fragment = ''; }
  static file(p) { return new Uri('file', p); }
  static from(o) { return new Uri(o.scheme, o.path || '', o.query || ''); }
  static parse(s) {
    if (s.startsWith('file://')) return Uri.file(decodeURIComponent(s.slice(7)));
    const m = /^([a-z-]+):([^?]*)(?:\?(.*))?$/.exec(s);
    return m ? new Uri(m[1], m[2], m[3] ? decodeURIComponent(m[3]) : '') : new Uri('https', s);
  }
  static joinPath(u, ...s) { return new Uri(u.scheme, path.posix.join(u.path, ...s), u.query); }
  get fsPath() { return this.path; }
  with(o) { return new Uri(o.scheme ?? this.scheme, o.path ?? this.path, o.query ?? this.query); }
  toString() { return this.scheme === 'file' ? 'file://' + this.path : `${this.scheme}:${this.path}${this.query ? '?' + encodeURIComponent(this.query) : ''}`; }
}
class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { for (const f of this.l) f(v); } }
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class FsErr extends Error {}
const state = { config: {}, openDialog: null, saveDialog: null, clipboard: '', executed: [], warnings: [], infos: [], errors: [], status: [] };
const vscodeMock = {
  Uri, EventEmitter, TreeItem,
  Disposable: class { constructor(f) { this.dispose = f; } },
  ThemeIcon: Object.assign(class { constructor(id) { this.id = id; } }, { File: 'file', Folder: 'folder' }),
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  FileType: { File: 1, Directory: 2 }, FilePermission: { Readonly: 1 },
  FileSystemError: { FileNotFound: (u) => new FsErr('not found ' + u), FileNotADirectory: () => new FsErr('not dir'), FileIsADirectory: () => new FsErr('is dir'),
    Unavailable: (m) => new FsErr(String(m)), NoPermissions: (m) => new FsErr(String(m)) },
  ViewColumn: { Active: -1, Beside: -2 }, ProgressLocation: { Notification: 15 }, QuickPickItemKind: { Separator: -1 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    fs: {
      stat: async (u) => { const s = fs.statSync(u.fsPath); return { size: s.size, mtime: s.mtimeMs }; },
      readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
      writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d),
      createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true }),
    },
    fsProviders: {}, registerFileSystemProvider(s, p, o) { this.fsProviders[s] = [p, o]; return { dispose() {} }; },
    isTrusted: true, workspaceFolders: undefined,
  },
  window: {
    registered: [], state: { focused: true }, tabGroups: { activeTabGroup: { activeTab: null } },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    createTreeView(id, o) { this.treeId = id; this.treeOpts = o; return { dispose() {}, reveal: async () => {} }; },
    showOpenDialog: async () => state.openDialog, showSaveDialog: async () => state.saveDialog,
    showWarningMessage: async (...a) => { state.warnings.push(a[0]); return state.warnAnswer; },
    showInformationMessage: async (...a) => { state.infos.push(a[0]); },
    showErrorMessage: async (m) => { state.errors.push(m); },
    setStatusBarMessage: (m) => { state.status.push(m); },
    withProgress: async (o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
    showQuickPick: async () => undefined,
  },
  commands: {
    list: [], handlers: {},
    registerCommand(id, fn) { this.list.push(id); this.handlers[id] = fn; return { dispose() {} }; },
    executeCommand: async (...a) => { state.executed.push(a); },
  },
  extensions: { getExtension: () => undefined },
  env: { clipboard: { writeText: async (t) => { state.clipboard = t; } }, sessionId: 's1', openExternal: async () => true },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');
const pkg = require('../package.json');

const ctx = { extensionUri: Uri.file('/ext'), subscriptions: [], globalState: { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); } } };
const api = ext.activate(ctx);

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: (u) => 'https://res' + u.path, postMessage: async (m) => { sent.push(m); return true; }, onDidReceiveMessage: (h) => { handler = h; } },
    onDidDispose: (h) => { dispose = h; },
  };
  return { panel, sent, send: (m) => handler(m), close: () => dispose() };
}
async function openEditor(file) {
  const f = fakePanel();
  await api.provider.resolveCustomEditor({ uri: Uri.file(file) }, f.panel);
  return f;
}
const sample = (n) => path.join(samples(), n);

test('activate: registers the editor, the tree, the file system and every command in package.json', () => {
  assert.equal(vscodeMock.window.registered[0][0], 'archiveExplorer.editor');
  assert.equal(pkg.contributes.customEditors[0].viewType, ext.VIEW_TYPE);
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map((s) => s.filenamePattern), ['*.zip', '*.jar', '*.vsix', '*.tar', '*.tgz', '*.gz'], '*.gz covers .tar.gz; a second pattern makes VS Code report two default editors');
  assert.equal(vscodeMock.window.treeId, pkg.contributes.views.explorer[0].id);
  assert.deepEqual(vscodeMock.workspace.fsProviders['zovo-archive'][1], { isCaseSensitive: true, isReadonly: true });
  assert.ok(pkg.activationEvents.includes('onFileSystem:zovo-archive'));
  assert.deepEqual(vscodeMock.commands.list.slice().sort(), pkg.contributes.commands.map((c) => c.command).sort());
  assert.ok(pkg.displayName.toLowerCase().startsWith('zip viewer') && pkg.displayName.length <= 45);
  assert.ok(pkg.keywords.length <= 30);
});

test('editor: ready gives the summary and the root listing, list and search page through it', async () => {
  const f = await openEditor(sample('web-app-release.zip'));
  await f.send({ type: 'ready' });
  const init = f.sent.find((m) => m.type === 'init');
  assert.equal(init.formatLabel, 'ZIP');
  assert.equal(init.summary.files, 13);
  assert.equal(init.comment, 'orders-service 2.4.1 release');
  assert.deepEqual(init.rows.map((r) => r[0]), ['orders-service']);
  assert.match(init.ratio, /^\d+(\.\d)?:1$/);
  await f.send({ type: 'list', path: 'orders-service/src' });
  assert.deepEqual(f.sent.at(-1).rows.map((r) => r[0]), ['app.js', 'config.js']);
  await f.send({ type: 'search', query: '*.png' });
  assert.deepEqual(f.sent.at(-1).rows.map((r) => r[7]), ['orders-service/assets/chart.png', 'orders-service/assets/logo.png']);
  await f.send({ type: 'list', path: 'nope' });
  assert.equal(f.sent.at(-1).type, 'error');
  assert.equal(api.tree.roots.length >= 1, true, 'the archive shows in the Explorer tree');
  f.close();
});

test('editor: open sends a read-only entry URI to vscode.open, copy path, unknown messages dropped', async () => {
  const f = await openEditor(sample('web-app-release.zip'));
  await f.send({ type: 'ready' });
  state.executed = [];
  await f.send({ type: 'open', path: 'orders-service/src/app.js', side: true });
  const [cmd, uri, opts] = state.executed.find((a) => a[0] === 'vscode.open');
  assert.equal(cmd, 'vscode.open');
  assert.equal(uri.scheme, 'zovo-archive');
  assert.equal(uri.path, '/web-app-release.zip/orders-service/src/app.js');
  assert.equal(opts.viewColumn, -2);
  const back = ext.parseEntryUri(Uri.parse(uri.toString()));
  assert.equal(back.path, 'orders-service/src/app.js');
  assert.equal(back.archive.fsPath, sample('web-app-release.zip'));
  await f.send({ type: 'copyPath', path: 'orders-service/data/sales-2026.csv' });
  assert.equal(state.clipboard, 'orders-service/data/sales-2026.csv');
  const n = f.sent.length;
  await f.send({ type: 'writeFile', path: '/etc/hosts', data: 'x' });
  await f.send({ type: 'openExternal', url: 'https://example.com' });
  assert.equal(f.sent.length, n);
  f.close();
});

test('file system: entries read through the provider, writes refused, size limit message', async () => {
  const [fsp] = vscodeMock.workspace.fsProviders['zovo-archive'];
  const arcUri = Uri.file(sample('dataset.tar'));
  const u = ext.entryUri(arcUri, 'dataset/schema.json');
  assert.match(new TextDecoder().decode(await fsp.readFile(u)), /"revenue"/);
  assert.equal((await fsp.stat(u)).type, 1);
  assert.equal((await fsp.stat(ext.entryUri(arcUri, 'dataset'))).type, 2);
  assert.deepEqual((await fsp.readDirectory(ext.entryUri(arcUri, 'dataset/charts'))).map((x) => x[0]), ['revenue.png']);
  assert.throws(() => fsp.writeFile(u, new Uint8Array(1)), /read-only/);
  await assert.rejects(fsp.readFile(ext.entryUri(arcUri, 'dataset/missing.txt')), /not found/);
  state.config.maxEntryMB = 1;
  ext.store.drop(Uri.file(sample('server.log.gz')).toString());
  await assert.rejects(fsp.readFile(ext.entryUri(Uri.file(sample('server.log.gz')), 'server.log')), /unpacks to more than 1.0 MB/);
  delete state.config.maxEntryMB;
});

test('open: blocked entries get a warning, not an editor', async () => {
  state.executed = []; state.warnings = [];
  const ok = await ext.openEntry(Uri.file(sample(path.join('security-tests', 'zip-bomb.zip'))), 'zeros-01.bin', false);
  assert.equal(ok, false);
  assert.match(state.warnings.at(-1), /600 MB unpacked. Archive Explorer opens entries up to 512 MB/);
  assert.ok(!state.executed.some((a) => a[0] === 'vscode.open'));
  await ext.openEntry(Uri.file(sample('site-backup.tar.gz')), 'www/current', false);
  assert.match(state.warnings.at(-1), /is a link to "releases\/2026-11-06"/);
});

test('extract: folder picker for folders, save dialog for one file, result message', async () => {
  const out = path.join(tmp, 'x1');
  fs.mkdirSync(out);
  state.openDialog = [Uri.file(out)]; state.infos = [];
  const res = await ext.runExtract(Uri.file(sample('hello-plugin.jar')), 'com');
  assert.equal(res.written, 3);
  assert.ok(fs.existsSync(path.join(out, 'com', 'zovo', 'hello', 'util', 'Strings.class')));
  assert.match(state.infos.at(-1), /^Extracted 3 files \(.+\) to /);
  state.saveDialog = Uri.file(path.join(out, 'MANIFEST.txt'));
  const one = await ext.runExtract(Uri.file(sample('hello-plugin.jar')), 'META-INF/MANIFEST.MF');
  assert.equal(one.written, 1);
  assert.match(fs.readFileSync(path.join(out, 'MANIFEST.txt'), 'utf8'), /Main-Class/);
  state.saveDialog = Uri.file(sample('hello-plugin.jar'));
  assert.equal(await ext.runExtract(Uri.file(sample('hello-plugin.jar')), 'plugin.yml'), null, 'never overwrites the archive');
  state.openDialog = undefined;
  assert.equal(await ext.runExtract(Uri.file(sample('hello-plugin.jar')), ''), null, 'cancel writes nothing');
  const bombOut = path.join(tmp, 'bomb');
  fs.mkdirSync(bombOut);
  state.openDialog = [Uri.file(bombOut)]; state.errors = [];
  const r = await ext.runExtract(Uri.file(sample(path.join('security-tests', 'zip-bomb.zip'))), '');
  assert.equal(r.written, 0);
  assert.match(state.errors.at(-1), /would write 2.3 GB. The limit is 2.0 GB/);
  assert.deepEqual(fs.readdirSync(bombOut), []);
});

test('tree: archive roots, folder children with sizes, file items open the entry', async () => {
  const t = api.tree;
  t.clear();
  t.add(Uri.file(sample('web-app-release.zip')));
  const [root] = await t.getChildren();
  const ri = await t.getTreeItem(root);
  assert.equal(ri.label, 'web-app-release.zip');
  assert.match(ri.description, /^ZIP · 13 files · /);
  const [svc] = await t.getChildren(root);
  const kids = await t.getChildren(svc);
  const names = await Promise.all(kids.map(async (k) => (await t.getTreeItem(k)).label));
  assert.deepEqual(names.slice(0, 3), ['assets', 'data', 'docs']);
  const logItem = await t.getTreeItem(kids.find((k) => k.path.endsWith('.log')) || (await t.getChildren(kids.find((k) => k.path.endsWith('/logs'))))[0]);
  assert.match(logItem.description, /MB · \d+:1$/);
  assert.equal(logItem.command.command, 'archiveExplorer.openEntry');
  assert.equal(logItem.contextValue, 'entry.file');
  assert.equal(t.getParent(kids[0]).path, 'orders-service');
  await vscodeMock.commands.handlers['archiveExplorer.copyPath'](kids[0]);
  assert.equal(state.clipboard, 'orders-service/assets');
  t.add(Uri.file(path.join(tmp, 'not-there.zip')));
  const items = await t.getChildren();
  const err = await t.getChildren(items[1]);
  assert.equal(err[0].kind, 'error');
  t.clear();
  assert.equal(t.roots.length, 0);
});

test('editor: errors for non-archives, rendered counts once per tab', async () => {
  const bad = path.join(tmp, 'fake.zip');
  fs.writeFileSync(bad, 'not really a zip file but long enough to scan for an end record');
  const f = await openEditor(bad);
  await f.send({ type: 'ready' });
  assert.equal(f.sent.at(-1).type, 'error');
  assert.match(f.sent.at(-1).message, /not a ZIP archive/);
  const g = await openEditor(sample('dataset.tar'));
  await g.send({ type: 'ready' });
  assert.equal(g.sent.find((m) => m.type === 'init').ratio, '', 'no ratio for an uncompressed TAR');
  const before = JSON.stringify(ctx.globalState.data.get('zovo.rating.v1') || {});
  await g.send({ type: 'rendered' }); await g.send({ type: 'rendered' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((ctx.globalState.data.get('zovo.rating.v1') || {}).count, (JSON.parse(before).count || 0) + 1);
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('archiveExplorer.supportDeveloper') && ids.includes('archiveExplorer.moreViewers'));
  const prop = pkg.contributes.configuration.properties['archiveExplorer.showSupportLinks'];
  assert.equal(prop.default, true);
  assert.ok(support.otherProducts('zovo.zip-archive-explorer').every((p) => p.id !== 'zovo.zip-archive-explorer'));
});

test('support: the footer shows by default and archiveExplorer.showSupportLinks=false hides it', async () => {
  try {
    for (const [val, shown] of [[undefined, true], [true, true], [false, false]]) {
      if (val === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = val;
      const f = await openEditor(sample('hello-plugin.jar'));
      const html = f.panel.webview.html;
      assert.equal(/id="zovo-support"/.test(html), shown, String(val));
      assert.equal(html.includes('command:archiveExplorer.supportDeveloper'), shown);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['archiveExplorer.supportDeveloper', 'archiveExplorer.moreViewers', 'workbench.action.openSettings']);
    }
  } finally { delete state.config.showSupportLinks; }
});
