'use strict';
// Extraction with zip-slip and zip-bomb checks. Takes a small file API (stat, mkdir, write) so it can be
// tested without VS Code. Paths are POSIX paths, as in VS Code URIs.
const { collect } = require('./core/tree');
const { joinInside, LimitError, MB, fmtSize, fmtCount } = require('./core/limits');

/**
 * opts: { arc, path, targetDir (POSIX path), single (exact target path for one file, optional), io: { exists, mkdir, write },
 *         onConflict(count) -> 'overwrite' | 'skip' | undefined, progress(done, total), cancelled() -> bool }
 * Returns { written, bytes, skipped: [[path, reason]], existing, target } or throws a LimitError before anything is written.
 */
async function extract(opts) {
  const { arc, io } = opts;
  const limits = arc.limits;
  const plan = collect(arc.tree, opts.path || '');
  if (!plan) throw new Error(`"${opts.path}" is not in this archive.`);
  const label = opts.path ? `"${opts.path}"` : 'this archive';
  if (plan.files.length > limits.maxEntries) {
    throw new LimitError(`Extracting ${label} would write ${fmtCount(plan.files.length)} files. The limit is ${fmtCount(limits.maxEntries)} (setting archiveExplorer.maxEntries). Nothing was written.`, 'entries');
  }
  const budget = limits.maxUnpackedMB * MB;
  if (plan.bytes > budget) {
    throw new LimitError(`Extracting ${label} would write ${fmtSize(plan.bytes)}. The limit is ${fmtSize(budget)} (setting archiveExplorer.maxUnpackedMB), so nothing was written. Archives like this are often zip bombs.`, 'size');
  }
  const skipped = plan.skipped.slice();
  const jobs = [];
  if (opts.single) {
    if (plan.isDir || plan.files.length !== 1) {
      if (!plan.files.length) throw new Error(skipped.length ? `"${opts.path}" cannot be extracted: ${skipped[0][1]}.` : `"${opts.path}" is empty.`);
      throw new Error('Pick a folder to extract a folder.');
    }
    jobs.push({ target: opts.single, entry: plan.files[0].entry, rel: plan.files[0].rel });
  } else {
    for (const f of plan.files) {
      const target = joinInside(opts.targetDir, f.rel);
      if (!target) { skipped.push([f.entry.path, 'unsafe name']); continue; }
      jobs.push({ target, entry: f.entry, rel: f.rel });
    }
  }
  const existing = [];
  if (!opts.single) for (const j of jobs) if (await io.exists(j.target)) existing.push(j);
  let mode = 'overwrite';
  if (existing.length && !opts.single) {
    mode = opts.onConflict ? await opts.onConflict(existing.length) : 'skip';
    if (!mode) return { cancelled: true, written: 0, bytes: 0, skipped, existing: existing.length };
  }
  const skipSet = new Set(mode === 'skip' ? existing.map((j) => j.target) : []);
  if (!opts.single) {
    for (const d of plan.dirs) {
      const t = joinInside(opts.targetDir, d);
      if (t) await io.mkdir(t);
    }
  }
  let written = 0, bytes = 0, left = budget;
  for (const j of jobs) {
    if (opts.cancelled && opts.cancelled()) return { cancelled: true, written, bytes, skipped, existing: existing.length };
    if (skipSet.has(j.target)) { skipped.push([j.entry.path, 'already exists']); continue; }
    let data;
    try {
      // The zip reader also stops when an entry unpacks to more than its header says.
      data = await arc.read(j.entry, Math.min(left, j.entry.sizeApprox ? left : Math.max(j.entry.size, 0)));
    } catch (e) {
      if (e instanceof LimitError) throw new LimitError(`${e.message} Extraction stopped after ${fmtCount(written)} files.`, e.code);
      skipped.push([j.entry.path, e.message]);
      continue;
    }
    left -= data.length;
    await io.mkdir(j.target.slice(0, j.target.lastIndexOf('/')) || '/');
    await io.write(j.target, data);
    written++; bytes += data.length;
    if (opts.progress) opts.progress(written, jobs.length);
  }
  return { written, bytes, skipped, existing: existing.length, target: opts.single || opts.targetDir };
}

module.exports = { extract };
