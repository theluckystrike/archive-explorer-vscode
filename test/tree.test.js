'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTree, find, listFolder, search, collect, summary } = require('../src/core/tree');

const e = (path, size, packed, extra = {}) => ({ path, raw: path, unsafe: null, dir: false, kind: 'file', size, packed, mtime: 1000, supported: true, encrypted: false, ...extra });

test('tree: implicit folders, sums, counts, duplicates', () => {
  const t = buildTree([e('a/b/c.txt', 100, 40), e('a/b/d.txt', 50, 10), e('a/x.bin', 1000, 1000), e('top.md', 5, 5), e('a/x.bin', 1, 1)]);
  const a = find(t, 'a');
  assert.equal(a.size, 1150);
  assert.equal(a.packed, 1050);
  assert.equal(a.files, 3);
  assert.equal(a.dirs, 1);
  assert.equal(t.root.files, 4);
  assert.equal(t.dupes, 1);
  assert.match(t.problems[0], /repeat a name/);
  assert.deepEqual(summary(t, 2000), { files: 4, dirs: 2, size: 1155, packed: 1055, archiveSize: 2000 });
});

test('tree: folders first, natural sort, rows carry the full path', () => {
  const t = buildTree([e('f10.txt', 1, 1), e('f2.txt', 1, 1), e('z/inner.txt', 1, 1), e('B.txt', 1, 1)]);
  const rows = listFolder(t, '');
  assert.deepEqual(rows.map((r) => r[0]), ['z', 'B.txt', 'f2.txt', 'f10.txt']);
  assert.equal(rows[0][1], 1);
  assert.equal(rows[0][6], 1);
  assert.equal(listFolder(t, 'z')[0][7], 'z/inner.txt');
  assert.equal(listFolder(t, 'nope'), null);
  assert.equal(listFolder(t, 'B.txt'), null);
});

test('tree: tar entries have unknown packed size', () => {
  const t = buildTree([e('a/b.txt', 10, null)]);
  assert.equal(listFolder(t, '')[0][3], -1);
  assert.equal(listFolder(t, 'a')[0][3], -1);
});

test('search: plain text anywhere in the path, wildcards on names, a cap', () => {
  const t = buildTree([e('src/app.js', 1, 1), e('src/lib/util.js', 1, 1), e('docs/app-notes.md', 1, 1), e('README.md', 1, 1)]);
  assert.deepEqual(search(t, 'app').rows.map((r) => r[7]), ['docs/app-notes.md', 'src/app.js']);
  assert.deepEqual(search(t, '*.md').rows.map((r) => r[7]), ['docs/app-notes.md', 'README.md']);
  assert.deepEqual(search(t, 'src').rows.map((r) => r[7]), ['src', 'src/app.js', 'src/lib', 'src/lib/util.js']);
  const capped = search(t, '*', 2);
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.total, 7);
  assert.equal(search(t, '  ').total, 0);
});

test('collect: paths relative to the parent folder, unsafe and links skipped', () => {
  const t = buildTree([e('a/b/c.txt', 3, 3), e('a/b/d/e.txt', 4, 4), e('a/b/l', 0, 0, { kind: 'symlink', supported: false, link: 'c.txt' }),
    e('evil.txt', 1, 1, { unsafe: 'The name contains "..".' })]);
  const c = collect(t, 'a/b');
  assert.deepEqual(c.files.map((f) => f.rel), ['b/c.txt', 'b/d/e.txt']);
  assert.deepEqual(c.dirs, ['b', 'b/d']);
  assert.deepEqual(c.skipped, [['a/b/l', 'link']]);
  assert.equal(c.bytes, 7);
  assert.equal(find(t, 'a').flags & 1, 0, 'a folder is not struck through for what it holds');
  const t2 = buildTree([e('safe/ok.txt', 1, 1), e('safe/escape.txt', 1, 1, { unsafe: 'x' })]);
  assert.equal(find(t2, 'safe').flags, 32);
  const all = collect(t, '');
  assert.deepEqual(all.skipped.map((s) => s[1]).sort(), ['link', 'unsafe name']);
  assert.equal(collect(t, 'zzz'), null);
});
