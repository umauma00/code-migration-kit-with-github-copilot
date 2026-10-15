#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Language adapters produce this TSV from ONE build; no generic compiler parser
// or model-based re-derivation is claimed here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseArgs, safePath, readJSON, readManifest, fileHash, contextHash, atomicWrite, writeJSON, lockRun, assertReportPath } from '../lib/core.mjs';
import { outputFingerprint } from '../lib/pipeline.mjs';
import { readReviewText } from '../lib/review.mjs';
export function makeRepairQueue(root, config, { diagnostics, out = 'migration/repair-queue.json' } = {}) {
  if (!diagnostics?.startsWith('migration/') || !out.startsWith('migration/')) throw new Error('Diagnostics and queue must be project-relative files under migration/');
  if (out === diagnostics) throw new Error('Queue output overlaps diagnostic input');
  assertReportPath(root, config, out);
  const release = lockRun(root, 'diagnostic-queue');
  try {
    const context = contextHash(root, config), build = readJSON(safePath(root, 'migration/results/build.json'));
    if (!build.executionId || build.stage !== 'build' || build.invalidatedAt || build.contextHash !== context || build.outputHash !== outputFingerprint(root, config)) throw new Error('Diagnostics need a current build attempt for these inputs and outputs');
    const units = new Map(readManifest(root, config).map(u => [u.target, u]));
    const lines = readReviewText(root, diagnostics).replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
    if (lines.shift() !== 'file\tmodule\tcode\tmessage') throw new Error('Diagnostic TSV header must be file<TAB>module<TAB>code<TAB>message');
    const groups = new Map();
    for (const line of lines.filter(Boolean)) {
      const cells = line.split('\t');
      if (cells.length !== 4 || cells.some(v => !v.trim()) || !units.has(cells[0])) throw new Error('Malformed diagnostic or file outside manifest ownership');
      if (!groups.has(cells[0])) groups.set(cells[0], []);
      groups.get(cells[0]).push(line);
    }
    if (!groups.size) throw new Error('Diagnostic queue is empty');
    const jobs = [];
    for (const target of [...groups.keys()].sort()) {
      const evidence = `migration/diagnostics/${build.executionId}/${units.get(target).id}.txt`;
      assertReportPath(root, config, evidence);
      const text = `Build execution: ${build.executionId}\nfile\tmodule\tcode\tmessage\n${[...new Set(groups.get(target))].sort().join('\n')}\n`;
      if (text.length > 16000) throw new Error('Diagnostic slice too large; select a smaller explicit round, do not truncate evidence');
      jobs.push({ target, outputHash: fileHash(safePath(root, target)), evidence, evidenceHash: null, text });
    }
    // Validate every slice before publishing any one of them.
    for (const job of jobs) {
      atomicWrite(safePath(root, job.evidence), job.text); delete job.text;
      job.evidenceHash = fileHash(safePath(root, job.evidence));
    }
    const queue = { schemaVersion: 1, kind: 'repair-queue', contextHash: context, buildExecutionId: build.executionId,
      diagnostics: [diagnostics, fileHash(safePath(root, diagnostics))], jobs };
    if (contextHash(root, config) !== context) throw new Error('Protected inputs changed while creating diagnostics');
    writeJSON(safePath(root, out), queue); return queue;
  } finally { release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = parseArgs(process.argv.slice(2)), root = fs.realpathSync(path.resolve(args.root ?? '.')); console.log(JSON.stringify(makeRepairQueue(root, loadConfig(root), args), null, 2)); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
