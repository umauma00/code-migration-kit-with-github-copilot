// SPDX-License-Identifier: Apache-2.0
// Relaxed phase mode: a missing prerequisite is a warning the person answers
// (fix it, or proceed with a recorded waiver). Normal mode must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, loadConfig } from '../lib/core.mjs';
import { approve, runStage, translate, currentRecord } from '../lib/pipeline.mjs';
import { contextHash } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { currentPhase, phaseWaiver, requirePhase } from '../lib/phases.mjs';
import { migrationStatus, statusChecklist, statusTodo, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { setPreferences, readPreferences } from '../lib/preferences.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';
import { initRunSettings, applyRunSettings, runSettingsState, runSettingsFile } from '../lib/run-settings.mjs';
import { setRoleModels } from '../lib/models.mjs';
import { kitRoot } from '../scripts/install.mjs';

function fixture(t, { mode } = {}) {
  const f = prepare(t);
  Object.assign(f.config, { phasePolicy: 'strict' });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(f.root, 'migration/guardrails.json'));
  atomicWrite(safePath(f.root, 'migration/judge-report.md'), 'Reviewed public arithmetic scenarios, commands, normalization and limitations.');
  atomicWrite(safePath(f.root, 'migration/depmap/report.md'), 'Audited parser coverage, isolated files and source dependency map.');
  atomicWrite(safePath(f.root, 'migration/gap-report.md'), 'Audited floor division, Unicode semantics and inventory coverage.');
  phaseCommand(f.root, f.config, 'init');
  if (mode) setPreferences(f.root, { phaseMode: mode });
  return f;
}
const complete = (f, id) => { phaseCommand(f.root, f.config, 'start', id); return phaseCommand(f.root, f.config, 'complete', id, { note: `Reviewed fixture phase ${id} evidence` }); };
const waive = (f, id, note = `Proceed without ${id} for a quick shape`) => phaseCommand(f.root, f.config, 'waive', id, { note });
const waiverFile = (f, id) => safePath(f.root, `migration/phases/waivers/${id}.json`);

test('normal mode ignores waivers: the same gates, the same messages, and phase waive is refused', async t => {
  const f = fixture(t);
  // A waiver left on disk (copied in, or from relaxed mode) changes nothing.
  writeJSON(waiverFile(f, '03'), { schemaVersion: 1, phase: '03', note: 'left over', waivedAt: 'x' });
  for (const prefs of [undefined, 'normal']) {
    if (prefs) setPreferences(f.root, { phaseMode: prefs });
    assert.equal(phaseWaiver(f.root, '03'), false);
    assert.throws(() => phaseCommand(f.root, f.config, 'start', '04'), e => /Phase 03 is not reviewed/.test(e.message) && !/Relaxed mode/.test(e.message) && e.waivablePhase === undefined);
    assert.throws(() => approve(f.root, f.config, 'translation', 'Try skipping'), e => /Phase 03/.test(e.message) && !/Relaxed mode/.test(e.message));
    await assert.rejects(runStage(f.root, f.config, 'judge'), e => /Phase 02/.test(e.message) && !/Relaxed mode/.test(e.message));
    assert.throws(() => waive(f, '00'), /available only in relaxed mode/);
    const status = migrationStatus(f.root);
    assert.equal(status.workflow.next, '00');
    assert.equal(status.waivers, undefined);
    assert.equal(status.workflow.mode, undefined);
    assert.ok(!status.workflow.phases.some(p => p.waived));
  }
  // The failure guidance offers no "proceed" choice outside relaxed mode.
  try { requirePhase(f.root, f.config, '02'); assert.fail('gate expected'); }
  catch (e) {
    const g = failureGuidance(e, { root: f.root });
    assert.ok(!g.options.some(o => o.id === 'waive'));
    // Normal mode offers switching (never recommended), right before pause.
    assert.deepEqual(g.options.slice(-2).map(o => o.id), ['switch-relaxed', 'pause']);
    assert.match(g.options.at(-2).command, /preferences --phase-mode relaxed$/);
    assert.equal(g.options[0].recommended, true);
    assert.notEqual(g.options[0].id, 'switch-relaxed');
  }
  // Other failures never offer it.
  assert.ok(!failureGuidance('Malformed tool arguments', { root: f.root }).options.some(o => o.id === 'switch-relaxed'));
});

test('relaxed mode warns, names the phase to waive, and offers fix first, proceed second', t => {
  const f = fixture(t, { mode: 'relaxed' });
  let error;
  try { phaseCommand(f.root, f.config, 'start', '04'); } catch (e) { error = e; }
  assert.match(error.message, /Phase 03 is not reviewed.*Relaxed mode: ask the person whether to fix this first or proceed.*phase waive 03 --note TEXT/s);
  assert.equal(error.waivablePhase, '03');
  const g = failureGuidance(error, { root: f.root, language: 'ja' });
  assert.equal(g.id, 'phase-order');
  assert.notEqual(g.options[0].id, 'waive', 'fixing stays the recommendation');
  const proceed = g.options.find(o => o.id === 'waive');
  assert.match(proceed.label, /工程 03 を終えずに、このまま先へ進む/);
  assert.match(proceed.command, /phase waive 03 --note "/);
  assert.equal(g.options.at(-1).id, 'pause');
  assert.throws(() => waive(f, '06'), /cannot be waived/);
  assert.throws(() => phaseCommand(f.root, f.config, 'waive', '03', { note: ' ' }), /requires --note/);
});

test('relaxed mode: waive, proceed to translation and build, and every waiver stays visible as unfinished', async t => {
  const f = fixture(t, { mode: 'relaxed' });
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  const w = waive(f, '03', 'Want the overall shape before the stress test');
  assert.equal(w.waived, true);
  assert.match(w.unmet, /Phase 02 is not reviewed/, 'what was missing is recorded with the reason');
  assert.doesNotMatch(w.unmet, /Relaxed mode/);
  // 04 starts on the waiver (no judge record, no stress report).
  phaseCommand(f.root, f.config, 'start', '04');
  approve(f.root, f.config, 'translation', 'Shape only; 03 waived');
  await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Shape build');
  const build = await runStage(f.root, f.config, 'build');
  assert.deepEqual(build.predecessor, { stage: 'judge', waivedPhase: '03', waiverHash: phaseWaiver(f.root, '03').hash });
  assert.ok(currentRecord(f.root, f.config, 'build', contextHash(f.root, f.config)));
  const status = migrationStatus(f.root);
  assert.equal(status.workflow.mode, 'relaxed');
  assert.equal(status.waivers.length, 1);
  assert.equal(status.waivers[0].phase, '03');
  assert.equal(status.workflow.phases.find(p => p.id === '03').complete, false, 'a waived phase is never counted done');
  assert.equal(status.workflow.phases.find(p => p.id === '03').waived, true);
  assert.equal(status.workflow.next, '00', 'earlier unfinished phases are still next until waived or done');
  assert.match(statusChecklist(status, 'ja'), /03 事前試行【見送り】/);
  assert.match(statusTodo(status, 'en').todoList.find(i => i.title.startsWith('03')).title, /\[waived\]/);
  assert.match(statusMarkdown(status, 'ja'), /見送った工程（緩和モード。未完了のまま）:\n- 03: Want the overall shape/);
  const fast = statusSnapshot(f.root);
  assert.equal(fast.workflow.phases.find(p => p.id === '03').waived, true);
});

test('records made on a waiver are checked again once the phase is done for real or relaxed mode ends', async t => {
  const f = fixture(t, { mode: 'relaxed' });
  // Preparation receipts chain on a waiver: 01 recorded after waiving 00b.
  complete(f, '00');
  waive(f, '00b');
  complete(f, '01');
  assert.ok(currentPhase(f.root, f.config, '01'));
  assert.equal(readJSON(safePath(f.root, 'migration/phases/01.json')).predecessorHash, phaseWaiver(f.root, '00b').hash);
  assert.equal(migrationStatus(f.root).workflow.next, '02');
  // Back to normal: the waiver no longer stands in, so 01 is unfinished again.
  setPreferences(f.root, { phaseMode: 'normal' });
  assert.equal(currentPhase(f.root, f.config, '01'), false);
  assert.equal(migrationStatus(f.root).workflow.next, '00b');
  setPreferences(f.root, { phaseMode: 'relaxed' });
  assert.ok(currentPhase(f.root, f.config, '01'), 'switching back restores it: nothing was deleted');
  // Completing the waived phase for real lifts the waiver; 01 is recorded again.
  complete(f, '00b');
  assert.equal(migrationStatus(f.root).waivers.length, 0);
  assert.equal(currentPhase(f.root, f.config, '01'), false, '01 was recorded on the waiver, not on the reviewed 00b');
  complete(f, '01');
  assert.ok(currentPhase(f.root, f.config, '01'));
  // A runner record made on a waiver also runs again once the real one exists.
  complete(f, '02');
  waive(f, '03');
  phaseCommand(f.root, f.config, 'start', '04');
  approve(f.root, f.config, 'translation', 'Shape only');
  await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Shape build');
  await runStage(f.root, f.config, 'build');
  const context = contextHash(f.root, f.config);
  assert.ok(currentRecord(f.root, f.config, 'build', context));
  setPreferences(f.root, { phaseMode: 'normal' });
  assert.equal(currentRecord(f.root, f.config, 'build', context), false, 'without relaxed mode the waived judge no longer stands in');
  setPreferences(f.root, { phaseMode: 'relaxed' });
  // A waiver rewritten after the build no longer vouches for it.
  writeJSON(waiverFile(f, '03'), { ...readJSON(waiverFile(f, '03')), note: 'rewritten' });
  assert.equal(currentRecord(f.root, f.config, 'build', context), false);
  await runStage(f.root, f.config, 'judge');
  assert.equal(currentRecord(f.root, f.config, 'build', contextHash(f.root, f.config)), false);
});

test('waiving 04 lets the build run before every unit is reviewed; the units stay unfinished', async t => {
  const f = fixture(t, { mode: 'relaxed' });
  for (const id of ['00', '00b', '01', '02']) complete(f, id);
  await runStage(f.root, f.config, 'judge');
  complete(f, '03');
  approve(f.root, f.config, 'translation', 'Reviewed preparation');
  assert.throws(() => approve(f.root, f.config, 'build', 'Too early'), e => /All translation units must have current reviewed receipts.*phase waive 04/s.test(e.message));
  waive(f, '04', 'Build what exists to see the errors');
  approve(f.root, f.config, 'build', 'Shape build on unreviewed units');
  await runStage(f.root, f.config, 'build');
  const status = migrationStatus(f.root);
  assert.equal(status.workflow.phases.find(p => p.id === '04').complete, false);
  assert.equal(status.workflow.next, '05b', 'build ran, 04 is waived');
  assert.ok(status.done < status.total || status.total === 0);
  // Normal mode would refuse the same approval.
  setPreferences(f.root, { phaseMode: 'normal' });
  assert.throws(() => approve(f.root, f.config, 'build', 'Again'), e => /All translation units must have current reviewed receipts$/.test(e.message));
});

test('phase waive is a human act: the hook asks, and an unreadable form still asks', t => {
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs phase waive 03 --note "shape first"'), 'phase waive 03');
  assert.equal(humanGate('node -e "import(\'./migration-kit/scripts/run_migration.mjs\')" waive'), 'unrecognized runner command');
  const f = prepare(t);
  const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'node migration-kit/scripts/run_migration.mjs phase waive 03 --note "shape first"' }, cwd: f.root }, f.root);
  assert.equal(decision?.decision, 'ask');
  assert.match(decision.reason, /phase waive 03.*relaxed mode/s);
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs preferences --phase-mode relaxed'), null, 'choosing the mode is the answer to the first question, not a gate');
});

test('run settings carry the phase mode; files written before it existed still apply unchanged', t => {
  const f = prepare(t);
  const catalog = [{ id: 'm', name: 'M', state: 'enabled', efforts: [], contexts: [] }];
  setRoleModels(f.root, catalog, { role: 'all', model: 'm' });
  initRunSettings(f.root, catalog, { source: 'Python', target: 'JavaScript' });
  const file = safePath(f.root, runSettingsFile);
  const fill = value => { const s = readJSON(file); Object.assign(s, { reportLanguage: 'en', originalRuntime: 'available' }, value); writeJSON(file, s); };
  assert.equal(readJSON(file).phaseMode, 'FILL_IN');
  assert.deepEqual(readJSON(file)._choices.phaseMode, ['normal', 'relaxed']);
  fill({ phaseMode: 'loose' });
  assert.match(applyRunSettings(f.root, catalog).errors.join('\n'), /phaseMode: must be one of normal, relaxed, not "loose"/);
  fill({ phaseMode: 'relaxed' });
  const applied = applyRunSettings(f.root, catalog);
  assert.equal(applied.applied, true, applied.errors?.join('\n'));
  assert.ok(applied.changed.includes('phaseMode'));
  assert.equal(applied.note, undefined, 'the mode is not part of the reviewed configuration');
  assert.equal(readPreferences(f.root).phaseMode, 'relaxed');
  assert.equal(runSettingsState(f.root, loadConfig(f.root)).state, 'applied');
  // A file without the key (written before 0.12.0) applies without touching the mode.
  const old = readJSON(file); delete old.phaseMode; writeJSON(file, old);
  const again = applyRunSettings(f.root, catalog);
  assert.equal(again.applied, true, again.errors?.join('\n'));
  assert.ok(!again.changed.includes('phaseMode'));
  assert.equal(readPreferences(f.root).phaseMode, 'relaxed');
  assert.equal(runSettingsState(f.root, loadConfig(f.root)).state, 'applied');
  // settings init adds it back in place, filled from the preference.
  initRunSettings(f.root, catalog);
  const keys = Object.keys(readJSON(file));
  assert.equal(readJSON(file).phaseMode, 'relaxed');
  assert.equal(keys.indexOf('phaseMode'), keys.indexOf('originalRuntime') + 1);
});
