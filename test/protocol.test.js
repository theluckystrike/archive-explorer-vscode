'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateWebviewMessage, ratioText, ratioWarning } = require('../src/core/protocol');
const { buildHtml } = require('../src/html');
const V = require('../src/webview/view');

test('protocol: only known webview messages with valid fields pass', () => {
  const ok = (m) => validateWebviewMessage(m).ok;
  assert.ok(ok({ type: 'ready' }) && ok({ type: 'rendered' }) && ok({ type: 'extractAll' }) && ok({ type: 'revealTree' }));
  assert.deepEqual(validateWebviewMessage({ type: 'open', path: 'a/b.txt', side: 'yes', extra: 1 }).msg, { type: 'open', path: 'a/b.txt', side: false });
  assert.ok(ok({ type: 'list', path: '' }) && ok({ type: 'search', query: '*.js' }) && ok({ type: 'extract', path: 'a' }) && ok({ type: 'copyPath', path: 'a' }));
  for (const bad of [null, 'ready', {}, { type: 'writeFile', path: '/etc/x' }, { type: 'openExternal', url: 'https://x' }, { type: 'open', path: '' },
    { type: 'list', path: 5 }, { type: 'search', query: 'x'.repeat(201) }, { type: 'open', path: 'a\0b' }, { type: 'extract', path: 'x'.repeat(5000) }]) {
    assert.equal(ok(bad), false, JSON.stringify(bad));
  }
});

test('ratio: text and the zip bomb warning', () => {
  assert.equal(ratioText(1000, 250), '4.0:1');
  assert.equal(ratioText(1000, 1000), '1:1');
  assert.equal(ratioText(1000, 1020), '1:1');
  assert.equal(ratioText(1024, 20480), '0.05:1');
  assert.equal(ratioText(100000, 3), '33333:1');
  assert.equal(ratioText(10, -1), '');
  assert.equal(ratioText(0, 0), '');
  assert.equal(ratioWarning(10 * 1024 * 1024, 1000), '', 'small archives are not flagged');
  assert.match(ratioWarning(2.4 * 1024 ** 3, 2.5 * 1024 * 1024), /Very high compression ratio \(983:1\)/);
  assert.equal(V.ratioText(1000, 250), ratioText(1000, 250));
});

test('html: strict CSP with a nonce, no remote or inline-unsafe sources, escaped title', () => {
  const html = buildHtml({ cspSource: 'https://res.vscode', scriptUri: 'https://res.vscode/w.js', styleUri: 'https://res.vscode/s.css', title: '<img src=x onerror=alert(1)>.zip', nonce: 'N0NCE' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0NCE'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|http:|\*/);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.zip'));
});

test('webview code: no innerHTML, eval, network or style attributes', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'main.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'src', 'webview', 'view.js'), 'utf8');
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\(/, /new Function/, /fetch\(/, /XMLHttpRequest/, /WebSocket/, /setAttribute\(\s*['"]style/, /document\.write/]) {
    assert.doesNotMatch(code, bad, String(bad));
  }
  const host = ['extension.js', 'extract.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.doesNotMatch(host, /require\(['"](https?|net|child_process)['"]\)|fetch\(/);
});

test('view helpers: sizes, dates, sorting, crumbs, icons', () => {
  assert.equal(V.fmtSize(0), '0 B');
  assert.equal(V.fmtSize(1536), '1.5 KB');
  assert.equal(V.fmtSize(-1), '');
  assert.equal(V.fmtDate(new Date(2026, 10, 6, 9, 5).getTime()), '2026-11-06 09:05');
  assert.equal(V.fmtDate(0), '');
  const rows = [['b.txt', 0, 10, 5, 1, 0, 0, 'b.txt'], ['dir', 1, 50, 10, 1, 0, 2, 'dir'], ['a.txt', 0, 99, 9, 1, 0, 0, 'a.txt'], ['c.bin', 0, 30, 30, 1, 0, 0, 'c.bin']];
  assert.deepEqual(V.sortRows(rows, 'name', false).map((r) => r[0]), ['dir', 'a.txt', 'b.txt', 'c.bin']);
  assert.deepEqual(V.sortRows(rows, 'size', true).map((r) => r[0]), ['dir', 'a.txt', 'c.bin', 'b.txt']);
  assert.deepEqual(V.sortRows(rows, 'ratio', true).map((r) => r[0]), ['dir', 'a.txt', 'b.txt', 'c.bin']);
  assert.deepEqual(V.crumbs('a/b/c'), [{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }, { name: 'c', path: 'a/b/c' }]);
  assert.equal(V.parentOf('a/b/c'), 'a/b');
  assert.equal(V.parentOf('a'), '');
  assert.equal(V.kindOf('x.PNG', 0), 'image');
  assert.equal(V.kindOf('lib.jar', 0), 'archive');
  assert.equal(V.kindOf('src', 1), 'folder');
  assert.equal(V.flagText(1 | 8), 'unsafe name, never extracted, link');
});
