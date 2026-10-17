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
import { diagnosticsForUnits, diagnosticTsv } from '../lib/diagnostics.mjs';
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
const roundsFile = 'migration/build-rounds.tsv';
// One row per build attempt: the round-over-round error counts upstream asked
// the orchestrator to show at the Step 4 gate.
function recordRound(root, build, row) {
  const file = safePath(root, roundsFile), header = 'round\tbuild_execution\tfinished_at\tsuccess\tdiagnostics\ttargets\tunmapped\n';
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : header;
  const rows = old.trimEnd().split('\n').slice(1).filter(Boolean);
  if (rows.some(r => r.split('\t')[1] === build.executionId)) return rows.length;
  rows.push([rows.length + 1, build.executionId, build.finishedAt ?? 'unknown', build.success, row.diagnostics, row.targets, row.unmapped].join('\t'));
  atomicWrite(file, header + rows.join('\n') + '\n');
  return rows.length;
}

// Parse the current recorded build with the bundled parsers, write the TSV and
// the repair queue. Unparsed lines are reported, never guessed into targets.
export function diagnoseBuild(root, config, { out = 'migration/repair-queue.json' } = {}) {
  const build = readJSON(safePath(root, 'migration/results/build.json'));
  if (!build.executionId || build.stage !== 'build' || build.invalidatedAt) throw new Error('No current build attempt to diagnose; approve and run build first');
  if (build.success) {
    const round = recordRound(root, build, { diagnostics: 0, targets: 0, unmapped: 0 });
    return { clean: true, buildExecutionId: build.executionId, round, rounds: roundsFile };
  }
  const text = (build.commands ?? []).map(c => `${c.stdout ?? ''}\n${c.stderr ?? ''}`).join('\n');
  const { rows, unmapped, formats, parsed } = diagnosticsForUnits(root, readManifest(root, config), text);
  const diagnostics = `migration/build-diagnostics/${build.executionId}.tsv`;
  assertReportPath(root, config, diagnostics);
  if (!rows.length) {
    recordRound(root, build, { diagnostics: 0, targets: 0, unmapped: unmapped.length });
    throw new Error(`Build failed but no diagnostic maps to a manifest target (parsed ${parsed}, unmapped ${unmapped.length}). Inspect migration/results/build.json; unmapped: ${unmapped.slice(0, 5).join(' | ') || 'none'}`);
  }
  atomicWrite(safePath(root, diagnostics), diagnosticTsv(rows));
  const queue = makeRepairQueue(root, config, { diagnostics, out });
  const round = recordRound(root, build, { diagnostics: rows.length, targets: queue.jobs.length, unmapped: unmapped.length });
  return { clean: false, buildExecutionId: build.executionId, round, rounds: roundsFile, diagnostics, queue: out,
    errors: rows.length, targets: queue.jobs.map(j => j.target), formats, unmapped: unmapped.slice(0, 50), unmappedCount: unmapped.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = parseArgs(process.argv.slice(2)), root = fs.realpathSync(path.resolve(args.root ?? '.')); console.log(JSON.stringify(makeRepairQueue(root, loadConfig(root), args), null, 2)); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
