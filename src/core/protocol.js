'use strict';
// Messages between the webview and the extension host. Everything from the webview is checked here first.

const MAX_PATH = 4096;
const isPath = (v) => typeof v === 'string' && v.length <= MAX_PATH && !v.includes('\0');

function validateWebviewMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  switch (m.type) {
    case 'ready': case 'rendered': case 'extractAll': case 'revealTree':
      return { ok: true, msg: { type: m.type } };
    case 'list':
      return isPath(m.path) ? { ok: true, msg: { type: 'list', path: m.path } } : { ok: false };
    case 'search':
      return typeof m.query === 'string' && m.query.length <= 200 ? { ok: true, msg: { type: 'search', query: m.query } } : { ok: false };
    case 'open':
      return isPath(m.path) && m.path ? { ok: true, msg: { type: 'open', path: m.path, side: m.side === true } } : { ok: false };
    case 'extract': case 'copyPath':
      return isPath(m.path) ? { ok: true, msg: { type: m.type, path: m.path } } : { ok: false };
    default:
      return { ok: false };
  }
}

/** "3.2:1" style compression ratio. Empty when not known. */
function ratioText(size, packed) {
  if (packed == null || packed < 0 || !size) return '';
  if (packed === 0) return size ? '∞' : '';
  const r = size / packed;
  if (r < 0.95) return `${r.toFixed(2)}:1`;
  if (r < 1.05) return '1:1';
  return `${r >= 100 ? Math.round(r) : r >= 10 ? r.toFixed(0) : r.toFixed(1)}:1`;
}

/** Warning for very high ratios, which is what zip bombs look like. */
function ratioWarning(size, packed) {
  if (packed == null || packed <= 0) return '';
  const r = size / packed;
  if (r >= 100 && size >= 100 * 1024 * 1024) return `Very high compression ratio (${Math.round(r)}:1). This can be a zip bomb. Opening and extracting are size-limited.`;
  return '';
}

module.exports = { validateWebviewMessage, ratioText, ratioWarning, MAX_PATH };
