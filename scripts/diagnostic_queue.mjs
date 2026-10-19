#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Language adapters produce this TSV from ONE failed build, smoke or parity
// run; no generic parser or model-based re-derivation is claimed here.
// Smoke and parity failures are upstream Step 6's burn-down queue: the same
// reviewed repair path as build errors, proved by fresh approved runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseArgs, safePath, readJSON, readManifest, fileHash, contextHash, atomicWrite, writeJSON, lockRun, assertReportPath } from '../lib/core.mjs';
import { outputFingerprint } from '../lib/pipeline.mjs';
import { readReviewText } from '../lib/review.mjs';
import { diagnosticsForUnits, diagnosticTsv } from '../lib/diagnostics.mjs';
export const repairStages = ['build', 'smoke', 'parity'];
const stageCommands = { build: ['build'], smoke: ['smoke'], parity: ['parity'] };
const roundsFiles = { build: 'migration/build-rounds.tsv', smoke: 'migration/smoke-rounds.tsv', parity: 'migration/parity-rounds.tsv' };
export function makeRepairQueue(root, config, { diagnostics, out = 'migration/repair-queue.json', stage = 'build' } = {}) {
  if (!repairStages.includes(stage)) throw new Error('Repair queues come from a build, smoke or parity run');
  if (!diagnostics?.startsWith('migration/') || !out.startsWith('migration/')) throw new Error('Diagnostics and queue must be project-relative files under migration/');
  if (out === diagnostics) throw new Error('Queue output overlaps diagnostic input');
  assertReportPath(root, config, out);
  const release = lockRun(root, 'diagnostic-queue');
  try {
    const context = contextHash(root, config), build = readJSON(safePath(root, `migration/results/${stage}.json`));
    if (!build.executionId || build.stage !== stage || build.invalidatedAt || build.contextHash !== context || build.outputHash !== outputFingerprint(root, config)) throw new Error(`Diagnostics need a current ${stage} attempt for these inputs and outputs`);
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
      const text = `${stage === 'build' ? 'Build' : stage === 'smoke' ? 'Smoke' : 'Parity'} execution: ${build.executionId}\nfile\tmodule\tcode\tmessage\n${[...new Set(groups.get(target))].sort().join('\n')}\n`;
      if (text.length > 16000) throw new Error('Diagnostic slice too large; select a smaller explicit round, do not truncate evidence');
      jobs.push({ target, outputHash: fileHash(safePath(root, target)), evidence, evidenceHash: null, text });
    }
    // Validate every slice before publishing any one of them.
    for (const job of jobs) {
      atomicWrite(safePath(root, job.evidence), job.text); delete job.text;
      job.evidenceHash = fileHash(safePath(root, job.evidence));
    }
    // buildExecutionId names the failed validation run, whichever stage it was.
    const queue = { schemaVersion: 1, kind: 'repair-queue', ...(stage === 'build' ? {} : { stage }), contextHash: context, buildExecutionId: build.executionId,
      diagnostics: [diagnostics, fileHash(safePath(root, diagnostics))], jobs };
    if (contextHash(root, config) !== context) throw new Error('Protected inputs changed while creating diagnostics');
    writeJSON(safePath(root, out), queue); return queue;
  } finally { release(); }
}
// One row per attempt: the round-over-round error counts upstream asked the
// orchestrator to show at the Step 4 (and Step 6) gates.
function recordRound(root, build, row, roundsFile = roundsFiles.build) {
  const file = safePath(root, roundsFile), header = 'round\tbuild_execution\tfinished_at\tsuccess\tdiagnostics\ttargets\tunmapped\n';
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : header;
  const rows = old.trimEnd().split('\n').slice(1).filter(Boolean);
  if (rows.some(r => r.split('\t')[1] === build.executionId)) return rows.length;
  rows.push([rows.length + 1, build.executionId, build.finishedAt ?? 'unknown', build.success, row.diagnostics, row.targets, row.unmapped].join('\t'));
  atomicWrite(file, header + rows.join('\n') + '\n');
  return rows.length;
}

// Parse the current recorded run with the bundled parsers, write the TSV and
// the repair queue. Unparsed lines are reported, never guessed into targets.
export function diagnoseBuild(root, config, { out = 'migration/repair-queue.json', stage = 'build' } = {}) {
  if (!repairStages.includes(stage)) throw new Error('diagnose --stage must be build, smoke or parity');
  const roundsFile = roundsFiles[stage], record = `migration/results/${stage}.json`;
  const build = readJSON(safePath(root, record));
  if (!build.executionId || build.stage !== stage || build.invalidatedAt) throw new Error(`No current ${stage} attempt to diagnose; approve and run ${stage} first`);
  if (build.success) {
    const round = recordRound(root, build, { diagnostics: 0, targets: 0, unmapped: 0 }, roundsFile);
    return { clean: true, stage, buildExecutionId: build.executionId, round, rounds: roundsFile };
  }
  // The original suite runs on the original code: its failure is inherited or
  // environmental, never a translation repair (upstream Step 6 triage).
  const original = (build.commands ?? []).find(c => c.name === 'original');
  if (stage === 'parity' && original && original.status !== 'success') throw new Error(`The original suite failed in ${record}: an inherited or environmental failure, not a translation defect. Show it to the person; do not repair translated outputs for it`);
  const text = (build.commands ?? []).filter(c => stageCommands[stage].includes(c.name)).map(c => `${c.stdout ?? ''}\n${c.stderr ?? ''}`).join('\n');
  const { rows, unmapped, formats, parsed } = diagnosticsForUnits(root, readManifest(root, config), text);
  const diagnostics = `migration/${stage}-diagnostics/${build.executionId}.tsv`;
  assertReportPath(root, config, diagnostics);
  if (!rows.length) {
    recordRound(root, build, { diagnostics: 0, targets: 0, unmapped: unmapped.length }, roundsFile);
    throw new Error(stage === 'build'
      ? `Build failed but no diagnostic maps to a manifest target (parsed ${parsed}, unmapped ${unmapped.length}). Inspect ${record}; unmapped: ${unmapped.slice(0, 5).join(' | ') || 'none'}`
      : `${stage} failed but no output line names a manifest target (parsed ${parsed}, unmapped ${unmapped.length}). Triage each divergence against the original first (regression, inherited, environment, comparator defect); for confirmed regressions write file<TAB>module<TAB>code<TAB>message rows naming the owning targets and run diagnostic_queue.mjs --stage ${stage} --diagnostics migration/PATH.tsv. Unmapped: ${unmapped.slice(0, 5).join(' | ') || 'none'}`);
  }
  atomicWrite(safePath(root, diagnostics), diagnosticTsv(rows));
  const queue = makeRepairQueue(root, config, { diagnostics, out, stage });
  const round = recordRound(root, build, { diagnostics: rows.length, targets: queue.jobs.length, unmapped: unmapped.length }, roundsFile);
  return { clean: false, stage, buildExecutionId: build.executionId, round, rounds: roundsFile, diagnostics, queue: out,
    errors: rows.length, targets: queue.jobs.map(j => j.target), formats, unmapped: unmapped.slice(0, 50), unmappedCount: unmapped.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = parseArgs(process.argv.slice(2)), root = fs.realpathSync(path.resolve(args.root ?? '.')); console.log(JSON.stringify(makeRepairQueue(root, loadConfig(root), args), null, 2)); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
