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
import { initRunSettings, applyRunSettings, runSettingsFile, runSettingsHelpFile } from '../lib/run-settings.mjs';
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
  `${kit} approve build --note "Reviewed"`, `${kit} pilot prepare --note x`, `${kit} source-spec init --apply`];
// Recording settings the person chose runs unasked in every mode, as its own command.
const settingsCommands = [`${kit} models set --role all --model gpt-5`, `${kit} settings apply`];
const stillAsked = [`${kit} sessions prune`, 'node -e "import(\'./migration-kit/scripts/run_migration.mjs\')" approve', `${kit} guardrails install`,
  `${kit} preferences --phase-mode auto`, `${kit} settings apply && ${kit} approve translation --note x`, `${kit} models set --role all --model gpt-5; ${kit} sessions prune`];

test('normal and relaxed mode keep the gates asking (settings apply unasked); auto mode is never recorded for them', t => {
  for (const mode of [undefined, 'normal', 'relaxed']) {
    const f = fixture(t, { mode });
    fs.rmSync(safePath(f.root, 'migration/guardrails.json'));
    for (const command of [...gateCommands, ...stillAsked]) assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
    for (const command of settingsCommands) assert.equal(decide(f, command), null, `${mode}: ${command}`);
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
    assert.throws(() => requireGuardrails(f.root, '03'), /requires human-installed command guardrails/);
    assert.equal(readGuardrails(f.root), null);
  }
});

test('auto mode lets the gate commands run unasked and keeps the rest asking', t => {
  const f = fixture(t, { mode: 'auto' });
  for (const command of [...gateCommands, ...settingsCommands]) assert.equal(decide(f, command), null, command);
  for (const command of stillAsked) assert.equal(decide(f, command)?.decision, 'ask', command);
  // guardrails install runs unasked only as the plain template install while no file exists.
  fs.rmSync(safePath(f.root, 'migration/guardrails.json'));
  assert.equal(decide(f, `${kit} guardrails install`), null);
  for (const option of ['--replace', '--waiver "shape first"', '--remove "git push"', '--add "rm -rf"', '--deny "git push"']) assert.equal(decide(f, `${kit} guardrails install ${option}`)?.decision, 'ask', option);
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
  assert.deepEqual(status.autoMode.records, ['phase 00', 'approve translation', 'waive 03']);
  assert.equal(status.waivers[0].auto, true);
  assert.match(statusChecklist(status, 'ja'), /00 事前調査【自動・人の確認なし】/);
  const md = statusMarkdown(status, 'ja');
  assert.match(md, /自動モード：オン/);
  assert.match(md, /自動モードが人の確認なしで記録したもの: phase 00, approve translation, waive 03/);
  assert.match(md, /- 03: Autopilot: shape first.*\[自動\]/);
  const fast = statusSnapshot(f.root);
  assert.equal(fast.workflow.mode, 'auto');
  assert.equal(fast.waivers[0].auto, true);
  assert.deepEqual(fast.autoMode.records, ['phase 00', 'approve translation', 'waive 03']);
  // Back to normal: the mode line goes, the auto records stay visible until redone.
  setPreferences(f.root, { phaseMode: 'normal' });
  const after = migrationStatus(f.root);
  assert.equal(after.autoMode.active, false);
  assert.deepEqual(after.autoMode.records, ['phase 00', 'approve translation', 'waive 03'], 'auto waivers stay listed after leaving auto mode');
  assert.doesNotMatch(statusMarkdown(after, 'en'), /Auto mode: on/);
  complete(f, '00');
  assert.equal(readJSON(safePath(f.root, 'migration/phases/00.json')).auto, undefined, 'a completion by the person replaces the auto receipt');
  assert.deepEqual(migrationStatus(f.root).autoMode.records, ['approve translation', 'waive 03']);
  // The replaced receipt keeps the one cost row of the work.
  const rows = fs.readFileSync(safePath(f.root, 'migration/cost-log.tsv'), 'utf8').split('\n').filter(l => l.startsWith('00\t'));
  assert.equal(rows.length, 1);
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
  assert.match(fs.readFileSync(safePath(f.root, runSettingsHelpFile), 'utf8'), /`phaseMode`: .*auto is relaxed without asking/);
  Object.assign(s, { reportLanguage: 'en', originalRuntime: 'available', phaseMode: 'auto' });
  writeJSON(file, s);
  const applied = applyRunSettings(f.root, catalog);
  assert.equal(applied.applied, true, applied.errors?.join('\n'));
  assert.equal(readPreferences(f.root).phaseMode, 'auto');
  assert.ok(fs.existsSync(safePath(f.root, autoModeFile)), 'applying auto from the file records the deviation too');
  // settings apply itself still asks, so autopilot cannot switch auto on through the file.
  assert.equal(humanGate(`${kit} settings apply`), 'settings apply');
});

test('review of 333c70f: auto mode needs its record, and agents cannot write that record or switch auto on by any spelling', t => {
  const f = fixture(t, { mode: 'relaxed' });
  // A hand-edited preferences file is not auto mode: the gates keep asking.
  writeJSON(safePath(f.root, 'migration/preferences.json'), { ...readPreferences(f.root), phaseMode: 'auto' });
  for (const command of gateCommands) assert.equal(decide(f, command)?.decision, 'ask', command);
  try { requirePhase(f.root, f.config, '02'); assert.fail('gate expected'); }
  catch (e) { assert.match(e.message, /Relaxed mode: ask the person/); }
  const status = migrationStatus(f.root);
  assert.equal(status.workflow.mode, 'relaxed');
  assert.equal(status.autoMode.unrecorded, true);
  assert.equal(status.autoMode.active, false);
  assert.match(statusMarkdown(status, 'en'), /has no record .* not in effect/);
  assert.equal(statusSnapshot(f.root).workflow.mode, 'relaxed');
  // Writing the record is denied, by write tool and by shell.
  for (const toolArgs of [{ path: 'migration/phases/auto-mode.json', content: '{}' }, { file_path: `${f.root}/migration/phases/auto-mode.json` }])
    assert.equal(interactiveDecision({ toolName: 'create', toolArgs, cwd: f.root }, f.root)?.decision, 'deny');
  for (const command of ['echo {} > migration/phases/auto-mode.json', 'cp x.json migration/phases/auto-mode.json', 'touch migration/phases/auto-mode.json', 'cd migration/phases && echo {} > auto-mode.json'])
    assert.equal(decide(f, command)?.decision, 'deny', command);
  assert.equal(decide(f, 'cat migration/phases/auto-mode.json'), null, 'reading it is fine');
  // Any --phase-mode value that is not a literal normal or relaxed asks.
  for (const value of ["$'auto'", '$(echo auto)', '${X:-auto}', 'a\\uto', '"$X"']) assert.equal(decide(f, `${kit} preferences --phase-mode ${value}`)?.decision, 'ask', value);
  for (const value of ['normal', 'relaxed', '"relaxed"']) assert.equal(decide(f, `${kit} preferences --phase-mode ${value}`), null, value);
  // Choosing auto writes the missing record, then the mode is in effect.
  setPreferences(f.root, { phaseMode: 'auto' });
  assert.ok(fs.existsSync(safePath(f.root, autoModeFile)));
  assert.equal(decide(f, gateCommands[0]), null);
});

test('review of 333c70f: settings apply that switches auto on says so; the build-loop grant and a person\'s approval', async t => {
  const f = fixture(t);
  writeJSON(safePath(f.root, runSettingsFile), { schemaVersion: 1, phaseMode: 'auto' });
  const ask = decide(f, `${kit} settings apply`);
  assert.equal(ask?.decision, 'ask');
  assert.match(ask.reason, /switches to auto mode.*rule 3/s);
  writeJSON(safePath(f.root, runSettingsFile), { schemaVersion: 1, phaseMode: 'relaxed' });
  assert.equal(decide(f, `${kit} settings apply`), null, 'settings without the auto switch apply unasked');
  assert.doesNotMatch(decide(f, `${kit} settings apply && ${kit} status`).reason, /auto mode/);
  // A person's current approval is kept when auto mode approves again.
  for (const id of ['00', '00b', '01', '02']) complete(f, id);
  const { runStage } = await import('../lib/pipeline.mjs');
  await runStage(f.root, f.config, 'judge');
  complete(f, '03');
  const person = approve(f.root, f.config, 'translation', 'Reviewed by the person');
  setPreferences(f.root, { phaseMode: 'auto' });
  const again = approve(f.root, f.config, 'translation', 'Autopilot');
  assert.equal(again.approvedAt, person.approvedAt);
  assert.equal(readJSON(safePath(f.root, 'migration/gates/translation.json')).auto, undefined);
  // The build-loop grant written in auto mode is marked and listed.
  writeJSON(safePath(f.root, 'migration/gates/build-loop-x.json'), { schemaVersion: 1, kind: 'build-loop', id: 'x', auto: true });
  assert.ok(migrationStatus(f.root).autoMode.records.includes('build-loop'));
});

test('review of 7855afc: leaving auto retires its record, an escaped install option asks, and an unreadable record is not auto', t => {
  const f = fixture(t, { mode: 'auto', guardrails: false });
  assert.equal(decide(f, gateCommands[0]), null);
  setPreferences(f.root, { phaseMode: 'normal' });
  assert.equal(fs.existsSync(safePath(f.root, autoModeFile)), false);
  assert.equal(fs.readdirSync(safePath(f.root, 'migration/phases/retired')).filter(n => n.startsWith('auto-mode-')).length, 1);
  // A hand edit back to auto after an earlier auto session is not in effect.
  writeJSON(safePath(f.root, 'migration/preferences.json'), { ...readPreferences(f.root), phaseMode: 'auto' });
  assert.equal(decide(f, `${kit} phase waive 04 --note x`)?.decision, 'ask');
  assert.equal(migrationStatus(f.root).autoMode.unrecorded, true);
  // Moving the retired record back is a write of the record: denied.
  assert.equal(decide(f, 'mv migration/phases/retired/auto-mode-x.json migration/phases/auto-mode.json')?.decision, 'deny');
  // Choosing auto again writes a fresh record.
  setPreferences(f.root, { phaseMode: 'auto' });
  assert.equal(decide(f, gateCommands[0]), null);
  // Only the plain template install is unasked; quoted or escaped options ask.
  assert.equal(decide(f, `${kit} guardrails install`), null);
  for (const command of [`${kit} guardrails install --wa""iver "x"`, `${kit} guardrails install "--wa"iver x`, `${kit} guardrails install --wa\\iver x`,
    `${kit} guardrails install $OPTS`, `${kit} guardrails install && ${kit} guardrails install --waiver x`, `${kit} guardrails install --help2`])
    assert.equal(decide(f, command)?.decision, 'ask', command);
  // An unreadable record is not auto mode, for the hook and for status alike.
  fs.writeFileSync(safePath(f.root, autoModeFile), '{not json');
  assert.equal(decide(f, gateCommands[0])?.decision, 'ask');
  const status = migrationStatus(f.root);
  assert.equal(status.autoMode.active, false);
  assert.equal(status.workflow.mode, 'relaxed');
});

test('review of 0c2a8c5: a failed retire leaves auto chosen, an invalid preferences file is never auto, and Windows paths install unasked', t => {
  const f = fixture(t, { mode: 'auto', guardrails: false });
  // The retire comes before the preference: if it fails, nothing says normal.
  fs.writeFileSync(safePath(f.root, 'migration/phases/retired'), 'a file, not a folder');
  assert.throws(() => setPreferences(f.root, { phaseMode: 'normal' }));
  assert.equal(readPreferences(f.root).phaseMode, 'auto');
  assert.ok(fs.existsSync(safePath(f.root, autoModeFile)));
  fs.rmSync(safePath(f.root, 'migration/phases/retired'));
  // Fast cycles keep every retired record.
  for (let i = 0; i < 10; i++) { setPreferences(f.root, { phaseMode: 'normal' }); setPreferences(f.root, { phaseMode: 'auto' }); }
  assert.equal(fs.readdirSync(safePath(f.root, 'migration/phases/retired')).filter(n => n.startsWith('auto-mode-')).length, 10);
  // Windows-style runner paths are the same plain install.
  assert.equal(decide(f, 'node migration-kit\\scripts\\run_migration.mjs guardrails install'), null);
  assert.equal(decide(f, 'node migration-kit\\scripts\\run_migration.mjs guardrails install --waiver x')?.decision, 'ask');
  // A preferences file the runner rejects is not auto mode anywhere.
  writeJSON(safePath(f.root, 'migration/preferences.json'), { schemaVersion: 1, userLanguage: 'fr', phaseMode: 'auto' });
  assert.equal(decide(f, gateCommands[0])?.decision, 'ask');
  assert.equal(statusSnapshot(f.root).autoMode?.active ?? false, false);
});

test('review (Sonnet): a gate runs unasked only on its own; switching auto on outside the runner asks; a stale record never revives', t => {
  const f = fixture(t, { mode: 'auto' });
  // Anything chained after an auto gate keeps its ask.
  for (const command of [`${kit} approve translation --note x && ${kit} models set --role all --model gpt-5`, `${kit} phase complete 02 --note x; ${kit} sessions prune`,
    `${kit} phase complete 02 --note x; ${kit} preferences --phase-mode auto`, `${kit} build-loop --note x && ${kit} settings apply`,
    `${kit} approve build --note x | ${kit} guardrails install --deny foo`, `${kit} approve build --note x\n${kit} pilot prepare --note y`,
    `$(${kit} approve build --note x) ${kit} models set --role all --model m`, `bash -c "${kit} approve build --note x; ${kit} sessions prune"`])
    assert.equal(decide(f, command)?.decision, 'ask', command);
  // A note with separators inside quotes is still one gate.
  assert.equal(decide(f, `${kit} phase complete 02 --note "a; b && c | d"`), null);
  // The kit's preference modules reached in a form the hook cannot read ask.
  assert.equal(decide(f, `node -e "import('./migration-kit/lib/preferences.mjs').then(m=>m.setPreferences(process.cwd(),{phaseMode:'auto'}))"`)?.decision, 'ask');
  // Writing auto into preferences.json outside the runner asks.
  assert.equal(decide(f, `echo '{"schemaVersion":1,"userLanguage":"ja","phaseMode":"auto"}' > migration/preferences.json`)?.decision, 'ask');
  assert.equal(interactiveDecision({ toolName: 'edit', toolArgs: { path: 'migration/preferences.json', old_str: 'normal', new_str: 'auto' }, cwd: f.root }, f.root)?.decision, 'ask');
  assert.equal(decide(f, 'cat migration/preferences.json'), null);
  // The record named relative to a cd is still the record.
  for (const command of ['cd migration && cp x phases/auto-mode.json', 'cd migration/phases && cp x ./auto-mode.json']) assert.equal(decide(f, command)?.decision, 'deny', command);
  // A record left behind a hand-edited mode is retired on the next read.
  writeJSON(safePath(f.root, 'migration/preferences.json'), { ...readPreferences(f.root), phaseMode: 'normal' });
  assert.ok(fs.existsSync(safePath(f.root, autoModeFile)));
  readPreferences(f.root);
  assert.equal(fs.existsSync(safePath(f.root, autoModeFile)), false);
  writeJSON(safePath(f.root, 'migration/preferences.json'), { ...readPreferences(f.root), phaseMode: 'auto' });
  assert.equal(decide(f, gateCommands[0])?.decision, 'ask');
  // Preferences without userLanguage are invalid for the runner, so not auto anywhere.
  setPreferences(f.root, { phaseMode: 'auto' });
  writeJSON(safePath(f.root, 'migration/preferences.json'), { schemaVersion: 1, phaseMode: 'auto' });
  assert.equal(decide(f, gateCommands[0])?.decision, 'ask');
});

test('review of 6e26d89: guardrails.json matching is unchanged in every mode; the record is matched from the working directory; notes stay one gate', t => {
  const f = fixture(t);
  // Unrelated guardrails.json files after a cd: allowed as before 0.13.0.
  for (const command of ['cd frontend && cp ../tpl/guardrails.json config/guardrails.json', "cd tools && echo '{}' > ../policy/guardrails.json",
    'cd app && npm run gen -- --out ./guardrails.json', 'cd src && touch sub/guardrails.json'])
    assert.equal(decide(f, command), null, command);
  // A commit message with the word auto is not a switch to auto mode.
  assert.equal(decide(f, 'cp migration/preferences.json backups/prefs-auto-backup.json'), null);
  // The record and preferences.json named relative to the session's working directory.
  const inside = (dir, command) => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: safePath(f.root, dir) }, f.root);
  fs.mkdirSync(safePath(f.root, 'migration/phases'), { recursive: true });
  for (const [dir, command] of [['migration', 'cp x phases/auto-mode.json'], ['migration', 'cp x ./phases/auto-mode.json'], ['migration/phases', 'echo {} > ../phases/auto-mode.json'],
    ['migration', 'cp x ./phases/../phases/auto-mode.json']]) assert.equal(inside(dir, command)?.decision, 'deny', `${dir}: ${command}`);
  assert.equal(inside('migration', `echo '{"phaseMode":"auto"}' > ./preferences.json`)?.decision, 'ask');
  // In auto mode, notes with literal $ or backticks in single quotes and notes naming the runner are one gate.
  setPreferences(f.root, { phaseMode: 'auto' });
  for (const note of ["'Reviewed `RULEBOOK.md` and costs $5'", '"ran run_migration.mjs status first"']) assert.equal(decide(f, `${kit} phase complete 02 --note ${note}`), null, note);
  // Double quotes still expand, so they ask.
  assert.equal(decide(f, `${kit} phase complete 02 --note "costs \`id\`"`)?.decision, 'ask');
  // A record retired by another reader first never makes reading fail.
  setPreferences(f.root, { phaseMode: 'auto' });
  writeJSON(safePath(f.root, 'migration/preferences.json'), { ...readPreferences(f.root), phaseMode: 'normal' });
  readPreferences(f.root);
  assert.doesNotThrow(() => readPreferences(f.root));
  // A record with no preferences file is retired too.
  setPreferences(f.root, { phaseMode: 'auto' });
  fs.rmSync(safePath(f.root, 'migration/preferences.json'));
  readPreferences(f.root);
  assert.equal(fs.existsSync(safePath(f.root, autoModeFile)), false);
});

test('review of 5d5d992: quotes are tracked as the shell does, and an in-place edit to auto asks', t => {
  const f = fixture(t, { mode: 'auto' });
  assert.equal(decide(f, `${kit} approve build --note "a'" --note "$(touch /tmp/evil)'"`)?.decision, 'ask');
  assert.equal(decide(f, `${kit} approve build --note 'it'"'"'s $5'`), null);
  assert.equal(decide(f, `${kit} approve build --note "a \\$5"`), null, 'an escaped $ in double quotes is literal');
  for (const command of ["sed -i 's/normal/auto/' migration/preferences.json", "perl -pi -e 's/relaxed/auto/' migration/preferences.json"])
    assert.equal(decide(f, command)?.decision, 'ask', command);
});

test('auto mode instructions also cover audits, size-limited reviews and open choices inside a phase', () => {
  const kit = path.resolve(import.meta.dirname, '..');
  const read = file => fs.readFileSync(path.join(kit, file), 'utf8').replace(/\s+/g, ' ');
  // Without these an autopilot run stops inside 00b/02 and asks the person.
  for (const file of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = read(file);
    assert.match(text, /Questions inside a phase are not asked either: an audit or independent review that returns `changes` gets one round/, file);
    assert.match(text, /reviews limited by `maxReviewInputBytes`, and UNKNOWN or uncited rows are not fixed again/, file);
    assert.match(text, /takes the most conservative option, the one closest to the original structure that adds no framework or dependency, unless the person already stated one/, file);
    assert.match(text, /Before the inventory survey runs, write it into the RULEBOOK with a greppable `TODO\(port\)` naming the open choice\. After that, leave the RULEBOOK unchanged/, file);
  }
  for (const file of ['.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md']) {
    const text = read(file);
    assert.match(text, /Inside a phase ask nothing either: an audit or review that returns changes gets one fix and one fresh re-audit/, file);
    assert.match(text, /takes the most conservative option \(closest to the original, no new framework or dependency\) unless the person gave one, with `TODO\(port\)` in the RULEBOOK before the inventory survey runs \(later, in the translated output only, never the RULEBOOK\)/, file);
  }
  assert.match(read('docs/PREPARATION-AUDITS.md'), /In auto mode \(`phaseMode: auto`\) every preparation audit in 00b, 01 and 02 gets one repair round only/);
  assert.match(read('docs/ORDERED-WORKFLOW.md'), /工程の中でも聞きません。.*いちばん保守的な案を選びます/);
  assert.match(read('docs/ORDERED-WORKFLOW.en.md'), /Nothing inside a phase is asked either\..*takes the most conservative option/);
  assert.match(read('docs/PHASE-HANDOFF.md'), /Questions inside a phase are not asked either/);
});

test('review of 0.20.0: a note quoting a settings command keeps its gate; settings for another project or CLI keep asking', t => {
  for (const mode of [undefined, 'relaxed', 'auto']) {
    const f = fixture(t, { mode });
    const expected = mode === 'auto' ? null : 'ask';
    for (const inner of ['settings apply', 'models set --role all --model gpt-5', 'pilot prepare'])
      for (const command of [`${kit} approve translation --note "Reviewed; next: run_migration.mjs ${inner}"`, `${kit} phase complete 03 --note "Reviewed; next: run_migration.mjs ${inner}"`,
        `${kit} phase waive 03 --note "later: run_migration.mjs ${inner}"`, `${kit} build-loop --note "then run_migration.mjs ${inner}"`])
        assert.equal(decide(f, command)?.decision ?? null, expected, `${mode}: ${command}`);
    // sessions prune is never let through by a note naming an unasked gate.
    assert.equal(decide(f, `${kit} sessions prune --note "after run_migration.mjs approve translation"`)?.decision, 'ask', `${mode}: prune`);
    // Another project's settings, or a CLI of the agent's choosing, keep asking.
    const other = fixture(t, { mode: 'normal' });
    writeJSON(safePath(other.root, runSettingsFile), { schemaVersion: 1, phaseMode: 'auto' });
    for (const command of [`${kit} settings apply --root ${other.root}`, `${kit} settings apply --root=${other.root}`, `${kit} models set --role all --model gpt-5 --root ${other.root}`,
      `${kit} settings apply --copilot ./fake`, `${kit} models set --role all --model gpt-5 --copilot=./fake`])
      assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
    assert.equal(decide(f, `${kit} settings apply --root ${f.root}`), null, `${mode}: own --root`);
    assert.equal(decide(f, `${kit} settings apply --root .`), null, `${mode}: --root .`);
    for (const command of [`${kit} settings apply --root . --root ${other.root}`, `${kit} models set --role all --model gpt-5 --root . --root=${other.root}`])
      assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
    // A substitution in a note runs, so the command inside it is still a gate.
    for (const inner of ['approve translation --note ok', 'phase complete 03 --note ok', 'sessions prune'])
      for (const command of [`${kit} status --note "$(node migration-kit/scripts/run_migration.mjs ${inner})"`, `${kit} models list --note "\`node migration-kit/scripts/run_migration.mjs ${inner}\`"`])
        assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
    // In auto mode, the two newly unasked gates still ask when chained.
    for (const command of [`${kit} pilot prepare --note x && ${kit} sessions prune`, `cd src && ${kit} source-spec init --apply`])
      assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
  }
});
