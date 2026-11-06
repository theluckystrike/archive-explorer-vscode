'use strict';
// Shared test setup: generates the sample archives once into a temp folder that is removed after the run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../scripts/make-samples');

let dir = null;
function samples() {
  if (dir) return dir;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zae-samples-'));
  const log = console.log; console.log = () => {};
  try { main(dir); } finally { console.log = log; }
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
module.exports = { samples };
