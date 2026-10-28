// SPDX-License-Identifier: Apache-2.0
// Auto phase mode: relaxed mode without the person, so Copilot CLI autopilot
// can drive the workflow. Gate commands run unasked and every record it makes
// is marked auto. Normal and relaxed mode must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite } from '../lib/core.mjs';
import { approve, translate } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { requirePhase } from '../lib/phases.mjs';
import { migrationStatus, statusChecklist, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { setPreferences, readPreferences, autoModeFile } from '../lib/preferences.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { humanGate, interactiveDecision, requireGuardrails, readGuardrails } from '../lib/guardrails.mjs';
import { initRunSettings, applyRunSettings, runSettingsFile } from '../lib/run-settings.mjs';
import { setRoleModels } from '../lib/models.mjs';
import { kitRoot } from '../scripts/install.mjs';

function fixture(t, { mode, guardrails = true } = {}) {
  const f = prepare(t);
  Object.assign(f.config, { phasePolicy: 'strict' });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  if (guardrails) fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(f.root, 'migration/guardrails.json'));
  atomicWrite(safePath(f.root, 'migration/judge-report.md'), 'Reviewed public arithmetic scenarios, commands, normalization and limitations.');
  atomicWrite(safePath(f.root, 'migration/depmap/report.md'), 'Audited parser coverage, isolated files and source dependency map.');
  atomicWrite(safePath(f.root, 'migration/gap-report.md'), 'Audited floor division, Unicode semantics and inventory coverage.');
  phaseCommand(f.root, f.config, 'init');
  if (mode) setPreferences(f.root, { phaseMode: mode });
  return f;
}
const complete = (f, id) => { phaseCommand(f.root, f.config, 'start', id); return phaseCommand(f.root, f.config, 'complete', id, { note: `Reviewed fixture phase ${id} evidence` }); };
const kit = 'node migration-kit/scripts/run_migration.mjs';
const decide = (f, command) => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: f.root }, f.root);
const gateCommands = [`${kit} approve translation --note "Reviewed"`, `${kit} approve translation --complete-phase 03 --note "Reviewed"`,
  `${kit} phase complete 02 --note "Reviewed"`, `${kit} phase waive 03 --note "shape first"`, `${kit} build-loop --note "go"`,
  `${kit} guardrails install`, `${kit} approve build --note "Reviewed"`];
const stillAsked = [`${kit} models set --role all --model gpt-5`, `${kit} settings apply`, `${kit} sessions prune`, `${kit} pilot prepare --note x`,
  `${kit} source-spec init --apply`, 'node -e "import(\'./migration-kit/scripts/run_migration.mjs\')" approve'];

test('normal and relaxed mode keep every gate asking; auto mode is never recorded for them', t => {
  for (const mode of [undefined, 'normal', 'relaxed']) {
    const f = fixture(t, { mode });
    for (const command of [...gateCommands, ...stillAsked]) assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
    assert.equal(fs.existsSync(safePath(f.root, autoModeFile)), false);
    complete(f, '00');
    assert.equal(readJSON(safePath(f.root, 'migration/phases/00.json')).auto, undefined);
    const status = migrationStatus(f.root);
    assert.equal(status.autoMode, undefined);
    assert.notEqual(status.workflow.mode, 'auto');
    // The gate message keeps asking the person.
    try { requirePhase(f.root, f.config, '02'); assert.fail('gate expected'); }
    catch (e) { assert.doesNotMatch(e.message, /\(auto\)|without asking/); }
    // Without auto mode a missing guardrails file still stops, as before.
    fs.rmSync(safePath(f.root, 'migration/guardrails.json'));
    assert.throws(() => requireGuardrails(f.root, '03'), /requires human-installed command guardrails/);
    assert.equal(readGuardrails(f.root), null);
  }
});

test('auto mode lets the gate commands run unasked and keeps the rest asking', t => {
  const f = fixture(t, { mode: 'auto' });
  for (const command of gateCommands) assert.equal(decide(f, command), null, command);
  for (const command of stillAsked) assert.equal(decide(f, command)?.decision, 'ask', command);
  // The guardrails file itself is still never written directly.
  assert.equal(decide(f, 'echo {} > migration/guardrails.json')?.decision, 'deny');
});

test('switching auto mode on is always the person\'s act', t => {
  assert.equal(humanGate(`${kit} preferences --phase-mode auto`), 'preferences --phase-mode auto');
  assert.equal(humanGate(`${kit} preferences --phase-mode relaxed`), null);
  assert.equal(humanGate(`${kit} preferences --phase-mode normal`), null);
  assert.equal(humanGate(`${kit} preferences --language ja`), null);
  for (const mode of [undefined, 'relaxed', 'auto']) {
    const f = fixture(t, { mode });
    const decision = decide(f, `${kit} preferences --phase-mode auto`);
    assert.equal(decision?.decision, 'ask', String(mode));
    assert.match(decision.reason, /rule 3/);
    // Leaving auto mode needs nobody's confirmation.
    assert.equal(decide(f, `${kit} preferences --phase-mode normal`), null);
  }
});

test('auto mode records the deviation and marks receipts, gates and waivers auto', async t => {
  const f = fixture(t, { mode: 'auto' });
  const deviation = readJSON(safePath(f.root, autoModeFile));
  assert.match(deviation.deviation, /rule 3/);
  assert.ok(deviation.enabledAt);
  // Choosing auto again does not move the start time.
  setPreferences(f.root, { phaseMode: 'auto' });
  assert.equal(readJSON(safePath(f.root, autoModeFile)).enabledAt, deviation.enabledAt);
  let error;
  try { phaseCommand(f.root, f.config, 'start', '04'); } catch (e) { error = e; }
  assert.match(error.message, /Relaxed mode \(auto\): if the phase's own work cannot supply it, proceed without asking.*phase waive 03 --note TEXT/s);
  assert.equal(error.waivablePhase, '03');
  // The failure guidance still offers the waiver, before pause, as in relaxed mode.
  const g = failureGuidance(error, { root: f.root });
  assert.ok(g.options.some(o => o.id === 'waive'));
  assert.ok(!g.options.some(o => o.id === 'switch-relaxed'));
  complete(f, '00');
  assert.equal(readJSON(safePath(f.root, 'migration/phases/00.json')).auto, true);
  const w = phaseCommand(f.root, f.config, 'waive', '03', { note: 'Autopilot: shape first' });
  assert.equal(w.waived, true);
  assert.equal(readJSON(safePath(f.root, 'migration/phases/waivers/03.json')).auto, true);
  phaseCommand(f.root, f.config, 'start', '04');
  approve(f.root, f.config, 'translation', 'Autopilot');
  assert.equal(readJSON(safePath(f.root, 'migration/gates/translation.json')).auto, true);
  await translate(f.root, f.config, fake);
  const status = migrationStatus(f.root);
  assert.equal(status.workflow.mode, 'auto');
  assert.equal(status.autoMode.active, true);
  assert.equal(status.autoMode.enabledAt, deviation.enabledAt);
  assert.deepEqual(status.autoMode.records, ['phase 00', 'approve translation']);
  assert.equal(status.waivers[0].auto, true);
  assert.match(statusChecklist(status, 'ja'), /00 事前調査【自動・人の確認なし】/);
  const md = statusMarkdown(status, 'ja');
  assert.match(md, /自動モード：オン/);
  assert.match(md, /自動モードが人の確認なしで記録したもの: phase 00, approve translation/);
  assert.match(md, /- 03: Autopilot: shape first.*\[自動\]/);
  const fast = statusSnapshot(f.root);
  assert.equal(fast.workflow.mode, 'auto');
  assert.equal(fast.waivers[0].auto, true);
  assert.deepEqual(fast.autoMode.records, ['phase 00', 'approve translation']);
  // Back to normal: the mode line goes, the auto records stay visible until redone.
  setPreferences(f.root, { phaseMode: 'normal' });
  const after = migrationStatus(f.root);
  assert.equal(after.autoMode.active, false);
  assert.deepEqual(after.autoMode.records, ['phase 00', 'approve translation']);
  assert.doesNotMatch(statusMarkdown(after, 'en'), /Auto mode: on/);
  complete(f, '00');
  assert.equal(readJSON(safePath(f.root, 'migration/phases/00.json')).auto, undefined, 'a completion by the person replaces the auto receipt');
  assert.deepEqual(migrationStatus(f.root).autoMode.records, ['approve translation']);
});

test('auto mode installs the template guardrails when none exist; an existing file is never replaced', t => {
  const f = fixture(t, { mode: 'auto', guardrails: false });
  const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/guardrails.json'), 'utf8'));
  const policy = requireGuardrails(f.root, '03');
  assert.deepEqual(policy.denyCommands.map(r => r.join(' ')), template.denyCommands);
  const written = readJSON(safePath(f.root, 'migration/guardrails.json'));
  assert.equal(written.installedBy, 'auto-mode');
  // A file the person installed stays as it is, even an invalid one.
  writeJSON(safePath(f.root, 'migration/guardrails.json'), { schemaVersion: 1, denyCommands: ['git push'] });
  assert.deepEqual(requireGuardrails(f.root, '03').denyCommands, [['git', 'push']]);
  writeJSON(safePath(f.root, 'migration/guardrails.json'), { schemaVersion: 2 });
  assert.throws(() => requireGuardrails(f.root, '03'), /guardrails are invalid/);
});

test('auto mode is offered as the third choice of the phase-mode question and applies from the run settings', t => {
  const f = prepare(t);
  assert.throws(() => setPreferences(f.root, { phaseMode: 'autopilot' }), /normal, relaxed or auto/);
  writeJSON(safePath(f.root, 'migration/preferences.json'), { schemaVersion: 1, userLanguage: 'en', phaseMode: 'yes' });
  assert.throws(() => readPreferences(f.root), /normal, relaxed or auto/);
  writeJSON(safePath(f.root, 'migration/preferences.json'), { schemaVersion: 1, userLanguage: 'en' });
  const catalog = [{ id: 'm', name: 'M', state: 'enabled', efforts: [], contexts: [] }];
  setRoleModels(f.root, catalog, { role: 'all', model: 'm' });
  const init = initRunSettings(f.root, catalog, { source: 'Python', target: 'JavaScript' });
  assert.match(init.next, /three choices: normal .*relaxed .*auto .*preferences --phase-mode normal\|relaxed\|auto/s);
  const file = safePath(f.root, runSettingsFile);
  const s = readJSON(file);
  assert.match(s._help.phaseMode, /auto is relaxed without asking/);
  Object.assign(s, { reportLanguage: 'en', originalRuntime: 'available', phaseMode: 'auto' });
  writeJSON(file, s);
  const applied = applyRunSettings(f.root, catalog);
  assert.equal(applied.applied, true, applied.errors?.join('\n'));
  assert.equal(readPreferences(f.root).phaseMode, 'auto');
  assert.ok(fs.existsSync(safePath(f.root, autoModeFile)), 'applying auto from the file records the deviation too');
  // settings apply itself still asks, so autopilot cannot switch auto on through the file.
  assert.equal(humanGate(`${kit} settings apply`), 'settings apply');
});
