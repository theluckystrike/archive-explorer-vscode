'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readTar, readTarEntry, parsePax, looksLikeTar } = require('../src/core/tar');
const { openArchive, sniff, gzipName } = require('../src/core/archive');
const { FileSource, BufferSource } = require('../src/core/source');
const { LimitError } = require('../src/core/limits');
const { writeTar, gzip, bytes } = require('../scripts/writers');
const { samples } = require('./helpers');

const dec = new TextDecoder();
const MB = 1024 * 1024;

test('tar: ustar, GNU long names, pax paths, folders and links', async () => {
  const buf = writeTar([
    { name: 'top', dir: true },
    { name: 'top/a.txt', data: 'alpha' },
    { name: 'top/' + 'n'.repeat(120) + '.txt', data: 'gnu long' },
    { name: 'top/pax/' + 'p'.repeat(130) + '.json', data: '{}', longName: 'pax' },
    { name: 'top/link', symlink: 'a.txt' },
    { name: 'top/hard', hardlink: 'top/a.txt' },
  ]);
  assert.ok(looksLikeTar(buf.subarray(0, 512)));
  const src = new BufferSource(buf);
  const t = await readTar(src);
  assert.deepEqual(t.entries.map((e) => e.kind), ['dir', 'file', 'file', 'file', 'symlink', 'hardlink']);
  assert.equal(t.entries[2].path, 'top/' + 'n'.repeat(120) + '.txt');
  assert.equal(t.entries[3].path, 'top/pax/' + 'p'.repeat(130) + '.json');
  assert.equal(t.entries[4].link, 'a.txt');
  assert.equal(dec.decode(await readTarEntry(src, t.entries[1], MB)), 'alpha');
  assert.equal(dec.decode(await readTarEntry(src, t.entries[2], MB)), 'gnu long');
  await assert.rejects(readTarEntry(src, t.entries[4], MB), /is a link to "a.txt"/);
  await assert.rejects(readTarEntry(src, t.entries[1], 2), /limit is 2 B/);
});

test('tar: damaged headers, cut files and pax records', async () => {
  const buf = writeTar([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b'.repeat(2000) }]);
  const bad = buf.slice(); bad[0] ^= 0xff;
  await assert.rejects(readTar(new BufferSource(bad)), /bad checksum/);
  const second = buf.slice(); second[1024 + 10] ^= 0xff;
  const t = await readTar(new BufferSource(second));
  assert.equal(t.entries.length, 1);
  assert.match(t.problems[0], /damaged/);
  const cut = await readTar(new BufferSource(buf.subarray(0, 1024 + 512 + 600)));
  assert.match(cut.problems.join(' '), /cut short/);
  assert.deepEqual(parsePax(bytes('18 path=a/b/c.txt\n11 size=42\n')), { path: 'a/b/c.txt', size: '42' });
});

test('tar.gz: the site backup sample unpacks in memory and lists every entry', async () => {
  const src = await FileSource.open(path.join(samples(), 'site-backup.tar.gz'));
  const a = await openArchive(src, 'site-backup.tar.gz');
  assert.equal(a.format, 'tar.gz');
  assert.equal(a.entries.length, 7);
  assert.ok(a.entries.some((e) => e.path.endsWith('navigation/menu-component.js')));
  const html = a.entries.find((e) => e.path === 'www/index.html');
  assert.match(dec.decode(await a.read(html, MB)), /<title>Orders<\/title>/);
  await src.close();
});

test('tar.gz bomb: unpacking stops at maxUnpackedMB with a clear message', async () => {
  const tar = writeTar([{ name: 'zeros.bin', data: new Uint8Array(3 * MB) }]);
  const gz = gzip(tar, 'bomb.tar');
  assert.ok(gz.length < 20000);
  await assert.rejects(openArchive(new BufferSource(gz), 'bomb.tar.gz', { maxUnpackedMB: 1 }),
    (e) => e instanceof LimitError && /unpacks to more than 1.0 MB.*maxUnpackedMB/.test(e.message));
});

test('gz: a single gzip file is one entry named from the header, read with a limit', async () => {
  const src = await FileSource.open(path.join(samples(), 'server.log.gz'));
  const a = await openArchive(src, 'server.log.gz');
  assert.equal(a.format, 'gz');
  assert.equal(a.entries[0].path, 'server.log');
  assert.ok(a.entries[0].size > 2 * MB);
  const data = await a.read(a.entries[0], 10 * MB);
  assert.match(dec.decode(data.subarray(0, 40)), /^2026-11-06T09:00:00Z INFO/);
  await assert.rejects(a.read(a.entries[0], MB), /unpacks to more than 1.0 MB/);
  await src.close();
  assert.equal(gzipName(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0]), 'notes.txt.gz'), 'notes.txt');
  assert.equal(gzipName(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0]), 'pkg.tgz'), 'pkg.tar');
});

test('detect: a .gz holding a tar is read as TAR.GZ, plain tar by its header, others refused', async () => {
  const gz = gzip(writeTar([{ name: 'x.txt', data: 'x' }]), 'x.tar');
  const a = await openArchive(new BufferSource(gz), 'backup.gz');
  assert.equal(a.format, 'tar.gz');
  const t = await openArchive(await FileSource.open(path.join(samples(), 'dataset.tar')), 'dataset.tar');
  assert.equal(t.format, 'tar');
  assert.equal(t.entries.length, 5);
  assert.equal(sniff(bytes('hello world'), 'a.txt'), null);
  await assert.rejects(openArchive(new BufferSource(bytes('x'.repeat(2000))), 'a.bin'), /not a ZIP, TAR or GZIP archive/);
});
