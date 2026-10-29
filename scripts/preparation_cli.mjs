#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, writeJSON, lockRun, assertReportPath } from '../lib/core.mjs';
import { parseCommandLine, specs, usageText } from '../lib/cli.mjs';
import { previewInventory, mergeInventory, packageCycles, dependencySamples, dependencyTargets, compareDependencyAudit } from '../lib/preparation.mjs';
import { generatedFilesCommand } from '../lib/generated.mjs';
import { policyQuestions, recordPolicy, rulebookCoverage } from '../lib/policy.mjs';
export function preparationCommand(root, config, action, options = {}) {
  if (action === 'inventory-preview') return previewInventory(root, config, { shards: options.shards?.split(','), sites: options.sites, out: options.out });
  if (action === 'inventory-merge') return mergeInventory(root, config, { shards: options.shards?.split(','), sites: options.sites, expectedHash: options['expected-hash'] });
  // Setup checks before the inventory survey; each takes its own lock when it writes.
  if (action === 'generated-files') return generatedFilesCommand(root, config, { write: Boolean(options.write), regenerate: options.regenerate, translate: options.translate, how: options.how, target: options.target });
  if (action === 'policy-questions') return policyQuestions(root, config);
  if (action === 'policy-record') return recordPolicy(root, config, { topic: options.topic, answer: options.answer, auto: Boolean(options.auto) });
  if (action === 'rulebook-coverage') return rulebookCoverage(root, config, { sites: options.sites });
  const release = lockRun(root, `preparation-${action}`);
  try {
    let result, out;
    if (action === 'package-cycles') { result = packageCycles(root, config, options.map ?? config.packageMap); out = 'migration/depmap/package-cycles.json'; }
    else if (action === 'dependency-samples') { result = dependencySamples(root, config, { seed: options.seed, size: options.size === undefined ? 20 : Number(options.size) }); out = options.out ?? 'migration/depmap/audit-samples.json'; }
    else if (action === 'dependency-targets') { result = dependencyTargets(root, config, { size: options.size === undefined ? 10 : Number(options.size), unresolved: options.unresolved, depmapRoot: options['depmap-root'] }); out = options.out ?? 'migration/depmap/audit-targets.json'; }
    else if (action === 'dependency-diff') { result = compareDependencyAudit(root, config, { files: options.files?.split(','), audit: options.audit }); out = options.out ?? 'migration/depmap/audit-diff.json'; }
    else throw new Error('Use inventory-preview --shards LIST --sites PATH | inventory-merge --shards LIST --sites PATH [--expected-hash SHA256] | package-cycles --map PATH | dependency-samples --seed TEXT | dependency-targets [--size N] [--depmap-root DIR] [--unresolved PATH] [--out PATH] | dependency-diff --files LIST --audit PATH | generated-files [--write] [--regenerate PATH --how TEXT [--target PATH] | --translate PATH] | policy-questions | policy-record --topic ID --answer TEXT [--auto] | rulebook-coverage [--sites PATH]');
    if (!out.startsWith('migration/depmap/')) throw new Error('Audit reports must be under migration/depmap/');
    // Never let a report replace the mapper's own outputs.
    if (/^migration\/depmap\/(?:edges\.tsv|order\.txt|cycles\.txt|unresolved\.tsv|external\.tsv|report\.md)$/i.test(out)) throw new Error(`Audit reports cannot replace mapper output: ${out}`);
    writeJSON(assertReportPath(root, config, out), result); return result;
  } finally { release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCommandLine(process.argv.slice(2), specs.preparation_cli);
    if (args.help) console.log(usageText(specs.preparation_cli));
    else { const root = fs.realpathSync(path.resolve(args.root ?? '.')); console.log(JSON.stringify(preparationCommand(root, loadConfig(root), args._[0], args), null, 2)); }
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
