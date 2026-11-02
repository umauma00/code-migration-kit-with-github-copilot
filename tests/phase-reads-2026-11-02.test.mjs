// SPDX-License-Identifier: Apache-2.0
// 0.42.1: on 2026-11-02 (Windows, source-as-spec, auto mode) a kit update from
// 0.40.0 made phase 00b's record out of date (its judge fingerprint format
// changed in 0.40.1), so 00b to 03 were recorded again. Every check of every
// phase command hashed the whole source tree again (about 6 s per pass on
// that PC). In this source-as-spec fixture phase next and status read a
// source file 20 times each, phase check 00b,01,02 43 times, phase complete
// 00b,01,02 61 times and phase complete 03 26 times. After parity, one status
// read each translated file 33 times. Each command now reads each source file
// once and each output twice (its hash and its markers); a small file read
// for its text (a report, the RULEBOOK, the manifest, the judge plan) may
// still be read again. Nothing is kept between commands.
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
import { currentPhase, requirePhase, phaseWaiver, phaseStaleness, earliestStale, staleText, inputRead, readContext } from '../lib/phases.mjs';
import { judgeInputHash } from '../lib/judge.mjs';
import { runStage, approve, translate, requireGate } from '../lib/pipeline.mjs';
import { installGuardrails } from '../lib/guardrails.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { initSourceSpec } from '../lib/source-spec.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { preparePilot } from '../lib/pilot.mjs';

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
// fn reads each given file exactly once (at most once with atMost, for a
// command that may not need it); returns what fn returned.
function once(files, label, fn, { atMost = false } = {}) {
  const { counts, value } = readsOf(files, fn);
  counts.forEach((n, i) => assert.ok(atMost ? n <= 1 : n === 1, `${label}: ${path.basename(files[i])} read ${n} times`));
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
  phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User reviewed the specification package' });
  assert.equal((await runStage(root, config, 'judge')).success, true);
  return { root, config, sources: ['math_ops', 'text_ops', 'main'].map(n => safePath(root, `src/${n}.py`)) };
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
  // Starting a phase of the package (source-as-spec: it waits only for 00).
  once(sources, 'phase start 01', () => phaseCommand(root, config, 'start', '01'));
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
  const { counts, value: report } = readsOf([...outputs, ...sources, safePath(f.root, 'migration/manifest.tsv')], () => migrationStatus(f.root));
  assert.deepEqual(counts, [2, 2, 2, 1, 1, 1, 2], 'outputs: hash and markers; sources: once; the manifest: hash and one parse');
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

test('in a strict project a translation approval for more named files does not read the manifest more often', async t => {
  const f = await reviewedPreparation(t);
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for a regression test only' });
  await runStage(f.root, f.config, 'judge');
  atomicWrite(safePath(f.root, 'migration/stress-test/report.md'), 'Disposable stress-test fixture; not an actual stress test.\n');
  installGuardrails(f.root, kitRoot, { waiver: 'Test fixture: disposable sandbox, no real commands' });
  phaseCommand(f.root, f.config, 'complete', '03', { note: 'Synthetic stress-test review for a regression test only' });
  const manifest = safePath(f.root, 'migration/manifest.tsv'), targets = f.units.map(u => u.target);
  // The gate as translate checks it, without a read of its own caller.
  const reads = named => {
    approve(f.root, f.config, 'translation', 'Test fixture batch approval', { targets: named });
    const { counts, value } = readsOf([manifest], () => requireGate(f.root, f.config, 'translation', contextHash(f.root, f.config)));
    assert.deepEqual(value.targets, named);
    return counts[0];
  };
  const one = reads(targets.slice(0, 1)), all = reads(targets);
  assert.equal(all, one, `manifest read ${one} times for one named file and ${all} times for ${targets.length}`);
  // In one read (a status or phase command) whose context is known, the
  // manifest was hashed and parsed with the context: the gate, its chain of
  // phase records and the check of the named files read it no more.
  const read = inputRead(), context = readContext(f.root, f.config, read);
  assert.equal(readsOf([manifest], () => requireGate(f.root, f.config, 'translation', context, read)).counts[0], 0);
});

// Phases 00 to 02 of a strict runtime project recorded, judge run.
async function reviewedPreparation(t) {
  const f = prepare(t, { realCommands: true, count: 3 });
  f.config.phasePolicy = 'strict'; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  for (const p of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, p), 'Disposable preparation fixture; not actual AI review or human signoff.\n');
  return { ...f, sources: f.units.map(u => safePath(f.root, u.source)) };
}

for (const mode of ['relaxed', 'auto']) test(`${mode} mode: one command records a waived phase, retires its waiver and binds the next records to the new receipt`, async t => {
  const f = await reviewedPreparation(t), { root, config, sources } = f;
  setPreferences(root, { phaseMode: mode });
  phaseCommand(root, config, 'complete', '00', { note: 'Fixture feasibility reviewed' });
  // 00b waived; 01 and 02 recorded on that waiver.
  once(sources, 'phase waive 00b', () => phaseCommand(root, config, 'waive', '00b', { note: 'The person chose to look at the dependency map first' }));
  const waiver = phaseWaiver(root, '00b');
  assert.ok(waiver);
  phaseCommand(root, config, 'complete', '01', { note: 'Fixture map reviewed' });
  phaseCommand(root, config, 'complete', '02', { note: 'Fixture rules reviewed' });
  assert.equal(readJSON(safePath(root, 'migration/phases/01.json')).predecessorHash, waiver.hash);
  // The package recorded for real in one command: 00b retires its waiver
  // in the middle, and 01 and 02 name the receipts written before them.
  once(sources, 'phase complete 00b,01,02', () => phaseCommand(root, config, 'complete', '00b,01,02', { note: 'The person reviewed the judge setup after all' }));
  assert.equal(phaseWaiver(root, '00b'), false);
  assert.ok(fs.readdirSync(safePath(root, 'migration/phases/waivers/retired')).some(name => name.startsWith('00b-')));
  chainHolds(root, config, ['00', '00b', '01', '02']);
  // A waiver of a later phase, read once too.
  once(sources, 'phase waive 03', () => phaseCommand(root, config, 'waive', '03', { note: 'The person chose to skip the stress test for this fixture' }));
  assert.match(phaseWaiver(root, '03').unmet, /Run judge successfully/);
});

test('a pilot\'s status reads each production source and each pilot file once', async t => {
  const f = await reviewedPreparation(t);
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for a regression test only' });
  await runStage(f.root, f.config, 'judge');
  const child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Disposable regression pilot' });
  const files = [safePath(f.root, 'src/math_ops.py'), path.join(child, 'src/math_ops.py')], config = loadConfig(child);
  assert.equal(once(files, 'pilot status', () => migrationStatus(child)).ok, true);
  assert.equal((await runStage(child, config, 'judge')).success, true);
  approve(child, config, 'translation', 'Disposable regression pilot approval');
  const report = once(files, 'approved pilot status', () => migrationStatus(child));
  assert.equal(report.ok, true);
  assert.equal(report.workflow.policy, 'isolated-pilot');
  assert.deepEqual(report.blockers, []);
  // The parent changed after that status: the next one says so for every gate.
  atomicWrite(safePath(f.root, 'migration/judge-report.md'), 'Disposable preparation fixture; a note added later.\n');
  const stale = migrationStatus(child);
  assert.match(stale.blockers.map(b => b.reason).join('\n'), /Pilot parent phase 02 is out of date/);
  assert.equal(stale.approvedTargets.length, 0);
});

// With "verificationRoots": ["migration"] the judge inputs included the phase
// records, so a record went out of date as soon as it was written (0.42.0
// refused the next phase of a package; phase next sent 00b back for ever).
test('a verification root or input over the records the kit writes is refused when the config is read', async t => {
  const f = prepare(t, { count: 1 }), file = safePath(f.root, 'migration/config.json'), raw = readJSON(file);
  const load = change => { writeJSON(file, { ...raw, ...change }); return loadConfig(f.root); };
  for (const roots of [['migration'], ['migration/phases'], ['migration/results/judge'], ['migration/rulebook-history'], ['migration/pilots'], ['tests', 'migration']]) {
    assert.throws(() => load({ verificationRoots: roots }), /^Error: verificationRoots overlaps the kit's phase and run records: migration/, JSON.stringify(roots));
  }
  assert.throws(() => load({ verificationRoots: ['.git'] }), /^Error: verificationRoots overlaps the kit's phase and run records: \.git/);
  assert.throws(() => load({ verificationInputs: ['migration/rulebook-history/RULEBOOK-1.md'] }), /verificationInputs\/designInputs overlaps outputs or runtime state/);
  assert.throws(() => load({ designInputs: ['migration/pilots/design.md'] }), /verificationInputs\/designInputs overlaps outputs or runtime state/);
  // status names the entry to correct.
  writeJSON(file, { ...raw, verificationRoots: ['migration'] });
  const report = migrationStatus(f.root);
  assert.equal(report.ok, false);
  assert.match(report.blockers.map(b => b.reason).join('\n'), /verificationRoots overlaps the kit's phase and run records: migration \(/);
  // The source-as-spec folder and a folder of the project's own under migration are kept.
  assert.deepEqual(load({ verificationRoots: ['migration/source-spec'] }).verificationRoots, ['migration/source-spec']);
  assert.deepEqual(load({ verificationRoots: ['tests', 'migration/judge'] }).verificationRoots, ['tests', 'migration/judge']);
  assert.deepEqual(load({}).verificationRoots, raw.verificationRoots);
});

test('a phase check given no read, null or an empty one makes its own and answers as before', async t => {
  const f = await reviewedPreparation(t), { root, config, sources } = f;
  for (const id of ['00', '00b', '01', '02']) phaseCommand(root, config, 'complete', id, { note: 'Synthetic preparation review for a regression test only' });
  for (const read of [undefined, null, {}]) for (const id of ['00', '02']) {
    assert.ok(currentPhase(root, config, id, read), `${id} with ${JSON.stringify(read)}`);
    assert.doesNotThrow(() => requirePhase(root, config, id, read));
    assert.equal(phaseStaleness(root, config, id, read), null);
    assert.equal(staleText(root, config, id, read), null);
  }
  // A source changed: every form gives the same answer and explanation.
  atomicWrite(sources[0], `${fs.readFileSync(sources[0], 'utf8')}# changed\n`);
  const stale = phaseStaleness(root, config, '02'), text = staleText(root, config, '02'), earliest = earliestStale(root, config, ['00', '00b', '01', '02']);
  assert.ok(stale && text && earliest);
  for (const read of [null, {}, inputRead()]) {
    assert.equal(currentPhase(root, config, '02', read), false);
    assert.deepEqual(phaseStaleness(root, config, '02', read), stale);
    assert.equal(staleText(root, config, '02', read), text);
    assert.deepEqual(earliestStale(root, config, ['00', '00b', '01', '02'], read), earliest);
    assert.throws(() => requirePhase(root, config, '02', read), /out of date/);
  }
});
