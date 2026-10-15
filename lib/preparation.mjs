// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { safePath, readJSON, loadReviewDependencies, relativeName, inside, hash, atomicWrite, writeJSON, lockRun, fileHash, assertReportPath } from './core.mjs';
import { readReviewText } from './review.mjs';
import { requirePhase } from './phases.mjs';

const inventoryHeader = 'file\tsymbol\tsource_construct\tclassification\ttarget_translation\tevidence\tstatus';
const siteHeader = 'file\tsymbol\tsource_construct';
function table(root, name, header) {
  const text = readReviewText(root, name).replace(/^\uFEFF/, '');
  const notes = [], rows = [];
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('#')) { notes.push(line); continue; }
    if (!found) { if (line !== header) throw new Error(`Unexpected TSV header: ${name}`); found = true; continue; }
    const cells = line.split('\t');
    if (cells.length !== header.split('\t').length || cells.some(c => !c.trim())) throw new Error(`Partial or malformed TSV row: ${name}`);
    relativeName(cells[0]); rows.push(cells);
  }
  if (!found) throw new Error(`Missing TSV header: ${name}`);
  return { notes, rows };
}

export function mergeInventory(root, config, { shards, sites } = {}) {
  if (!Array.isArray(shards) || !shards.length || new Set(shards).size !== shards.length || !sites?.startsWith('migration/')) throw new Error('Select unique inventory shards and a mechanical --sites census');
  if (shards.some(p => !inside(p, 'migration/inventory-shards'))) throw new Error('Classifiers must own separate files under migration/inventory-shards/');
  const release = lockRun(root, 'inventory-merge');
  try {
    requirePhase(root, config, '01');
    const receiptPath = assertReportPath(root, config, 'migration/inventory-merge.json');
    const key = row => JSON.stringify(row.slice(0, 3));
    const census = table(root, sites, siteHeader), expected = new Set(census.rows.map(key));
    if (!expected.size || expected.size !== census.rows.length) throw new Error('Inventory census must have nonempty unique site keys');
    const merged = new Map(), notes = new Set(), evidence = [];
    for (const shard of shards) {
      const data = table(root, shard, inventoryHeader);
      evidence.push([shard, fileHash(safePath(root, shard))]); data.notes.forEach(n => notes.add(n));
      for (const row of data.rows) {
        const id = key(row);
        if (!expected.has(id)) throw new Error(`Inventory row outside census: ${row.slice(0, 3).join(':')}`);
        if (!config.sourceRoots.some(r => inside(row[0], r)) || !fs.statSync(safePath(root, row[0])).isFile()) throw new Error(`Inventory source outside approved roots: ${row[0]}`);
        if (!['confirmed', 'unknown'].includes(row[6])) throw new Error('Inventory rows must finish as confirmed or unknown');
        if (row[6] === 'unknown' && (!row[4].includes('TODO(port)') || row[3] !== 'UNKNOWN')) throw new Error('UNKNOWN requires a deterministic target representation plus TODO(port) and the open question');
        if (merged.has(id) && JSON.stringify(merged.get(id)) !== JSON.stringify(row)) throw new Error(`Conflicting inventory answers: ${row.slice(0, 3).join(':')}`);
        merged.set(id, row);
      }
    }
    const missing = [...expected].filter(id => !merged.has(id));
    if (missing.length) throw new Error(`Incomplete inventory shards: ${missing.length} census sites missing; resume classification before merging`);
    const rows = [...merged.keys()].sort().map(id => merged.get(id));
    // Publish once, only after the full census, conflicts and partial writes pass.
    atomicWrite(safePath(root, 'migration/inventory.tsv'), [...notes].sort().concat(inventoryHeader, rows.map(r => r.join('\t'))).join('\n') + '\n');
    const receipt = { schemaVersion: 1, kind: 'inventory-merge', census: [sites, fileHash(safePath(root, sites))], shards: evidence,
      uniqueSites: rows.length, unknown: rows.filter(r => r[6] === 'unknown').length, outputHash: fileHash(safePath(root, 'migration/inventory.tsv')),
      auditStatus: 'independent-two-review-and-joint-audit-required' };
    writeJSON(receiptPath, receipt);
    return receipt;
  } finally { release(); }
}

// Iterative DFS avoids recursion limits; the returned path is a real cycle,
// not the tail of a cycle left over by a topological sort.
export function firstCycle(graph) {
  const done = new Set();
  for (const start of Object.keys(graph).sort()) {
    if (done.has(start)) continue;
    const active = new Map([[start, 0]]), stack = [{ node: start, edges: [...graph[start]].sort(), index: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.index >= top.edges.length) { done.add(top.node); active.delete(top.node); stack.pop(); continue; }
      const next = top.edges[top.index++];
      if (active.has(next)) return stack.slice(active.get(next)).map(s => s.node).concat(next);
      if (!done.has(next)) { active.set(next, stack.length); stack.push({ node: next, edges: [...(graph[next] ?? [])].sort(), index: 0 }); }
    }
  }
  return [];
}
export function packageCycles(root, config, mapFile) {
  const graph = loadReviewDependencies(root, config), map = readJSON(safePath(root, mapFile));
  if (map.schemaVersion !== 1 || !map.packages || Array.isArray(map.packages) || typeof map.packages !== 'object') throw new Error('Package map requires schemaVersion 1 and source-path -> target-package packages');
  const packages = Object.create(null);
  for (const source of Object.keys(graph)) {
    const pkg = map.packages[source];
    if (typeof pkg !== 'string' || !pkg.trim() || /[\x00-\x1f]/.test(pkg)) throw new Error(`Target package missing: ${source}`);
    packages[pkg] ??= new Set();
  }
  for (const [source, deps] of Object.entries(graph)) for (const dep of deps) {
    if (!Object.hasOwn(graph, dep)) throw new Error(`Dependency declaration missing: ${dep}`);
    if (map.packages[source] !== map.packages[dep]) packages[map.packages[source]].add(map.packages[dep]);
  }
  const edges = Object.fromEntries(Object.keys(packages).sort().map(k => [k, [...packages[k]].sort()]));
  return { schemaVersion: 1, kind: 'package-cycle-audit', map: [mapFile, fileHash(safePath(root, mapFile))],
    graphHash: hash(JSON.stringify(graph)), sourceCycle: firstCycle(graph), targetPackageCycle: firstCycle(edges), packages: edges,
    note: 'A source file DAG can still produce a target package cycle. Resolve partition/ownership at a human design gate.' };
}

export function dependencySamples(root, config, { seed, size = 20 } = {}) {
  if (!seed || !Number.isInteger(size) || size < 1 || size > 1000) throw new Error('Supply a recorded seed and sample size 1..1000');
  const files = Object.keys(loadReviewDependencies(root, config)).sort();
  const halves = [files.filter((_, i) => i % 2 === 0), files.filter((_, i) => i % 2 === 1)];
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const samples = halves.map((pool, reviewer) => {
    const ranked = [...pool].sort((a, b) => compare(hash(`${seed}\0${a}`), hash(`${seed}\0${b}`)));
    const random = ranked.slice(0, Math.min(Math.ceil(size / 2), pool.length));
    const adversarial = pool.filter(p => !random.includes(p)).sort((a, b) => reviewer === 0
      ? fs.statSync(safePath(root, b)).size - fs.statSync(safePath(root, a)).size || compare(a, b)
      : Number(/platform|windows|linux|generated|vendor/i.test(b)) - Number(/platform|windows|linux|generated|vendor/i.test(a)) || compare(a, b));
    return { reviewer: reviewer + 1, random, adversarial: adversarial.slice(0, Math.max(0, size - random.length)), population: pool.length };
  });
  return { schemaVersion: 1, kind: 'dependency-audit-samples', seed, requestedPerReviewer: size, sourceCount: files.length, samples,
    note: 'Disjoint source pools. Auditors enumerate direct edges from source; this selection is not a completed audit.' };
}

export function compareDependencyAudit(root, config, { files, audit } = {}) {
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) throw new Error('Select the actual audited files');
  const graph = loadReviewDependencies(root, config), rows = table(root, audit, 'from\tto\tevidence').rows;
  if (files.some(p => !Object.hasOwn(graph, p))) throw new Error('Audited file missing from declared source graph');
  const observed = new Map(files.map(p => [p, new Map()]));
  for (const [from, to, evidence] of rows) {
    if (!observed.has(from) || !Object.hasOwn(graph, to)) throw new Error('Audit edge outside selected files or declared source roots');
    observed.get(from).set(to, evidence);
  }
  const missed = [], invented = [];
  for (const from of files) {
    for (const [to, evidence] of observed.get(from)) if (!graph[from].includes(to)) missed.push({ from, to, evidence });
    for (const to of graph[from]) if (!observed.get(from).has(to)) invented.push({ from, to, evidence: 'Scanner edge not found by this independent source audit; confirm against source before changing the scanner' });
  }
  return { schemaVersion: 1, kind: 'dependency-audit-diff', files, auditHash: fileHash(safePath(root, audit)), missed, invented,
    clean: !missed.length && !invented.length, next: missed.length || invented.length ? 'Confirm against source, fix scanner, regenerate the entire map, then resample with fresh contexts' : 'Combine both independent audits and review the phase report' };
}
