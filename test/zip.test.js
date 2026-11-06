'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readZip, readZipEntry, decodeName, dosTime } = require('../src/core/zip');
const { openArchive } = require('../src/core/archive');
const { FileSource, BufferSource } = require('../src/core/source');
const { LimitError } = require('../src/core/limits');
const { writeZip, cat, bytes } = require('../scripts/writers');
const { samples } = require('./helpers');

const dec = new TextDecoder();
const MB = 1024 * 1024;

test('zip: reads the release sample, names, comment, sizes and nested folders', async () => {
  const src = await FileSource.open(path.join(samples(), 'web-app-release.zip'));
  try {
    const z = await readZip(src);
    assert.equal(z.entries.length, 14);
    assert.equal(z.comment, 'orders-service 2.4.1 release');
    const names = z.entries.map((e) => e.path);
    assert.ok(names.includes('orders-service/docs/Résumé des changements.md'));
    const log = z.entries.find((e) => e.path.endsWith('.log'));
    assert.ok(log.size > 1_000_000 && log.packed < log.size / 5, 'log compresses well');
    const png = z.entries.find((e) => e.path.endsWith('logo.png'));
    assert.equal(png.method, 0);
    const data = await readZipEntry(src, png, 10 * MB);
    assert.deepEqual([...data.subarray(0, 4)], [137, 80, 78, 71]);
    const js = await readZipEntry(src, z.entries.find((e) => e.path.endsWith('app.js')), MB);
    assert.match(dec.decode(js), /createServer/);
    assert.ok(z.entries.find((e) => e.path === 'orders-service').dir);
  } finally { await src.close(); }
});

test('zip: ZIP64 records, data in front (self-extracting) and the Unix symlink mode', async () => {
  const z64 = writeZip([{ name: 'a/big.txt', data: 'x'.repeat(5000) }, { name: 'b.txt', data: 'hello', method: 0 }], { zip64: true });
  let z = await readZip(new BufferSource(z64));
  assert.equal(z.zip64, true);
  assert.equal(z.entries[0].size, 5000);
  assert.equal(dec.decode(await readZipEntry(new BufferSource(z64), z.entries[1], MB)), 'hello');
  const sfx = writeZip([{ name: 'in.txt', data: 'inside' }], { prefix: bytes('#!/bin/sh\necho stub\n'.repeat(20)) });
  const src = new BufferSource(sfx);
  z = await readZip(src);
  assert.equal(dec.decode(await readZipEntry(src, z.entries[0], MB)), 'inside');
  z = await readZip(new BufferSource(writeZip([{ name: 'link', data: 'target.txt', unixMode: 0o120777, method: 0 }])));
  assert.equal(z.entries[0].kind, 'symlink');
});

test('zip: old DOS names, UTF-8 without the flag, and DOS dates', () => {
  assert.equal(decodeName(new Uint8Array([0x82, 0x74, 0x65]), false), 'éte');
  assert.equal(decodeName(bytes('naïve.txt'), false), 'naïve.txt');
  const t = dosTime((10 << 11) | (30 << 5) | 5, ((2026 - 1980) << 9) | (11 << 5) | 6);
  const d = new Date(t);
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [2026, 11, 6, 10, 30, 10]);
});

test('zip: encrypted, unknown methods, damaged data and bad CRC give clear errors', async () => {
  const buf = writeZip([
    { name: 'secret.txt', data: 'pw', encrypted: true },
    { name: 'ok.txt', data: 'fine' },
    { name: 'badcrc.txt', data: 'some data', crc: 1234 },
  ]);
  const src = new BufferSource(buf);
  const z = await readZip(src);
  await assert.rejects(readZipEntry(src, z.entries[0], MB), /encrypted/);
  await assert.rejects(readZipEntry(src, { ...z.entries[1], method: 12, methodName: 'BZIP2', supported: false }, MB), /BZIP2 compression/);
  await assert.rejects(readZipEntry(src, z.entries[2], MB), /CRC/);
  await assert.rejects(readZip(new BufferSource(buf.subarray(0, buf.length - 30))), /end-of-archive record is missing/);
  await assert.rejects(readZip(new BufferSource(bytes('just some text, not a zip at all.'))), /not a ZIP archive/);
});

test('zip bomb: a header that lies about its size is stopped, big entries need the limit', async () => {
  const file = path.join(samples(), 'security-tests', 'zip-bomb.zip');
  assert.ok(fs.statSync(file).size < 3 * MB);
  const src = await FileSource.open(file);
  try {
    const z = await readZip(src);
    const liar = z.entries.find((e) => e.path === 'liar.txt');
    await assert.rejects(readZipEntry(src, liar, 512 * MB), (e) => e instanceof LimitError && /more than the 1.0 KB its header says/.test(e.message));
    const big = z.entries[0];
    assert.equal(big.size, 600 * MB);
    await assert.rejects(readZipEntry(src, big, 512 * MB), /600 MB unpacked. The limit is 512 MB/);
  } finally { await src.close(); }
});

test('zip: the entry-count limit stops before the list is built', async () => {
  const many = writeZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: 'x', method: 0 })));
  await assert.rejects(openArchive(new BufferSource(many), 'many.zip', { maxEntries: 20 }), (e) => e instanceof LimitError && /lists 30 entries. Archive Explorer reads up to 20/.test(e.message));
});

test('zip family: JAR and VSIX open as ZIP with their own label', async () => {
  for (const [f, label, n] of [['hello-plugin.jar', 'JAR (ZIP)', 6], ['sample-extension.vsix', 'VSIX (ZIP)', 6]]) {
    const src = await FileSource.open(path.join(samples(), f));
    const a = await openArchive(src, f);
    assert.equal(a.formatLabel, label);
    assert.equal(a.entries.length, n);
    await src.close();
  }
  const j = cat([bytes('PK'), new Uint8Array(10)]);
  await assert.rejects(openArchive(new BufferSource(j), 'x.zip'), /not a ZIP archive|too small/);
});
