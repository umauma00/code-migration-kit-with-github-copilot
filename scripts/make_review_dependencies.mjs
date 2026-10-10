#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safePath, relativeName, inside, filesUnder, parseArgs, writeJSON } from '../lib/core.mjs';
import { readUtf8 } from '../lib/text.mjs';

// Starter depmaps use paths relative to their --root. Include isolated files as
// explicit nodes. The result is a draft: audit unresolved/semantic dependencies.
export function makeReviewDependencies(root, { sourceRoot, edges, out = 'migration/review-dependencies.json' }) {
  relativeName(sourceRoot);
  if (!fs.statSync(safePath(root, sourceRoot)).isDirectory()) throw new Error('source-root must be a directory');
  if (!inside(out, 'migration') || ['state', 'results', 'gates', 'runs', 'run.lock'].some(p => inside(out, `migration/${p}`))) throw new Error('Output must be under migration outside generated runtime state');
  const destination = safePath(root, out);
  const dependencies = Object.fromEntries(filesUnder(root, sourceRoot).map(p => [p, []]));
  const name = value => {
    relativeName(value);
    const p = `${sourceRoot}/${value}`, file = safePath(root, p);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Dependency edge file missing: ${p}`);
    dependencies[p] ??= [];
    return p;
  };
  const rows = readUtf8(safePath(root, edges), edges).replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (rows.shift() !== 'from\tto') throw new Error('Dependency edge header must be from<TAB>to');
  for (const row of rows) {
    if (!row) continue;
    const cells = row.split('\t');
    if (cells.length !== 2) throw new Error(`Malformed dependency edge: ${row}`);
    const from = name(cells[0]), to = name(cells[1]);
    if (!dependencies[from].includes(to)) dependencies[from].push(to);
  }
  const map = { schemaVersion: 1, dependencies: Object.fromEntries(Object.keys(dependencies).sort().map(p => [p, dependencies[p].sort()])) };
  writeJSON(destination, map);
  return { out, files: Object.keys(dependencies).length, note: 'Draft only. Audit parser coverage, exclusions, unresolved imports and semantic evidence dependencies before translation approval.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args['source-root'] || !args.edges) throw new Error('Usage: node migration-kit/scripts/make_review_dependencies.mjs --source-root src --edges migration/depmap/edges.tsv [--out migration/review-dependencies.json] [--root PATH]');
    console.log(JSON.stringify(makeReviewDependencies(fs.realpathSync(path.resolve(args.root ?? '.')), { sourceRoot: args['source-root'], edges: args.edges, out: args.out }), null, 2));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
