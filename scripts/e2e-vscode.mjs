// Release check in a real VS Code: installs the .vsix into an isolated profile, opens the generated sample archives,
// drives the webview and the Explorer tree with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const out = path.join(work, 'extract-out');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; };
for (const f of walk(ws)) R.hashes[path.relative(ws, f)] = hash(f);
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const clipBefore = (() => { try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return null; } })();
const vs = await launch(work, Number(port), ws, { 'files.simpleDialog.enable': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'workbench.sideBar.location': 'left', 'explorer.compactFolders': false, 'workbench.editor.enablePreview': false });
const shots = [];
const shot = async (name) => { const f = path.join(shotDir, `archive-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 500), ms: Date.now() - t0 }); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = (expr) => vs.wvEval(wv, expr);
const getWv = async (title) => vs.waitFor(async () => (await vs.webviews()).find((w) => w.title === title && w.w > 0), 20000);
const rows = () => E(`[...document.querySelectorAll('.row.item .nm')].map(e => e.textContent)`);
const ready = () => vs.waitFor(() => E(`document.querySelectorAll('.row.item').length > 0 && document.querySelectorAll('.row.item').length`), 20000, 150);
const open = async (file) => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(path.basename(file)); if (!wv) throw new Error('no webview for ' + file); if (!(await ready())) throw new Error('no rows'); return Date.now() - t0; };
const row = (name) => `[...document.querySelectorAll('.row.item')].find(r => r.querySelector('.nm').textContent === ${JSON.stringify(name)})`;
const dbl = (name) => vs.wvClick(wv, row(name), { count: 2 });
const home = async () => { await vs.wvClick(wv, `document.querySelector('.crumb.root')`); await sleep(500); await ready(); };
const btn = (t) => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(t)})`;
const activeTab = () => vs.wbEval(`(document.querySelector('.tabs-container .tab.active .label-name') || {}).textContent || ''`);
const editorText = () => vs.wbEval(`[...document.querySelectorAll('.editor-instance .view-lines')].map(e => e.innerText).join('\\n')`);
const notes = async () => (await vs.notifications()).join(' | ');
const clearNotes = () => vs.command('Notifications: Clear All Notifications').catch(() => {});
const banner = () => E(`document.querySelector('.banner').textContent`);
// the image preview is VS Code's own webview: look for a loaded <img> in any frame
const imagePreview = async () => {
  for (const [sid, info] of vs.attached) {
    if (sid === vs.wb || info.type !== 'iframe') continue;
    for (const c of vs.ctx.get(sid) || []) {
      try { const r = await vs.s.send('Runtime.evaluate', { expression: `(() => { const i = document.querySelector('img'); return i && i.complete ? i.naturalWidth + 'x' + i.naturalHeight + '|' + document.body.getBoundingClientRect().width : '' })()`, contextId: c.id, returnByValue: true }, sid);
        const v = String(r.result.value || ''); if (v && Number(v.split('|')[1]) > 0) return v.split('|')[0]; } catch {}
    }
  }
  return '';
};
// pick a folder in the simple file dialog
const pickFolder = async (dir) => {
  await vs.waitFor(() => vs.wbEval(`!!document.querySelector('.quick-input-widget input') && document.querySelector('.quick-input-widget').style.display !== 'none'`), 8000);
  const ib = JSON.parse(await vs.wbEval(`JSON.stringify(document.querySelector('.quick-input-widget input').getBoundingClientRect())`));
  await vs.click(ib.x + ib.width / 2, ib.y + ib.height / 2); await vs.key('a', 'KeyA', 4, 65); await vs.type(dir + '/');
  await sleep(1200); await vs.key('Enter', 'Enter'); await sleep(1200);
  const still = await vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent); })()`);
  if (still) { await vs.key('Enter', 'Enter'); await sleep(1200); }
};
const treeText = () => vs.wbEval(`(() => { const p = [...document.querySelectorAll('.pane')].find(p => /Archive Explorer/i.test((p.querySelector('.pane-header') || {}).textContent || '')); return p ? p.querySelector('.pane-body') ? p.querySelector('.pane-body').innerText : 'collapsed' : 'missing'; })()`);

try {
  await sleep(2500);
  await step('ZIP opens as the default editor with folders, sizes and ratios', async () => {
    const ms = await open('web-app-release.zip');
    const top = await rows();
    await dbl('orders-service'); await sleep(500);
    const inner = await rows();
    const summary = await E(`document.querySelector('.summary').textContent`);
    const crumbs = await E(`document.querySelector('.crumbs').textContent`);
    if (top.join() !== 'orders-service' || !inner.includes('src') || !inner.includes('deploy.yaml') || !/14|13 files/.test(summary)) throw new Error(JSON.stringify({ top, inner, summary }));
    return { openMs: ms, rows: inner, summary, crumbs };
  });
  await step('Browse in Archive Explorer shows the tree in the side bar', async () => {
    await vs.command('Archive Explorer: Browse in Archive Explorer'); await sleep(1200);
    const t = await vs.waitFor(async () => { const x = await treeText(); return /web-app-release\.zip/.test(x) && /orders-service/.test(x) && x; }, 8000);
    if (!t) throw new Error(await treeText());
    // expand orders-service in the tree
    const b = JSON.parse(await vs.wbEval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(r => r.innerText.trim().startsWith('orders-service')); if (!r) return 'null'; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2 }); })()`));
    if (b) { await vs.click(b.x, b.y); await sleep(800); }
    const t2 = await treeText();
    await vs.wvClick(wv, row('src'), { count: 1 });
    await shot('zip-editor-and-tree');
    return t2.split('\n').slice(0, 14).join(' / ');
  });
  await step('double-click a JS entry: read-only editor tab with syntax colors', async () => {
    await dbl('src'); await sleep(500);
    await dbl('app.js'); await sleep(1500);
    const tab = await activeTab();
    const text = await editorText();
    const tokens = await vs.wbEval(`new Set([...document.querySelectorAll('.editor-instance .view-lines span span')].map(s => s.className)).size`);
    const ro = await vs.wbEval(`(document.querySelector('.editor-instance .monaco-editor textarea') || {}).readOnly`);
    if (tab !== 'app.js' || !/createServer/.test(text) || tokens < 3) throw new Error(JSON.stringify({ tab, tokens, text: text.slice(0, 100) }));
    await vs.key('x', 'KeyX'); await sleep(300);
    const after = await editorText();
    return { tab, tokenClasses: tokens, textareaReadOnly: ro, typingBlocked: after === text };
  });
  await step('tree click opens an entry; image entry opens in the image preview', async () => {
    const b = JSON.parse(await vs.wbEval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(r => r.innerText.trim().startsWith('assets')); if (!r) return 'null'; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2 }); })()`));
    if (!b) throw new Error('assets row not in tree: ' + (await treeText()).slice(0, 300));
    await vs.click(b.x, b.y); await sleep(800);
    const l = JSON.parse(await vs.wbEval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(r => r.innerText.trim().startsWith('logo.png')); if (!r) return 'null'; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 50, y: b.y + b.height / 2 }); })()`));
    if (!l) throw new Error('logo.png not in tree');
    await vs.click(l.x, l.y);
    const img = await vs.waitFor(imagePreview, 10000, 300);
    const tab = await activeTab();
    await shot('image-entry-from-tree');
    if (!img || tab !== 'logo.png') throw new Error(JSON.stringify({ img, tab }));
    return { tab, image: img };
  });
  await step('search names with a wildcard', async () => {
    await open('web-app-release.zip'); await home();
    await vs.wvClick(wv, `document.querySelector('.search')`); await E(`document.querySelector('.search').focus() || 1`); await vs.type('*.png'); await sleep(800);
    const r = await rows();
    const crumbs = await E(`document.querySelector('.crumbs').textContent`);
    await vs.wvClick(wv, row('orders-service/assets/logo.png'));
    await shot('search-results');
    if (r.length !== 2 || !/2 matches/.test(crumbs)) throw new Error(JSON.stringify({ r, crumbs }));
    await vs.wvClick(wv, `document.querySelector('.search')`); await E(`document.querySelector('.search').focus() || 1`); await vs.key('Escape', 'Escape'); await sleep(500);
    return { rows: r, crumbs };
  });
  await step('Copy path puts the inner path on the clipboard', async () => {
    await home(); await dbl('orders-service'); await sleep(400); await dbl('data'); await sleep(400);
    await vs.wvClick(wv, row('sales-2026.csv'));
    await vs.wvClick(wv, btn('Copy path')); await sleep(600);
    const clip = execSync('pbpaste', { encoding: 'utf8' });
    if (clip !== 'orders-service/data/sales-2026.csv') throw new Error(clip);
    return clip;
  });
  await step('nested ZIP entry opens as another archive', async () => {
    await vs.wvClick(wv, `document.querySelector('.crumb.root')`); await sleep(400);
    await dbl('orders-service'); await sleep(400); await dbl('test'); await sleep(400); await dbl('fixtures.zip'); await sleep(1500);
    wv = await getWv('fixtures.zip');
    if (!wv) throw new Error('no nested webview');
    await ready();
    const r = await rows();
    await dbl('fixtures'); await sleep(400);
    const r2 = await rows();
    if (r.join() !== 'fixtures' || !r2.includes('orders.json')) throw new Error(JSON.stringify({ r, r2 }));
    return { rows: r2, tab: await activeTab() };
  });
  await step('extract a folder through the folder dialog', async () => {
    await open('web-app-release.zip'); await home();
    await dbl('orders-service'); await sleep(400);
    await vs.wvClick(wv, row('src'));
    await vs.wvClick(wv, btn('Extract...')); await sleep(1200);
    const target = path.join(out, 'folder');
    fs.mkdirSync(target, { recursive: true });
    await pickFolder(target);
    const ok = await vs.waitFor(() => fs.existsSync(path.join(target, 'src', 'app.js')) && fs.existsSync(path.join(target, 'src', 'config.js')), 8000);
    const n = await notes();
    if (!ok) throw new Error('files missing; notifications: ' + n);
    await clearNotes();
    return { files: walk(target).map((f) => path.relative(target, f)), note: n.slice(0, 200) };
  });
  await step('zip slip: unsafe names are flagged and never written', async () => {
    await open('security-tests/zip-slip.zip');
    const b = await banner();
    const r = await rows();
    await vs.wvClick(wv, btn('Extract all...')); await sleep(1200);
    const target = path.join(out, 'slip', 'inner');
    fs.mkdirSync(target, { recursive: true });
    await pickFolder(target);
    await vs.waitFor(() => fs.existsSync(path.join(target, 'safe', 'readme.txt')), 8000);
    await sleep(800);
    const n = await notes();
    const written = walk(path.join(out, 'slip')).map((f) => path.relative(path.join(out, 'slip'), f));
    const outside = fs.existsSync(path.join(out, 'outside.txt')) || fs.existsSync(path.join(out, 'slip', 'escape.txt')) || fs.existsSync('/tmp/absolute.txt');
    await shot('zip-slip');
    if (written.join() !== 'inner/safe/readme.txt' || outside || !/unsafe names/.test(b) || !/Skipped 3/.test(n)) throw new Error(JSON.stringify({ written, outside, b, n }));
    await clearNotes();
    return { banner: b, rows: r, written, note: n.slice(0, 260) };
  });
  await step('zip bomb: warnings, open refused over the limit, extract refused before writing', async () => {
    await open('security-tests/zip-bomb.zip');
    const b = await banner();
    await dbl('zeros-01.bin'); await sleep(1200);
    const n1 = await notes();
    await shot('zip-bomb-warning');
    await clearNotes();
    await vs.wvClick(wv, btn('Extract all...')); await sleep(1200);
    const target = path.join(out, 'bomb');
    fs.mkdirSync(target, { recursive: true });
    await pickFolder(target);
    await sleep(1500);
    const n2 = await notes();
    const written = walk(target);
    await clearNotes();
    await dbl('liar.txt'); await sleep(1500);
    const tab = await activeTab();
    const text = await editorText();
    if (!/very high compression ratio/i.test(b) || !/600 MB unpacked/.test(n1) || !/would write 2.3 GB/.test(n2) || written.length) throw new Error(JSON.stringify({ b, n1, n2, written }));
    return { banner: b, open: n1.slice(0, 200), extract: n2.slice(0, 220), liarTab: tab, liarEditor: text.slice(0, 160) };
  });
  await step('TAR.GZ with a long name and a symlink; JAR, VSIX and TAR labels', async () => {
    await clearNotes();
    await open('site-backup.tar.gz'); await sleep(1000);
    const conflict = /multiple default editors/i.test(await notes());
    if (conflict) throw new Error('VS Code reports multiple default editors for .tar.gz');
    const label = await E(`document.querySelector('.badge').textContent`);
    await dbl('www'); await sleep(400);
    const r = await rows();
    const flag = await E(`(${row('current')}).querySelector('.flag').textContent`);
    const labels = { 'site-backup.tar.gz': label };
    for (const f of ['hello-plugin.jar', 'sample-extension.vsix', 'dataset.tar']) { await open(f); labels[f] = await E(`document.querySelector('.badge').textContent`); }
    if (label !== 'TAR.GZ' || !r.includes('current') || !/link/.test(flag) || labels['hello-plugin.jar'] !== 'JAR (ZIP)' || labels['dataset.tar'] !== 'TAR') throw new Error(JSON.stringify({ r, flag, labels }));
    return { rows: r, flag, labels };
  });
  await step('single-file GZ: one entry, opens as text', async () => {
    await open('server.log.gz');
    const r = await rows();
    await dbl('server.log'); await sleep(1500);
    const tab = await activeTab();
    const text = await editorText();
    if (r.join() !== 'server.log' || tab !== 'server.log' || !/INFO\s+api\s+request/.test(text)) throw new Error(JSON.stringify({ r, tab, text: text.slice(0, 100) }));
    return { rows: r, tab };
  });
  await step('light theme', async () => {
    // switch the theme through the isolated profile's settings.json; VS Code applies it live
    const sf = path.join(work, 'ud', 'User', 'settings.json');
    fs.writeFileSync(sf, JSON.stringify({ ...JSON.parse(fs.readFileSync(sf, 'utf8')), 'workbench.colorTheme': 'Default Light Modern' }, null, 1));
    const light = await vs.waitFor(() => vs.wbEval(`document.body.classList.contains('vs') || !!document.querySelector('.monaco-workbench.vs')`), 10000, 300);
    if (!light) throw new Error('theme did not switch');
    await clearNotes();
    await open('dataset.tar'); await sleep(800);
    if (/multiple default editors/i.test(await notes())) throw new Error('multiple default editors for .tar');
    await dbl('dataset'); await sleep(400);
    await vs.wvClick(wv, row('sales-2026.csv'));
    await shot('dataset-tar-light');
    return true;
  });
} finally {
  R.console = vs.console.filter((c) => !/copilot|CloudSandboxApi|LESS API|reading 'selection'/i.test(c.text));
  R.logErrors = [];
  for (const f of vs.extHostLogs()) { const t = fs.readFileSync(f, 'utf8'); for (const l of t.split('\n')) if (/\[error\]/.test(l) && /archive|zovo/i.test(l)) R.logErrors.push(l.slice(0, 300)); }
  await vs.close();
  if (clipBefore !== null) try { execSync('pbcopy', { input: clipBefore }); } catch {}
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => hash(path.join(ws, f)) === h);
  R.extracted = walk(out).map((f) => path.relative(out, f));
  R.shots = shots;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(JSON.stringify({ steps: R.steps.map((s) => [s.ok ? 'PASS' : 'FAIL', s.name, s.error || '']), console: R.console, logErrors: R.logErrors, unchanged: R.unchanged, install: R.install.code }, null, 1));
}
