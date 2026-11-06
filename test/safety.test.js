'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkEntryName, joinInside, LimitError, normalizeLimits } = require('../src/core/limits');
const { openArchive } = require('../src/core/archive');
const { FileSource, BufferSource } = require('../src/core/source');
const { extract } = require('../src/extract');
const { writeZip } = require('../scripts/writers');
const { samples } = require('./helpers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zae-extract-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const io = {
  exists: async (p) => fs.existsSync(p),
  mkdir: async (p) => fs.mkdirSync(p, { recursive: true }),
  write: async (p, d) => fs.writeFileSync(p, d),
};

function listAll(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } })(dir);
  return out.sort();
}

test('names: ".." and absolute paths are unsafe, normal names are cleaned', () => {
  assert.deepEqual(checkEntryName('a/./b//c.txt'), { path: 'a/b/c.txt', unsafe: null });
  assert.deepEqual(checkEntryName('a\\b\\c.txt'), { path: 'a/b/c.txt', unsafe: null });
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'C:\\x', '\\\\server\\share\\x', 'a\0b']) {
    assert.ok(checkEntryName(bad).unsafe, bad);
  }
  assert.equal(joinInside('/tmp/out', 'a/b.txt'), '/tmp/out/a/b.txt');
  assert.equal(joinInside('/tmp/out', '../b.txt'), null);
  assert.equal(joinInside('/tmp/out', '/etc/passwd'), null);
  assert.equal(joinInside('/tmp/out', ''), null);
  assert.deepEqual(normalizeLimits({ maxEntries: -5, maxEntryMB: 'x' }), { maxEntries: 10, maxEntryMB: 512, maxUnpackedMB: 2048 });
});

test('zip slip: extract all writes only the safe file and reports the rest', async () => {
  const src = await FileSource.open(path.join(samples(), 'security-tests', 'zip-slip.zip'));
  const arc = await openArchive(src, 'zip-slip.zip');
  assert.equal(arc.entries.filter((e) => e.unsafe).length, 3);
  assert.match(arc.problems.join(' '), /3 entries have unsafe names/);
  const out = path.join(tmp, 'slip', 'inner');
  fs.mkdirSync(out, { recursive: true });
  const res = await extract({ arc, path: '', targetDir: out, io });
  await src.close();
  assert.equal(res.written, 1);
  assert.deepEqual(listAll(path.join(tmp, 'slip')), ['inner/safe/readme.txt']);
  assert.equal(res.skipped.length, 3);
  assert.ok(res.skipped.every(([, why]) => why === 'unsafe name'));
  assert.ok(!fs.existsSync(path.join(tmp, 'outside.txt')) && !fs.existsSync('/tmp/absolute.txt-zae-never'));
});

test('zip bomb: extraction over the limit is refused before anything is written', async () => {
  const src = await FileSource.open(path.join(samples(), 'security-tests', 'zip-bomb.zip'));
  const arc = await openArchive(src, 'zip-bomb.zip');
  const out = path.join(tmp, 'bomb');
  fs.mkdirSync(out);
  await assert.rejects(extract({ arc, path: '', targetDir: out, io }),
    (e) => e instanceof LimitError && /would write 2.3 GB. The limit is 2.0 GB.*nothing was written/.test(e.message));
  assert.deepEqual(fs.readdirSync(out), []);
  const res = await extract({ arc, path: 'liar.txt', targetDir: out, single: path.join(out, 'liar.txt'), io }).catch((e) => e);
  assert.ok(res instanceof LimitError && /more than the 1.0 KB its header says/.test(res.message));
  assert.ok(!fs.existsSync(path.join(out, 'liar.txt')));
  await src.close();
});

test('extract: a folder keeps its name, a file goes to the chosen path, conflicts follow the answer', async () => {
  const src = await FileSource.open(path.join(samples(), 'web-app-release.zip'));
  const arc = await openArchive(src, 'web-app-release.zip');
  const out = path.join(tmp, 'folder');
  fs.mkdirSync(out);
  let r = await extract({ arc, path: 'orders-service/src', targetDir: out, io });
  assert.deepEqual(listAll(out), ['src/app.js', 'src/config.js']);
  assert.equal(r.written, 2);
  fs.writeFileSync(path.join(out, 'src', 'app.js'), 'local edit');
  r = await extract({ arc, path: 'orders-service/src', targetDir: out, io, onConflict: async (n) => { assert.equal(n, 2); return 'skip'; } });
  assert.equal(r.written, 0);
  assert.equal(fs.readFileSync(path.join(out, 'src', 'app.js'), 'utf8'), 'local edit');
  r = await extract({ arc, path: 'orders-service/src', targetDir: out, io, onConflict: async () => undefined });
  assert.equal(r.cancelled, true);
  r = await extract({ arc, path: 'orders-service/src', targetDir: out, io, onConflict: async () => 'overwrite' });
  assert.equal(r.written, 2);
  assert.match(fs.readFileSync(path.join(out, 'src', 'app.js'), 'utf8'), /createServer/);
  const single = path.join(out, 'renamed.csv');
  r = await extract({ arc, path: 'orders-service/data/sales-2026.csv', targetDir: out, single, io });
  assert.equal(r.written, 1);
  assert.match(fs.readFileSync(single, 'utf8'), /^date,region,product/);
  await src.close();
});

test('extract: the file-count limit and skipped encrypted entries', async () => {
  const buf = writeZip([...Array.from({ length: 12 }, (_, i) => ({ name: `d/f${i}.txt`, data: 'x' })), { name: 'd/secret.txt', data: 's', encrypted: true }]);
  const arc = await openArchive(new BufferSource(buf), 'x.zip');
  arc.limits = { ...arc.limits, maxEntries: 10 };
  await assert.rejects(extract({ arc, path: 'd', targetDir: path.join(tmp, 'n'), io }), /would write 12 files. The limit is 10/);
  const arc2 = await openArchive(new BufferSource(buf), 'x.zip');
  const out = path.join(tmp, 'enc');
  const r = await extract({ arc: arc2, path: '', targetDir: out, io });
  assert.equal(r.written, 12);
  assert.deepEqual(r.skipped, [['d/secret.txt', 'encrypted']]);
});
