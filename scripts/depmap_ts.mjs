#!/usr/bin/env node
// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
// Copilot adaptation: lexical dependency scanning updated on 2026-10-26; see NOTICE.
/**
 * Deterministic dependency mapper for JS/TS codebases (node stdlib only).
 *
 * Implements the kit's dependency-map contract (prompts/01-dependency-map.md).
 * Parses `import ... from '...'`, `export ... from '...'`, and `require('...')`
 * with a lexical scanner. RELATIVE specifiers only — bare specifiers (npm
 * packages, node builtins) are neither edges nor misses.
 *
 * Computed imports and path aliases (tsconfig "paths") need an audited adapter.
 * For codebases requiring compiler-level resolution, replace the
 * parse step for ts-morph or the TypeScript compiler API — keep the output
 * contract identical.
 *
 * Usage: node depmap_ts.mjs --root path/to/repo --out path/to/migration/depmap
 * Output: edges.tsv, order.txt, cycles.txt (same contract as depmap_python.py)
 *
 * Test: node scripts/depmap_ts.mjs --root fixtures/ts --out /tmp/depmap-ts && diff /tmp/depmap-ts/edges.tsv fixtures/ts/expected_edges.tsv && diff /tmp/depmap-ts/cycles.txt fixtures/ts/expected_cycles.txt && diff /tmp/depmap-ts/order.txt fixtures/ts/expected_order.txt
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { moduleSpecifiers } from './depmap_js_scan.mjs';

const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

function args() {
  const a = process.argv.slice(2), out = { sourceRoots: [] }, usage = "usage: --root <dir> --out <dir> [--source-root <relative-dir>]...";
  if (a.includes("--help") || a.includes("-h")) { console.log(usage); process.exit(0); }
  for (let i = 0; i < a.length; i += 2) {
    if (!["--root", "--out", "--source-root"].includes(a[i])) { console.error(`unknown argument: ${a[i]} (${usage})`); process.exit(1); }
    if (a[i + 1] === undefined || a[i + 1].startsWith("--")) { console.error(`missing value for ${a[i]} (${usage})`); process.exit(1); }
    if (a[i] === '--source-root') out.sourceRoots.push(a[i + 1].replaceAll('\\', '/'));
    else out[a[i].slice(2)] = a[i + 1];
  }
  if (!out.root || !out.out) { console.error(usage); process.exit(1); }
  return out;
}

function walk(dir, root, acc, sourceRoots) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    if (dir === root && ((name === 'migration-kit' && existsSync(join(root, name, 'scripts/run_migration.mjs'))) || (name === 'migration' && existsSync(join(root, name, 'config.json'))))) continue;
    if (entry.isSymbolicLink()) continue; // never follow symlinks: no cycles, no escapes outside --root
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join('/');
    const selected = !sourceRoots.length || sourceRoots.some(r => r === '.' || rel === r || rel.startsWith(r + '/'));
    if (entry.isDirectory() && (selected || sourceRoots.some(r => r.startsWith(rel + '/')))) walk(p, root, acc, sourceRoots);
    else if (selected && entry.isFile() && EXTS.some(e => name.endsWith(e)) && !name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

function resolveSpecifier(spec, fromFile, fileSet) {
  if (!spec.startsWith(".")) return null; // bare specifier: not in-repo
  const base = resolve(dirname(fromFile), spec);
  // Node-style TS imports write the emitted suffix (.js/.mjs/.cjs) while
  // the audited source is .ts/.mts/.cts. Keep an exact runtime file first.
  const source = /\.mjs$/.test(base) ? [base.slice(0, -4) + '.mts']
    : /\.cjs$/.test(base) ? [base.slice(0, -4) + '.cts']
    : /\.jsx?$/.test(base) ? [base.replace(/\.jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx')] : [];
  const candidates = [base, ...source, ...EXTS.map(e => base + e), ...EXTS.map(e => join(base, "index" + e))];
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null; // unresolvable: skipped, per in-repo-only contract
}

function tarjan(nodes, adj) {
  let counter = 0;
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [], sccs = [];
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, pi] = frame;
      if (pi === 0) {
        index.set(node, counter); low.set(node, counter); counter++;
        stack.push(node); onStack.add(node);
      }
      let recursed = false;
      const succs = adj.get(node) || [];
      for (let i = pi; i < succs.length; i++) {
        const s = succs[i];
        if (!index.has(s)) { frame[1] = i + 1; work.push([s, 0]); recursed = true; break; }
        else if (onStack.has(s)) low.set(node, Math.min(low.get(node), index.get(s)));
      }
      if (recursed) continue;
      if (low.get(node) === index.get(node)) {
        const scc = [];
        for (;;) { const w = stack.pop(); onStack.delete(w); scc.push(w); if (w === node) break; }
        sccs.push(scc.sort());
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
    }
  }
  return sccs; // reverse topological order of condensation = dependencies first
}

const { root: rootArg, out: outArg, sourceRoots } = args();
const root = resolve(rootArg);
if (!statSync(root).isDirectory()) throw new Error(`--root is not a directory: ${rootArg}`);
for (const dir of sourceRoots) {
  if ((dir !== '.' && (!dir || dir.startsWith('/') || /[:\t\r\n\0]/.test(dir) || dir.split('/').some(p => ['', '.', '..'].includes(p)))) || !statSync(join(root, dir)).isDirectory()) throw new Error('--source-root must be a normalized directory relative to --root');
}
const files = walk(root, root, [], sourceRoots);
const fileSet = new Set(files);
const rel = p => relative(root, p).split(sep).join("/");

const edges = new Set();
const unresolved = [];
for (const f of files) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(f));
    if (text.includes('\0')) throw new Error('NUL bytes or unsupported text encoding');
  }
  catch (e) { unresolved.push([rel(f), '(whole file)', `source not read: ${e.code ?? e.message}`]); continue; }
  const issues = [];
  for (const specifier of moduleSpecifiers(text, issues, { jsx: !/\.(?:ts|mts|cts)$/.test(f) })) {
    const dep = resolveSpecifier(specifier, f, fileSet);
    if (dep && dep !== f) edges.add(rel(f) + "\t" + rel(dep));
    else if (!dep && specifier.startsWith('.')) unresolved.push([rel(f), specifier, 'relative module not found under --root; check declarations and path aliases']);
  }
  for (const issue of issues) unresolved.push([rel(f), issue.reference, issue.reason]);
}
const sortedEdges = [...edges].sort();
const nodes = files.map(rel).sort();
const adj = new Map(nodes.map(n => [n, []]));
for (const e of sortedEdges) { const [a, b] = e.split("\t"); adj.get(a).push(b); }
for (const v of adj.values()) v.sort();

const sccs = tarjan(nodes, adj);
const cycles = sccs.filter(s => s.length > 1);

mkdirSync(outArg, { recursive: true });
writeFileSync(join(outArg, "edges.tsv"), "from\tto\n" + sortedEdges.map(e => e + "\n").join(""));
writeFileSync(join(outArg, "order.txt"),
  "# migration order: one batch per line, dependencies first\n" + sccs.map(s => s.join("\t") + "\n").join(""));
writeFileSync(join(outArg, "cycles.txt"),
  `# strongly connected components > 1 file: ${cycles.length}\n` + cycles.map(s => s.join("\t") + "\n").join(""));
writeFileSync(join(outArg, 'unresolved.tsv'), 'file\treference\treason\n' + [...new Set(unresolved.map(row => row.map(v => v.replace(/[\t\r\n]/g, ' ')).join('\t')))].sort().map(row => row + '\n').join(''));
console.log(`files=${files.length} edges=${sortedEdges.length} batches=${sccs.length} cycles=${cycles.length}`);
if (!files.length) console.error('WARN: no JS/TS source files under --root; check the language and source roots');
if (files.length > 1 && sortedEdges.length === 0) {
  console.error(
    "WARN: 0 edges across multiple files. If these files import each other, " +
    "--root is probably pointing at the wrong directory, or the imports use " +
    "bare specifiers / tsconfig path aliases (only relative specifiers are mapped)."
  );
}
