'use strict';
// Writes the sample archives used for the tests, the screenshots and the release check.
// Usage: node scripts/make-samples.js <folder>     All content is generated; nothing is downloaded.
const fs = require('fs');
const path = require('path');
const { zlibSync, Deflate, deflateSync } = require('fflate');
const { writeZip, writeTar, gzip, cat, bytes } = require('./writers');
const { crc32 } = require('../src/core/crc32');

const T = Date.UTC(2026, 10, 6, 9, 15);

function png(w, h, pixel) {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = pixel(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const chunk = (type, data) => {
    const td = cat([bytes(type), data]);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
    const c = new Uint8Array(4); new DataView(c.buffer).setUint32(0, crc32(td));
    return cat([len, td, c]);
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  return cat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}

const logo = () => png(192, 192, (x, y) => {
  const dx = x - 96, dy = y - 96, r = Math.sqrt(dx * dx + dy * dy);
  if (r > 90) return [24, 32, 44];
  const band = Math.abs(dy + dx * 0.55) < 14 || (Math.abs(dy + 52) < 12 && Math.abs(dx) < 50) || (Math.abs(dy - 52) < 12 && Math.abs(dx) < 50);
  return band ? [250, 250, 250] : [Math.round(40 + x * 0.6), Math.round(120 + y * 0.4), 200];
});
const chart = () => png(320, 200, (x, y) => {
  const v = 170 - Math.round(60 * Math.sin(x / 30) + x / 5);
  if (y > 190 || x < 6) return [80, 80, 80];
  return y > v ? [70, 160, 110] : [250, 250, 248];
});

function csv(rows) {
  const out = ['date,region,product,units,revenue'];
  const regions = ['North', 'South', 'East', 'West'], products = ['Widget', 'Gadget', 'Doohickey', 'Gizmo'];
  for (let i = 0; i < rows; i++) out.push(`2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')},${regions[i % 4]},${products[(i * 7) % 4]},${(i * 37) % 200 + 1},${(((i * 37) % 200 + 1) * 19.5).toFixed(2)}`);
  return out.join('\n') + '\n';
}

function log(lines) {
  const out = [];
  for (let i = 0; i < lines; i++) out.push(`2026-11-06T09:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z INFO  api request id=${100000 + i} path=/v1/orders status=${i % 50 ? 200 : 503} ms=${(i * 13) % 250}`);
  return out.join('\n') + '\n';
}

const appJs = `import { createServer } from 'node:http';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);

export function start(port = config.port) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: config.version }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return server.listen(port, () => console.log(\`listening on \${port}\`));
}
`;
const configJs = `export function loadConfig(env) {
  return {
    port: Number(env.PORT || 8080),
    version: '2.4.1',
    features: (env.FEATURES || '').split(',').filter(Boolean),
  };
}
`;
const css = `:root { --accent: #2f81f7; }\nbody { font: 15px/1.5 system-ui, sans-serif; margin: 0; }\n.card { border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px #0003; }\n`;
const html = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Orders</title><link rel="stylesheet" href="styles/main.css"></head>\n<body><main class="card"><h1>Orders</h1><img src="assets/logo.png" alt="logo"></main><script type="module" src="src/app.js"></script></body>\n</html>\n`;
const readme = `# Orders service 2.4.1\n\nRelease bundle for the orders API.\n\n- \`src/\` server code\n- \`assets/\` images\n- \`data/sales-2026.csv\` sample data\n`;
const pkg = JSON.stringify({ name: 'orders-service', version: '2.4.1', type: 'module', main: 'src/app.js', scripts: { start: 'node src/app.js' } }, null, 2) + '\n';
const yaml = `service: orders\nreplicas: 3\nresources:\n  cpu: 500m\n  memory: 512Mi\nhealthCheck: /health\n`;

function main(dir) {
  fs.mkdirSync(path.join(dir, 'security-tests'), { recursive: true });
  const w = (name, data) => { fs.writeFileSync(path.join(dir, name), data); console.log(name.padEnd(36), data.length.toLocaleString('en-US'), 'bytes'); };

  const inner = writeZip([
    { name: 'fixtures/orders.json', data: JSON.stringify([{ id: 1, total: 19.5 }, { id: 2, total: 39 }], null, 2) },
    { name: 'fixtures/users.json', data: JSON.stringify([{ id: 1, name: 'Ada' }], null, 2) },
  ]);
  w('web-app-release.zip', writeZip([
    { name: 'orders-service', dir: true, mtime: T },
    { name: 'orders-service/README.md', data: readme, mtime: T },
    { name: 'orders-service/package.json', data: pkg, mtime: T },
    { name: 'orders-service/deploy.yaml', data: yaml, mtime: T },
    { name: 'orders-service/index.html', data: html, mtime: T },
    { name: 'orders-service/src/app.js', data: appJs, mtime: T },
    { name: 'orders-service/src/config.js', data: configJs, mtime: T },
    { name: 'orders-service/styles/main.css', data: css, mtime: T },
    { name: 'orders-service/assets/logo.png', data: logo(), method: 0, mtime: T },
    { name: 'orders-service/assets/chart.png', data: chart(), method: 0, mtime: T },
    { name: 'orders-service/data/sales-2026.csv', data: csv(1500), mtime: T },
    { name: 'orders-service/logs/api-2026-11-06.log', data: log(20000), mtime: T },
    { name: 'orders-service/docs/Résumé des changements.md', data: '# Changements\n\n- Réponses plus rapides\n- Nouveau point /health\n', mtime: T },
    { name: 'orders-service/test/fixtures.zip', data: inner, method: 0, mtime: T },
  ], { comment: 'orders-service 2.4.1 release' }));

  const classFile = (n) => cat([new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]), bytes(`demo class ${n} `.repeat(40))]);
  w('hello-plugin.jar', writeZip([
    { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\nMain-Class: com.zovo.hello.Main\r\nCreated-By: make-samples\r\n' },
    { name: 'com/zovo/hello/Main.class', data: classFile('Main') },
    { name: 'com/zovo/hello/Greeter.class', data: classFile('Greeter') },
    { name: 'com/zovo/hello/util/Strings.class', data: classFile('Strings') },
    { name: 'plugin.yml', data: 'name: Hello\nmain: com.zovo.hello.Main\nversion: 1.0.0\n' },
    { name: 'config.properties', data: 'greeting=Hello\nlanguage=en\n' },
  ]));

  w('sample-extension.vsix', writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/></Types>\n' },
    { name: 'extension.vsixmanifest', data: '<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0"><Metadata><Identity Id="sample" Version="1.0.0" Publisher="example"/></Metadata></PackageManifest>\n' },
    { name: 'extension/package.json', data: JSON.stringify({ name: 'sample', publisher: 'example', version: '1.0.0', engines: { vscode: '^1.90.0' }, main: './dist/extension.js' }, null, 2) },
    { name: 'extension/README.md', data: '# Sample extension\n\nA sample package for the archive viewer.\n' },
    { name: 'extension/dist/extension.js', data: "'use strict';\nexports.activate = () => {};\nexports.deactivate = () => {};\n" },
    { name: 'extension/images/icon.png', data: logo(), method: 0 },
  ]));

  const longDir = 'www/assets/vendor/some-library-with-a-very-long-package-name/dist/esm/components/navigation';
  w('site-backup.tar.gz', gzip(writeTar([
    { name: 'www', dir: true },
    { name: 'www/index.html', data: html },
    { name: 'www/styles/main.css', data: css },
    { name: 'www/assets/logo.png', data: logo() },
    { name: `${longDir}/menu-component.js`, data: 'export const menu = () => null;\n' },
    { name: 'www/current', symlink: 'releases/2026-11-06' },
    { name: 'logs/access.log', data: log(8000) },
  ]), 'site-backup.tar'));

  w('dataset.tar', writeTar([
    { name: 'dataset/README.md', data: '# Sales dataset\n\nGenerated sample data.\n' },
    { name: 'dataset/sales-2026.csv', data: csv(3000) },
    { name: 'dataset/charts/revenue.png', data: chart() },
    { name: 'dataset/schema.json', data: JSON.stringify({ fields: ['date', 'region', 'product', 'units', 'revenue'] }, null, 2) },
    { name: 'dataset/exports/2026/quarterly/regional-breakdown-by-product-and-month-with-totals-and-averages.csv', data: csv(40), longName: 'pax' },
  ]));

  w('server.log.gz', gzip(log(30000), 'server.log'));

  // Unsafe on purpose: names that try to leave the target folder (zip slip)
  w('security-tests/zip-slip.zip', writeZip([
    { name: 'safe/readme.txt', data: 'This file is safe to extract.\n' },
    { name: '../../outside.txt', data: 'zip slip test: must never be written\n' },
    { name: '/tmp/absolute.txt', data: 'absolute path test: must never be written\n' },
    { name: 'safe/../../escape.txt', data: 'zip slip test: must never be written\n' },
  ]));

  // A small zip bomb: 4 entries of 600 MB of zeros each (2.4 GB) in about 2.4 MB, plus an entry whose header lies about its size.
  const zeros = new Uint8Array(1 << 20);
  const parts = [];
  const def = new Deflate({ level: 9 }, (c) => parts.push(c));
  let crc = 0;
  for (let i = 0; i < 600; i++) { def.push(zeros, i === 599); crc = crc32(zeros, crc); }
  const big = cat(parts);
  const liarData = new Uint8Array(20 << 20);
  const bomb = [];
  for (let i = 1; i <= 4; i++) bomb.push({ name: `zeros-0${i}.bin`, raw: big, crc, size: 600 << 20 });
  w('security-tests/zip-bomb.zip', writeZipRaw(bomb, { name: 'liar.txt', data: liarData, declaredSize: 1024 }));
}

// Writes pre-compressed entries (so the bomb is built without holding 2.4 GB) plus one normal entry.
function writeZipRaw(raws, extra) {
  const le = (n, s) => { const b = new Uint8Array(s); let v = n; for (let i = 0; i < s; i++) { b[i] = v % 256; v = Math.floor(v / 256); } return b; };
  const parts = [], cen = [];
  let off = 0;
  const add = (nameStr, body, crc, size) => {
    const name = bytes(nameStr);
    const lh = cat([le(0x04034b50, 4), le(20, 2), le(0x800, 2), le(8, 2), le(0, 2), le(0x5d66, 2), le(crc, 4), le(body.length, 4), le(size, 4), le(name.length, 2), le(0, 2), name]);
    cen.push(cat([le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x800, 2), le(8, 2), le(0, 2), le(0x5d66, 2), le(crc, 4), le(body.length, 4), le(size, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), name]));
    parts.push(lh, body); off += lh.length + body.length;
  };
  for (const r of raws) add(r.name, r.raw, r.crc, r.size);
  add(extra.name, deflateSync(extra.data, { level: 9 }), crc32(extra.data), extra.declaredSize);
  const cd = cat(cen);
  parts.push(cd, cat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(cen.length, 2), le(cen.length, 2), le(cd.length, 4), le(off, 4), le(0, 2)]));
  return cat(parts);
}

if (require.main === module) main(process.argv[2] || 'samples');
module.exports = { main, png };
