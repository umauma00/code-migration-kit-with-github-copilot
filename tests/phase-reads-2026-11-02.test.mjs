// SPDX-License-Identifier: Apache-2.0
// 0.42.1: on 2026-11-02 (Windows, source-as-spec, auto mode) a kit update from
// 0.40.0 made phase 00b's record out of date (its judge fingerprint format
// changed in 0.40.1), so 00b to 03 were recorded again. Every check of every
// phase command hashed the whole source tree again (about 6 s per pass on
// that PC). In this source-as-spec fixture phase next and status read a
// source file 20 times each, phase check 00b,01,02 43 times, phase complete
// 00b,01,02 61 times and phase complete 03 26 times. After parity, one status
// read each translated file 33 times. Each command now reads every file once
// (an output twice: its hash and its markers); nothing is kept between commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, fake, mini } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, fileHash, contextHash, loadConfig } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { install } from '../scripts/install.mjs';
import { currentPhase, requirePhase } from '../lib/phases.mjs';
import { judgeInputHash } from '../lib/judge.mjs';
import { runStage, approve, translate, requireGate } from '../lib/pipeline.mjs';
import { installGuardrails } from '../lib/guardrails.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { initSourceSpec } from '../lib/source-spec.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// How many times fn reads each of the given files.
function readsOf(files, fn) {
  const real = files.map(file => fs.realpathSync(file)), counts = real.map(() => 0), original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string') { const i = real.indexOf(path.resolve(file)); if (i >= 0) counts[i]++; }
    return original.call(this, file, ...rest);
  };
  let value;
  try { value = fn(); } finally { fs.readFileSync = original; }
  return { counts, value };
}
// fn reads each given file at most once; returns what fn returned.
function once(files, label, fn) {
  const { counts, value } = readsOf(files, fn);
  counts.forEach((n, i) => assert.ok(n <= 1, `${label}: ${path.basename(files[i])} read ${n} times`));
  return value;
}

// A source-only source-as-spec project as in the incident: 00 recorded, the
// specification package 00b to 02 recorded together, the formal judge run.
async function specProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-reads-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double', preparationProfile: 'source-as-spec' });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  atomicWrite(safePath(root, 'tests/README.md'), 'No original runtime; contracts live in migration/source-spec.\n');
  let config = loadConfig(root);
  initSourceSpec(root, config, { apply: true }); config = loadConfig(root);
  assert.equal(config.verificationMode, 'source-only');
  phaseCommand(root, config, 'init');
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Three files; no original runtime or spec.\n');
  phaseCommand(root, config, 'complete', '00', { note: 'User reviewed feasibility' });
  atomicWrite(safePath(root, 'migration/judge-report.md'), 'Source-derived contracts for three files; equivalence unverified.\n');
  atomicWrite(safePath(root, 'migration/depmap/edges.tsv'), 'from\tto\nsrc/main.py\tsrc/math_ops.py\nsrc/main.py\tsrc/text_ops.py\n');
  atomicWrite(safePath(root, 'migration/depmap/order.txt'), 'src/math_ops.py\tsrc/text_ops.py\nsrc/main.py\n');
  atomicWrite(safePath(root, 'migration/depmap/report.md'), 'Python parser over src; no unsupported syntax.\n');
  atomicWrite(safePath(root, 'migration/gap-report.md'), 'Floor division and code-point length decided from source.\n');
  atomicWrite(safePath(root, 'migration/manifest.tsv'), 'source\ttarget\nsrc/math_ops.py\tported/math_ops.mjs\nsrc/text_ops.py\tported/text_ops.mjs\nsrc/main.py\tported/main.mjs\n');
  atomicWrite(safePath(root, 'migration/review-dependencies.json'), JSON.stringify({ schemaVersion: 1, dependencies: {
    'src/math_ops.py': [], 'src/text_ops.py': [], 'src/main.py': ['src/math_ops.py', 'src/text_ops.py'] } }));
  atomicWrite(safePath(root, 'migration/RULEBOOK.md'), '# Rules drafted from source\nPreserve floor division and code-point lengths.\n');
  atomicWrite(safePath(root, 'migration/inventory.tsv'), 'file\tissue\tdecision\nsrc/math_ops.py\tnegative division\tfloor\n');
  const sources = ['math_ops', 'text_ops', 'main'].map(n => safePath(root, `src/${n}.py`));
  once(sources, 'phase complete 00b,01,02', () => phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User reviewed the specification package' }));
  assert.equal((await runStage(root, config, 'judge')).success, true);
  return { root, config, sources };
}
// Each record names the receipt it was recorded after, and holds when read
// again from scratch (no memo of the command that wrote it).
function chainHolds(root, config, ids) {
  for (const [i, id] of ids.entries()) {
    assert.ok(currentPhase(root, config, id), `phase ${id} is current on a fresh read`);
    if (i) assert.equal(readJSON(safePath(root, `migration/phases/${id}.json`)).predecessorHash, fileHash(safePath(root, `migration/phases/${ids[i - 1]}.json`)), `phase ${id} names the ${ids[i - 1]} receipt written before it`);
  }
}

test('recording 00b to 03 again after the kit update reads each source file once per command, as in the incident', async t => {
  const { root, config, sources } = await specProject(t);
  atomicWrite(safePath(root, 'migration/stress-test/report.md'), 'Stress test report: rules held on the trial files; judge passed (equivalence unverified).\n');
  installGuardrails(root, kitRoot, { waiver: 'Test fixture: disposable sandbox, no real commands' });
  once(sources, 'phase start 03', () => phaseCommand(root, config, 'start', '03'));
  once(sources, 'phase complete 03', () => phaseCommand(root, config, 'complete', '03', { note: 'User reviewed the stress test' }));
  assert.equal(phaseCommand(root, config, 'next').next, '04');
  // The 00b record as kit 0.40.0 left it: its judge fingerprint also hashed the kit.
  const file = safePath(root, 'migration/phases/00b.json'), old = readJSON(file);
  delete old.judgeInputSchema; old.judgeInputHash = '0'.repeat(64); writeJSON(file, old);
  const next = once(sources, 'phase next', () => phaseCommand(root, config, 'next'));
  assert.equal(next.next, '00b');
  assert.deepEqual(next.stale.reasons.map(r => r.kind), ['judge-format']);
  assert.equal(next.stale.record, 'phase complete 00b,01,02 --note TEXT');
  assert.deepEqual(next.stale.later, ['03']);
  const status = once(sources, 'status', () => migrationStatus(root));
  assert.equal(status.workflow.next, '00b');
  assert.equal(status.workflow.stale.phase, '00b');
  const check = once(sources, 'phase check 00b,01,02', () => phaseCommand(root, config, 'check', '00b,01,02'));
  assert.deepEqual(check.map(c => [c.phase, c.ready]), [['00b', true], ['01', true], ['02', true]]);
  assert.deepEqual(check[0].stale.reasons.map(r => r.kind), ['judge-format']);
  once(sources, 'phase check 00b', () => phaseCommand(root, config, 'check', '00b'));
  const recorded = once(sources, 'phase complete 00b,01,02', () => phaseCommand(root, config, 'complete', '00b,01,02', { note: 'Recorded again after the kit update; nothing changed' }));
  assert.deepEqual(recorded.map(r => r.phase), ['00b', '01', '02']);
  // Written in the middle of the command, the receipts were read again: each
  // names the one recorded just before it, with this kit's judge format.
  chainHolds(root, config, ['00', '00b', '01', '02']);
  const b = readJSON(file);
  assert.equal(b.judgeInputSchema, 2);
  assert.equal(b.judgeInputHash, judgeInputHash(root, config));
  assert.equal(readJSON(safePath(root, 'migration/phases/02.json')).contextHash, contextHash(root, config));
  // Phase 03 waits only for its predecessor; recording it reads once too.
  assert.deepEqual(once(sources, 'phase next', () => phaseCommand(root, config, 'next')).stale.reasons.map(r => r.kind), ['predecessor']);
  once(sources, 'phase complete 03', () => phaseCommand(root, config, 'complete', '03', { note: 'Recorded again after phase 02; the stress test still holds' }));
  chainHolds(root, config, ['00', '00b', '01', '02', '03']);
  assert.equal(once(sources, 'phase next', () => phaseCommand(root, config, 'next')).next, '04');
  // A gate of a runner command makes its own read, once for the whole chain.
  once(sources, 'the 03 gate', () => requirePhase(root, config, '03'));
  // Nothing is kept between commands: a source edited after them is seen.
  atomicWrite(sources[0], `${fs.readFileSync(sources[0], 'utf8')}# edited after the records\n`);
  const changed = phaseCommand(root, config, 'next');
  assert.equal(changed.next, '00');
  assert.ok(changed.stale.reasons.some(r => r.kind === 'source'), JSON.stringify(changed.stale.reasons));
  assert.throws(() => requirePhase(root, config, '03'), /out of date/);
});

test('a refused package records nothing and a later change in the same files is still seen', async t => {
  const { root, config, sources } = await specProject(t);
  // 02's evidence changed: the dry run of the whole package stops before any write.
  const before = ['00b', '01', '02'].map(id => fs.readFileSync(safePath(root, `migration/phases/${id}.json`), 'utf8'));
  atomicWrite(safePath(root, 'migration/RULEBOOK.md'), '# Fixture rules\n[source language] placeholder left in.\n');
  assert.throws(() => phaseCommand(root, config, 'complete', '00b,01,02', { note: 'should not record' }), /still the installed template/);
  assert.deepEqual(['00b', '01', '02'].map(id => fs.readFileSync(safePath(root, `migration/phases/${id}.json`), 'utf8')), before);
  atomicWrite(safePath(root, 'migration/RULEBOOK.md'), '# Rules drafted from source\nPreserve floor division, code-point lengths and zero-division errors.\n');
  const next = once(sources, 'phase next', () => phaseCommand(root, config, 'next'));
  assert.equal(next.next, '02');
  once(sources, 'phase complete 02', () => phaseCommand(root, config, 'complete', '02', { note: 'User reviewed the changed rules' }));
  chainHolds(root, config, ['00', '00b', '01', '02']);
});

test('status after parity reads each source once and each translated file once for its hash and once for its markers, and sees a change made after it', async t => {
  const f = prepare(t, { count: 3 });
  // The installed marker policy: done() also reads each output for its markers.
  f.config.markerPolicy = 'todo-lines-v1';
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Test fixture approval');
  // The fixture outputs with the trailer that policy asks for.
  const marked = async call => {
    const answer = await fake(call);
    if (answer.result.kind === 'implementation') answer.result.content = `${answer.result.content.replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd()}\n// PORT STATUS: confidence=high todos=0\n`;
    return answer;
  };
  assert.equal((await translate(f.root, f.config, marked)).unitsCompleted, 3);
  for (const stage of ['build', 'smoke', 'parity']) { approve(f.root, f.config, stage, 'Test fixture approval'); assert.equal((await runStage(f.root, f.config, stage)).success, true); }
  const outputs = f.units.map(u => safePath(f.root, u.target)), sources = f.units.map(u => safePath(f.root, u.source));
  const { counts, value: report } = readsOf([...outputs, ...sources], () => migrationStatus(f.root));
  assert.deepEqual(counts, [2, 2, 2, 1, 1, 1], 'outputs: hash and markers; sources: once');
  assert.equal(report.done, 3);
  assert.deepEqual(report.phases.filter(p => ['05', '05b', '05c'].includes(p.id)).map(p => p.status), ['validated', 'validated', 'validated']);
  // An output edited after that status: the next one sees it.
  atomicWrite(outputs[0], `${fs.readFileSync(outputs[0], 'utf8')}// edited after parity\n`);
  const after = migrationStatus(f.root);
  assert.equal(after.done, 2);
  assert.equal(after.units.find(u => u.target === f.units[0].target).status, 'stopped');
  assert.deepEqual(after.phases.filter(p => ['05', '05b', '05c'].includes(p.id)).map(p => p.status), ['pending', 'pending', 'pending']);
});

test('a translation approval for named files reads the manifest once, not once per file', async t => {
  const f = prepare(t, { count: 3 });
  await runStage(f.root, f.config, 'judge');
  const targets = f.units.slice(0, 2).map(u => u.target);
  approve(f.root, f.config, 'translation', 'Test fixture batch approval', { targets });
  const context = contextHash(f.root, f.config), manifest = safePath(f.root, 'migration/manifest.tsv');
  const gate = once([manifest], 'translation gate', () => requireGate(f.root, f.config, 'translation', context));
  assert.deepEqual(gate.targets, targets);
  // A target no longer in the manifest still makes the approval invalid.
  atomicWrite(manifest, `source\ttarget\n${f.units.filter(u => u.target !== targets[1]).map(u => `${u.source}\t${u.target}`).join('\n')}\n`);
  assert.throws(() => requireGate(f.root, f.config, 'translation', contextHash(f.root, f.config)), /Invalid translation approval scope/);
});
