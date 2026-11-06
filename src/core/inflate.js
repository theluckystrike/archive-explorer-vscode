'use strict';
// Bounded decompression with fflate (MIT). The input is fed in small slices, so a zip bomb is stopped after
// at most about 16 MB of extra output instead of filling memory first.
const { Inflate, Gunzip } = require('fflate');
const { LimitError, fmtSize } = require('./limits');

const SLICE = 16 * 1024;

function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Raw DEFLATE with a hard cap on output. limit = max bytes; overMsg(n) builds the error text.
 */
function inflateBounded(data, limit, overMsg) {
  const chunks = [];
  let total = 0;
  const inf = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw new LimitError(overMsg ? overMsg(total) : `Unpacked data is larger than ${fmtSize(limit)}.`, 'size');
    chunks.push(chunk);
  });
  for (let i = 0; i < data.length; i += SLICE) inf.push(data.subarray(i, Math.min(data.length, i + SLICE)), i + SLICE >= data.length);
  if (!data.length) inf.push(new Uint8Array(0), true);
  return concat(chunks, total);
}

/**
 * Streams a gzip file from a source. Stops with a LimitError past limit bytes. With stopAfter, it returns the
 * first stopAfter bytes (or fewer) and stops reading early, for format sniffing.
 */
async function gunzipSource(src, limit, overMsg, stopAfter) {
  const chunks = [];
  let total = 0;
  let enough = false;
  const gz = new Gunzip((chunk) => {
    if (enough) return;
    total += chunk.length;
    if (!stopAfter && total > limit) throw new LimitError(overMsg ? overMsg(total) : `Unpacked data is larger than ${fmtSize(limit)}.`, 'size');
    chunks.push(chunk);
    if (stopAfter && total >= stopAfter) enough = true;
  });
  let read = 0;
  await src.stream((buf) => {
    read += buf.length;
    for (let i = 0; i < buf.length && !enough; i += SLICE) {
      const last = read >= src.size && i + SLICE >= buf.length;
      gz.push(buf.subarray(i, Math.min(buf.length, i + SLICE)), last);
    }
    return !enough;
  });
  const out = concat(chunks, total);
  return stopAfter ? out.subarray(0, Math.min(out.length, stopAfter)) : out;
}

module.exports = { inflateBounded, gunzipSource, concat };
