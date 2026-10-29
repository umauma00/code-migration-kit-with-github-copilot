#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safePath, relativeName, inside, filesUnder, writeJSON } from '../lib/core.mjs';
import { parseCommandLine, specs } from '../lib/cli.mjs';
import { readUtf8 } from '../lib/text.mjs';

// Parser paths are relative to depmapRoot; only sourceRoots are enumerated.
// Include isolated files too. This remains a draft requiring a coverage audit.
export function makeReviewDependencies(root, { sourceRoot, sourceRoots, depmapRoot, edges, out = 'migration/review-dependencies.json' }) {
  if (sourceRoot !== undefined && sourceRoots !== undefined) throw new Error('Choose sourceRoot or sourceRoots, not both');
  const roots = sourceRoots ?? [sourceRoot];
  if (!Array.isArray(roots) || !roots.length || new Set(roots).size !== roots.length) throw new Error('source-roots must be a nonempty list of unique directories');
  for (const dir of roots) {
    relativeName(dir);
    if (['.git', '.github', 'migration', 'migration-kit'].some(p => inside(dir, p) || inside(p, dir))) throw new Error(`source-roots must not include kit or migration metadata: ${dir}`);
    if (!fs.statSync(safePath(root, dir)).isDirectory()) throw new Error(`source-root must be a directory: ${dir}`);
  }
  if (depmapRoot === undefined) {
    if (roots.length !== 1) throw new Error('Specify depmap-root for multiple source-roots');
    depmapRoot = roots[0]; // Preserve the original single-root invocation.
  }
  if (depmapRoot !== '.') {
    relativeName(depmapRoot);
    if (!fs.statSync(safePath(root, depmapRoot)).isDirectory()) throw new Error('depmap-root must be a directory');
    if (roots.some(p => !inside(p, depmapRoot))) throw new Error('All source-roots must be inside depmap-root');
  }
  if (!inside(out, 'migration') || ['state', 'results', 'gates', 'runs', 'run.lock'].some(p => inside(out, `migration/${p}`))) throw new Error('Output must be under migration outside generated runtime state');
  const destination = safePath(root, out);
  const dependencies = Object.fromEntries([...new Set(roots.flatMap(p => filesUnder(root, p)))].sort().map(p => [p, []]));
  const selected = p => roots.some(dir => inside(p, dir));
  const ignored = new Map();
  const resolve = value => {
    relativeName(value);
    const p = depmapRoot === '.' ? value : `${depmapRoot}/${value}`;
    safePath(root, p); // Reject symlinks and unsafe ancestors even in ignored edges.
    return p;
  };
  const requireFile = p => {
    const file = safePath(root, p);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Dependency edge file missing: ${p}`);
    dependencies[p] ??= [];
  };
  const rows = readUtf8(safePath(root, edges), edges).replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (rows.shift() !== 'from\tto') throw new Error('Dependency edge header must be from<TAB>to');
  for (const row of rows) {
    if (!row) continue;
    const cells = row.split('\t');
    if (cells.length !== 2) throw new Error(`Malformed dependency edge: ${row}`);
    const from = resolve(cells[0]), to = resolve(cells[1]);
    if (!selected(from)) { ignored.set(`${from}\0${to}`, { from, to }); continue; }
    if (!selected(to)) throw new Error(`Dependency outside source-roots: ${from} -> ${to}; add the required directory to source-roots and config.sourceRoots`);
    requireFile(from); requireFile(to);
    if (!dependencies[from].includes(to)) dependencies[from].push(to);
  }
  const map = { schemaVersion: 1, dependencies: Object.fromEntries(Object.keys(dependencies).sort().map(p => [p, dependencies[p].sort()])) };
  writeJSON(destination, map);
  const ignoredEdges = [...ignored.keys()].sort().map(key => ignored.get(key));
  return { out, files: Object.keys(dependencies).length, sourceRoots: roots, depmapRoot, ignoredEdgeCount: ignoredEdges.length, ignoredEdges,
    note: 'Draft only. Audit parser coverage, exclusions, ignored edges, unresolved imports and semantic evidence dependencies before translation approval.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseCommandLine(process.argv.slice(2), specs.make_review_dependencies);
    const usage = 'Usage: node migration-kit/scripts/make_review_dependencies.mjs (--source-root src | --source-roots pkg,shared) --edges migration/depmap/edges.tsv [--depmap-root .] [--out migration/review-dependencies.json] [--root PATH]';
    if (args.help) { console.log(usage); process.exit(0); }
    if ((!args['source-root'] && !args['source-roots']) || !args.edges) throw new Error(usage);
    console.log(JSON.stringify(makeReviewDependencies(fs.realpathSync(path.resolve(args.root ?? '.')), { sourceRoot: args['source-root'], sourceRoots: args['source-roots']?.split(','), depmapRoot: args['depmap-root'], edges: args.edges, out: args.out }), null, 2));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
