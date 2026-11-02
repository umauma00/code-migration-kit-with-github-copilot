// SPDX-License-Identifier: Apache-2.0
// 0.45.0: one file to change settings in. migration/run-settings.json is
// renamed migration/settings.json, and the kit's records of it
// (migration/config.json and migration/preferences.json, beside it until
// 0.44.x, where they looked like more files to edit) move into
// migration/state/ at the next command that does work. The move is a rename:
// the content stays as it was, so every record made under it stays current.
// A file an older kit writes again in the old place is named, never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare, throughSmoke, holding, allHolding, scopesOf, python } from './helpers.mjs';
import { install, kitRoot } from '../scripts/install.mjs';
import { safePath, readJSON, writeJSON, atomicWrite, loadConfig, lockRun, configFile, legacyConfigFile, legacyContextHash, readConfigFile } from '../lib/core.mjs';
import { settingsAtStart, settingsNotice, settingsState, settingsFile, settingsHelpFile, legacySettingsFile, legacySettingsHelpFile, settingsBaseFile,
  initSettings, applySettings, syncSettings } from '../lib/settings.mjs';
import { readPreferences, setPreferences, preferencesFile, legacyPreferencesFile, autoModeFile } from '../lib/preferences.mjs';
import { autoModeOn } from '../lib/auto-mode.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { interactiveDecision, guardrailDecision } from '../lib/guardrails.mjs';
import { normalizeModels } from '../lib/models.mjs';
import { preparePilot, requirePilot } from '../lib/pilot.mjs';
import { runStage } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';

const models = normalizeModels([{ id: 'test-double', name: 'Test double' }, { id: 'another-model', name: 'Another model' }]);
const list = async () => models;
const kit = 'node migration-kit/scripts/run_migration.mjs';
const bytes = (root, rel) => fs.readFileSync(safePath(root, rel));
const exists = (root, rel) => fs.existsSync(safePath(root, rel));

// The layout of 0.44.x: the records beside the file, the file and its help
// under their old names, and no record of what was applied (0.45.0 adds it).
const layout043 = [[configFile, legacyConfigFile], [preferencesFile, legacyPreferencesFile], [settingsFile, legacySettingsFile], [settingsHelpFile, legacySettingsHelpFile]];
function oldLayout(root) {
  for (const [from, to] of layout043) if (exists(root, from)) fs.renameSync(safePath(root, from), safePath(root, to));
  fs.rmSync(safePath(root, settingsBaseFile), { force: true });
}
const moved = [`${legacyConfigFile} -> ${configFile}`, `${legacyPreferencesFile} -> ${preferencesFile}`];
const renamed = [`${legacySettingsFile} -> ${settingsFile}`, `${legacySettingsHelpFile} -> ${settingsHelpFile}`];

// A project whose settings file is filled in and applied, as setup leaves it.
function filledProject(t, language = 'en') {
  const f = prepare(t);
  setPreferences(f.root, { language, originalRuntime: 'available', phaseMode: 'normal' });
  initSettings(f.root, models);
  const applied = applySettings(f.root, models);
  assert.equal(applied.applied, true, JSON.stringify(applied.errors));
  return f;
}
const editSettings = (root, change) => { const file = safePath(root, settingsFile), s = readJSON(file); change(s); writeJSON(file, s); };

test('the next command that does work moves the kit\'s records unchanged, and every record made under them stays current', async t => {
  const f = await throughSmoke(t);
  setPreferences(f.root, { language: 'en', originalRuntime: 'available', phaseMode: 'normal' });
  await settingsAtStart(f.root, list);
  oldLayout(f.root);
  const config = bytes(f.root, legacyConfigFile), preferences = bytes(f.root, legacyPreferencesFile);
  // Read where 0.44.x keeps them, before anything moves.
  const scopes = scopesOf(f.root, loadConfig(f.root)), legacy = legacyContextHash(f.root, loadConfig(f.root));
  assert.deepEqual(holding(f), allHolding(2));
  // status only reads: it names what the next command does and moves nothing.
  const status = migrationStatus(f.root);
  assert.equal(status.settings.file, legacySettingsFile);
  assert.equal(status.settings.renameTo, settingsFile);
  assert.deepEqual(status.settings.recordsToMove, [legacyConfigFile, legacyPreferencesFile]);
  const markdown = statusMarkdown(status);
  assert.match(markdown, /migration\/run-settings\.json: old name; the next command renames it to migration\/settings\.json\./);
  assert.match(markdown, /migration\/config\.json, migration\/preferences\.json: the kit's records, moved into migration\/state\/ by the next command\./);
  assert.ok(exists(f.root, legacyConfigFile) && exists(f.root, legacyPreferencesFile));
  assert.deepEqual(statusSnapshot(f.root).settings.recordsToMove, [legacyConfigFile, legacyPreferencesFile], 'the fast status reads them in the old place too');
  // A command that does work, here sessions prune, moves them before anything else.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-move-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [safePath(f.root, 'migration-kit/scripts/run_migration.mjs'), 'sessions', 'prune', '--root', f.root],
    { cwd: f.root, encoding: 'utf8', env: { ...process.env, COPILOT_HOME: home } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, new RegExp(`settings: moved ${moved.join(', ')}; renamed ${renamed.join(', ')}`.replace(/[./]/g, c => `\\${c}`)));
  const started = JSON.parse(run.stdout).settings;
  assert.deepEqual(started.moved, moved);
  assert.deepEqual(started.renamed, renamed);
  assert.deepEqual(bytes(f.root, configFile), config, 'the configuration record is the same bytes');
  assert.deepEqual(bytes(f.root, preferencesFile), preferences);
  for (const old of [legacyConfigFile, legacyPreferencesFile, legacySettingsFile, legacySettingsHelpFile]) assert.equal(exists(f.root, old), false, old);
  assert.equal(scopesOf(f.root, loadConfig(f.root)), scopes);
  assert.equal(legacyContextHash(f.root, loadConfig(f.root)), legacy, 'what the records of 0.44.x stand for reads the same');
  assert.deepEqual(holding(f), allHolding(2));
  const after = migrationStatus(f.root);
  assert.equal(after.settings.state, 'applied');
  assert.equal(after.settings.recordsToMove, undefined);
  // The next command has nothing to move.
  assert.deepEqual(await settingsAtStart(f.root, list), {});
});

test('the settings file\'s old name becomes the new one with its help, and help or an explanation naming the old file is written again', async t => {
  const f = filledProject(t);
  const values = readJSON(safePath(f.root, settingsFile));
  oldLayout(f.root);
  // As 0.44.x wrote them: the explanation and the help name the old file.
  writeJSON(safePath(f.root, legacySettingsFile), { ...values, _about: 'Change the run settings in migration/run-settings.json, then run settings apply.' });
  atomicWrite(safePath(f.root, legacySettingsHelpFile), '# Run settings\nEdit migration/run-settings.json.\n');
  const before = settingsState(f.root, loadConfig(f.root));
  assert.equal(before.file, legacySettingsFile);
  assert.equal(before.renameTo, settingsFile);
  assert.equal(before.state, 'applied', 'the old name holds the same settings');
  const started = await settingsAtStart(f.root, list);
  assert.deepEqual(started.renamed, renamed);
  assert.match(settingsNotice(started), /renamed migration\/run-settings\.json -> migration\/settings\.json, migration\/run-settings\.help\.md -> migration\/settings\.help\.md/);
  assert.equal(started.applied, undefined, 'nothing to apply: only names changed');
  const file = readJSON(safePath(f.root, settingsFile)), help = fs.readFileSync(safePath(f.root, settingsHelpFile), 'utf8');
  assert.doesNotMatch(JSON.stringify(file), /run-settings/);
  assert.deepEqual({ ...file, _about: null }, { ...values, _about: null }, 'the person\'s values are kept as written');
  assert.doesNotMatch(help, /run-settings/);
  assert.match(help, /`test-double`/, 'the help is written again with the account\'s models');
  assert.deepEqual(await settingsAtStart(f.root, list), {}, 'once');
});

test('an old file an older kit writes again beside its replacement is named and never used', async t => {
  const f = filledProject(t);
  assert.deepEqual(await settingsAtStart(f.root, list), {});
  // Another Copilot host still runs 0.44.x and writes where it reads.
  writeJSON(safePath(f.root, legacyConfigFile), { ...readJSON(safePath(f.root, configFile)), concurrency: 7 });
  writeJSON(safePath(f.root, legacyPreferencesFile), { schemaVersion: 1, userLanguage: 'ja' });
  writeJSON(safePath(f.root, legacySettingsFile), { ...readJSON(safePath(f.root, settingsFile)), concurrency: 7 });
  assert.equal(loadConfig(f.root).concurrency, 2, 'the record in its place is the one read');
  assert.equal(readPreferences(f.root).userLanguage, 'en');
  const unused = [legacySettingsFile, legacyConfigFile, legacyPreferencesFile];
  const started = await settingsAtStart(f.root, list);
  assert.deepEqual(started.unused, unused);
  assert.match(settingsNotice(started), /migration\/run-settings\.json, migration\/config\.json, migration\/preferences\.json are not used: since 0\.45\.0 the kit keeps its records in migration\/state\/ and reads the settings from migration\/settings\.json\. .*make every host use the same kit version, then delete them\. Tell the person\./);
  assert.equal(loadConfig(f.root).concurrency, 2);
  assert.equal(started.applied, undefined);
  for (const old of unused) assert.ok(exists(f.root, old), `${old} is left for the person`);
  const status = migrationStatus(f.root);
  assert.deepEqual(status.settings.unused, unused);
  assert.match(statusMarkdown(status, 'ja'), /migration\/run-settings\.json, migration\/config\.json, migration\/preferences\.json: 使われていません/);
});

test('while another command holds the run lock the move waits, and the records are read where they are meanwhile', async t => {
  const f = filledProject(t);
  oldLayout(f.root);
  const release = lockRun(f.root, 'translate');
  try {
    const started = await settingsAtStart(f.root, list);
    assert.match(started.deferred, /^Migration locked by running pid \d+ \(translate\); the kit's records move to migration\/state\/ and the settings file is applied when the next command starts$/);
    assert.deepEqual(started.renamed, renamed, 'a rename needs no lock');
    assert.ok(exists(f.root, legacyConfigFile) && exists(f.root, legacyPreferencesFile));
    assert.equal(loadConfig(f.root).concurrency, 2);
    assert.equal(readPreferences(f.root).userLanguage, 'en');
    assert.match(settingsNotice(started), /the kit's records move to migration\/state\//);
  } finally { release(); }
  const next = await settingsAtStart(f.root, list);
  assert.deepEqual(next.moved, moved);
  assert.equal(next.deferred, undefined);
});

test('a record read while another command moves it is found, and auto mode stays on through the move', async t => {
  const f = filledProject(t);
  setPreferences(f.root, { phaseMode: 'auto' });
  syncSettings(f.root, { keys: ['phaseMode'] });
  assert.ok(autoModeOn(f.root));
  oldLayout(f.root);
  assert.ok(autoModeOn(f.root), 'read in the old place');
  assert.equal(readPreferences(f.root).phaseMode, 'auto');
  // The move lands between the reader's look at the new place and its look
  // at the old one: the third look finds it, so nothing takes it for lost
  // (a lost preferences record retires the auto-mode record).
  const realRead = fs.readFileSync, oldFile = safePath(f.root, legacyPreferencesFile);
  let raced = 0;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file === oldFile && !raced++) fs.renameSync(oldFile, safePath(f.root, preferencesFile));
    return realRead(file, ...rest);
  });
  try {
    assert.equal(readPreferences(f.root).phaseMode, 'auto');
    assert.equal(raced, 1, 'the move happened during the read');
  } finally { t.mock.restoreAll(); }
  assert.ok(exists(f.root, autoModeFile), 'the auto-mode record is not retired');
  assert.ok(autoModeOn(f.root));
  const started = await settingsAtStart(f.root, list);
  assert.deepEqual(started.moved, [`${legacyConfigFile} -> ${configFile}`]);
  assert.ok(autoModeOn(f.root));
  assert.equal(exists(f.root, 'migration/phases/retired'), false);
  assert.equal(readJSON(safePath(f.root, settingsFile)).phaseMode, 'auto');
  // The configuration record is read the same way.
  oldLayout(f.root);
  const oldConfig = safePath(f.root, legacyConfigFile);
  let racedConfig = 0;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (file === oldConfig && !racedConfig++) fs.renameSync(oldConfig, safePath(f.root, configFile));
    return realRead(file, ...rest);
  });
  try { assert.equal(readConfigFile(f.root).concurrency, 2); } finally { t.mock.restoreAll(); }
  assert.equal(racedConfig, 1);
});

test('the hooks find the project, its language and a switch to auto mode in either place', t => {
  const f = prepare(t);
  fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(f.root, 'migration/guardrails.json'));
  setPreferences(f.root, { language: 'ja', phaseMode: 'normal' });
  const decide = (command, cwd = f.root) => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd }, f.root);
  const japanese = /[぀-ゟ]/;
  for (const where of ['0.45.0', '0.44.x']) {
    if (where === '0.44.x') oldLayout(f.root);
    // Found from a folder below it; the question is asked in the recorded language.
    assert.match(decide(`${kit} approve translation --note "Reviewed"`, safePath(f.root, 'src'))?.reason ?? '', japanese, where);
    assert.match(guardrailDecision({ toolName: 'bash', toolArgs: { command: 'git push' }, cwd: safePath(f.root, 'src') }, f.root) ?? '', /"git push" is denied/, where);
    // Writing auto into the preferences record, in its place or the old one, asks.
    for (const [cwd, command] of [[f.root, `echo '{"phaseMode":"auto"}' > migration/state/preferences.json`], [f.root, `echo '{"phaseMode":"auto"}' > migration/preferences.json`],
      [safePath(f.root, 'migration'), `echo '{"phaseMode":"auto"}' > ./state/preferences.json`], [safePath(f.root, 'migration'), `echo '{"phaseMode":"auto"}' > preferences.json`],
      [safePath(f.root, 'migration/state'), `echo '{"phaseMode":"auto"}' > preferences.json`]])
      assert.equal(decide(command, cwd)?.decision, 'ask', `${where}: ${command} in ${path.relative(f.root, cwd) || '.'}`);
    for (const target of [preferencesFile, legacyPreferencesFile])
      assert.equal(interactiveDecision({ toolName: 'edit', toolArgs: { path: target, old_str: 'normal', new_str: 'auto' }, cwd: f.root }, f.root)?.decision, 'ask', `${where}: ${target}`);
    assert.equal(decide(`cat ${preferencesFile} ${legacyPreferencesFile}`), null, `${where}: reading asks nothing`);
  }
  // settings apply that switches auto on from the file under its old name asks.
  writeJSON(safePath(f.root, legacySettingsFile), { schemaVersion: 1, phaseMode: 'auto' });
  assert.equal(decide(`${kit} settings apply`)?.decision, 'ask');
  fs.writeFileSync(safePath(f.root, legacySettingsFile), `﻿${JSON.stringify({ schemaVersion: 1, phaseMode: 'normal' })}`);
  assert.equal(decide(`${kit} settings apply`), null, 'recording the person\'s settings runs unasked');
  // Auto mode chosen with the records in the old place lets the gates run unasked, before and after the move.
  setPreferences(f.root, { phaseMode: 'auto' });
  assert.ok(exists(f.root, legacyPreferencesFile) && !exists(f.root, preferencesFile), 'written where it is');
  assert.equal(decide(`${kit} approve translation --note "Reviewed"`), null);
  fs.renameSync(safePath(f.root, legacyPreferencesFile), safePath(f.root, preferencesFile));
  fs.renameSync(safePath(f.root, legacyConfigFile), safePath(f.root, configFile));
  assert.equal(decide(`${kit} approve translation --note "Reviewed"`), null);
});

test('installing again on a project of 0.44.x writes no second record, and keeps the recorded language', t => {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-move-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  install(plugin, { apply: true, layout: 'plugin', language: 'ja' });
  oldLayout(plugin);
  const again = install(plugin, { apply: true, layout: 'plugin', language: 'en' });
  assert.deepEqual(again.changes, []);
  assert.equal(exists(plugin, configFile), false);
  assert.equal(exists(plugin, preferencesFile), false);
  assert.equal(readPreferences(plugin).userLanguage, 'ja');
  // The repository layout: the same kit files again change nothing.
  const f = prepare(t);
  setPreferences(f.root, { language: 'ja' });
  oldLayout(f.root);
  const repository = install(f.root, { apply: true, layout: 'repository', language: 'en' });
  assert.deepEqual(repository.changes, []);
  assert.equal(exists(f.root, configFile), false);
  assert.equal(exists(f.root, preferencesFile), false);
  assert.equal(loadConfig(f.root).concurrency, 2, 'the existing record is the configuration');
});

test('a pilot copy takes the project\'s run settings while the project still has the old layout', async t => {
  const f = prepare(t, { count: 2 });
  f.config.phasePolicy = 'strict';
  writeJSON(safePath(f.root, configFile), f.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, name), 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await runStage(f.root, f.config, 'judge');
  const child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable pilot fixture', through: 'translation' });
  oldLayout(f.root); oldLayout(child);
  assert.ok(requirePilot(child, loadConfig(child)));
  writeJSON(safePath(f.root, legacyConfigFile), { ...readJSON(safePath(f.root, legacyConfigFile)), concurrency: 3 });
  const started = await settingsAtStart(child, list);
  assert.deepEqual(started.moved, [`${legacyConfigFile} -> ${configFile}`], 'the copy\'s record moves');
  assert.deepEqual(started.project.moved, [`${legacyConfigFile} -> ${configFile}`], 'and the project\'s, before the copy reads it');
  assert.deepEqual(started.followedProject, ['concurrency']);
  assert.match(settingsNotice(started), /the pilot took concurrency from the project/);
  assert.equal(loadConfig(child).concurrency, 3);
  assert.ok(requirePilot(child, loadConfig(child)), 'the pilot still holds');
});

test('an edit of the settings file is applied when a command starts, and a change made on the record is copied into the file', async t => {
  const f = filledProject(t);
  let listed = 0;
  const counted = async () => { listed++; return models; };
  // Applied: the person's edit.
  editSettings(f.root, s => { s.concurrency = 3; });
  assert.deepEqual(settingsState(f.root, loadConfig(f.root)).toApply, ['concurrency']);
  let started = await settingsAtStart(f.root, counted);
  assert.deepEqual(started.applied, ['concurrency']);
  assert.equal(settingsNotice(started), 'settings: applied concurrency from migration/settings.json');
  assert.equal(loadConfig(f.root).concurrency, 3);
  assert.equal(listed, 0, 'the account\'s model list is read only for a model change');
  // Copied: a change made on the record (a command, or a hand edit) goes into the file.
  writeJSON(safePath(f.root, configFile), { ...readJSON(safePath(f.root, configFile)), maxReviewInputBytes: 2097152 });
  assert.deepEqual(settingsState(f.root, loadConfig(f.root)).toCopy, ['maxReviewInputBytes']);
  started = await settingsAtStart(f.root, counted);
  assert.deepEqual(started.copied, ['maxReviewInputBytes']);
  assert.equal(readJSON(safePath(f.root, settingsFile)).maxReviewInputBytes, 2097152);
  // Both changed: the file is the person's, so it wins, and the result says so.
  writeJSON(safePath(f.root, configFile), { ...readJSON(safePath(f.root, configFile)), concurrency: 5 });
  editSettings(f.root, s => { s.concurrency = 6; });
  started = await settingsAtStart(f.root, counted);
  assert.deepEqual(started.bothChanged, ['concurrency']);
  assert.equal(loadConfig(f.root).concurrency, 6);
  // A model change needs the account's list: without one nothing is applied.
  editSettings(f.root, s => { s.models.fixer = { model: 'another-model', effort: 'default', context: 'default' }; });
  started = await settingsAtStart(f.root, async () => { throw new Error('not signed in'); });
  assert.match(started.errors.join('\n'), /models: cannot check the model choices \(not signed in\)/);
  assert.match(started.next, /^Nothing was applied: migration\/settings\.json has entries that cannot be used/);
  assert.equal(loadConfig(f.root).models.fixer, 'test-double');
  started = await settingsAtStart(f.root, counted);
  assert.deepEqual(started.applied, ['models.fixer']);
  assert.equal(listed, 1);
  assert.equal(loadConfig(f.root).models.fixer, 'another-model');
  // A value the runner refuses: nothing is applied, and status says why.
  editSettings(f.root, s => { s.concurrency = 0; });
  started = await settingsAtStart(f.root, counted);
  assert.ok(started.errors.some(e => /concurrency/.test(e)), JSON.stringify(started.errors));
  assert.equal(loadConfig(f.root).concurrency, 6);
  assert.equal(settingsState(f.root, loadConfig(f.root)).state, 'invalid-entries');
  editSettings(f.root, s => { s.concurrency = 6; });
  // Switching to auto mode waits for settings apply, which the host confirms.
  editSettings(f.root, s => { s.phaseMode = 'auto'; });
  started = await settingsAtStart(f.root, counted);
  assert.match(started.autoSwitch, /waits for settings apply/);
  assert.equal(readPreferences(f.root).phaseMode, 'normal');
  assert.equal(readJSON(safePath(f.root, settingsFile)).phaseMode, 'auto', 'it stays as the person wrote it');
  assert.equal(settingsState(f.root, loadConfig(f.root)).autoSwitch, true);
  assert.equal((await settingsAtStart(f.root, counted)).autoSwitch !== undefined, true, 'and keeps waiting');
  assert.equal(applySettings(f.root, models).applied, true);
  assert.ok(autoModeOn(f.root));
});

test('a typo in the settings file is reported, never taken as applied', async t => {
  const f = filledProject(t);
  editSettings(f.root, s => { s.concurency = 3; s.models.implementor = { model: 'test-double' }; s.models.fixer.efort = 'high'; });
  const started = await settingsAtStart(f.root, list), errors = started.errors.join('\n');
  assert.match(errors, /concurency: unknown setting/);
  assert.match(errors, /models\.implementor: unknown role/);
  assert.match(errors, /models\.fixer\.efort: unknown field/);
  assert.equal(loadConfig(f.root).concurrency, 2);
  const state = settingsState(f.root, loadConfig(f.root));
  assert.equal(state.state, 'invalid-entries');
  assert.ok(['concurency', 'models.implementor', 'models.fixer.efort'].every(name => state.errors.some(e => e.startsWith(name))), JSON.stringify(state.errors));
  assert.match(statusMarkdown(migrationStatus(f.root)), /has entries that cannot be used/);
});

test('an answer of the template\'s own languages is in step with the record, before the manifest exists', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-move-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, layout: 'repository', language: 'en' });
  atomicWrite(path.join(root, 'src/app.py'), 'def add(a, b):\n    return a + b\n');
  fs.mkdirSync(path.join(root, 'tests'));
  // A new file asks for the languages: the template's example pair is not an answer.
  initSettings(root, models);
  assert.equal(readJSON(safePath(root, settingsFile)).sourceLanguage, 'FILL_IN');
  // The person answers Python to JavaScript, the template's pair.
  initSettings(root, models, { source: 'Python', target: 'JavaScript' });
  editSettings(root, s => {
    Object.assign(s, { originalRuntime: 'available', phaseMode: 'normal' });
    for (const role of ['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer']) s.models[role] = { model: 'test-double', effort: 'default', context: 'default' };
  });
  const applied = applySettings(root, models);
  assert.equal(applied.applied, true, JSON.stringify(applied.errors));
  assert.equal(exists(root, 'migration/manifest.tsv'), false);
  assert.equal(settingsState(root, loadConfig(root, { requireModels: false })).state, 'applied');
  const started = await settingsAtStart(root, list);
  assert.equal(started.applied, undefined, JSON.stringify(started));
  assert.equal(started.changed, undefined);
  assert.equal(readJSON(safePath(root, settingsFile)).sourceLanguage, 'Python');
});

test('a lost preferences record is restored from the settings file, never the file from the lost record', async t => {
  const f = filledProject(t, 'ja');
  fs.rmSync(safePath(f.root, preferencesFile));
  const state = settingsState(f.root, loadConfig(f.root));
  assert.equal(state.state, 'changed');
  assert.deepEqual(state.toApply, ['reportLanguage', 'originalRuntime', 'phaseMode']);
  const started = await settingsAtStart(f.root, list);
  assert.deepEqual(started.applied, ['reportLanguage', 'originalRuntime', 'phaseMode']);
  const restored = readPreferences(f.root);
  assert.deepEqual([restored.userLanguage, restored.originalRuntime, restored.phaseMode], ['ja', 'available', 'normal']);
  const file = readJSON(safePath(f.root, settingsFile));
  assert.deepEqual([file.reportLanguage, file.originalRuntime, file.phaseMode], ['ja', 'available', 'normal'], 'no placeholder is copied over a value');
});

test('the dependency mappers leave out the kit\'s migration folder in both layouts and keep a package of that name', async t => {
  for (const marker of ['state/config.json', 'config.json', null]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-move-depmap-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    atomicWrite(path.join(root, 'app.py'), 'import migration.helper\n');
    atomicWrite(path.join(root, 'migration/__init__.py'), '');
    atomicWrite(path.join(root, 'migration/helper.py'), 'X = 1\n');
    atomicWrite(path.join(root, 'app.ts'), "import { x } from './migration/helper';\nexport const y = x;\n");
    atomicWrite(path.join(root, 'migration/helper.ts'), 'export const x = 1;\n');
    if (marker) atomicWrite(path.join(root, 'migration', marker), '{}\n');
    for (const [program, args, file] of [[python, ['-I', path.join(kitRoot, 'scripts/depmap_python.py')], 'migration/helper.py'],
      [process.execPath, [path.join(kitRoot, 'scripts/depmap_ts.mjs')], 'migration/helper.ts']]) {
      const out = path.join(root, `out-${path.basename(file)}`);
      const run = spawnSync(program, [...args, '--root', root, '--out', out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const order = fs.readFileSync(path.join(out, 'order.txt'), 'utf8');
      assert.equal(order.includes(file), marker === null, `${marker ?? 'no marker'}: ${file}\n${order}`);
    }
  }
});

test('status names the record that cannot be read where it is, and how to restore it', async t => {
  const f = prepare(t);
  fs.writeFileSync(safePath(f.root, configFile), '{ broken');
  let status = migrationStatus(f.root);
  assert.equal(status.ok, false);
  assert.equal(status.blockers[0].path, configFile);
  assert.match(status.nextActions[0], /^migration\/state\/config\.json is the kit's record of migration\/settings\.json and is not valid JSON: restore it/);
  oldLayout(f.root);
  status = migrationStatus(f.root);
  assert.equal(status.blockers[0].path, legacyConfigFile);
  assert.match(status.nextActions[0], /^migration\/config\.json is the kit's record of migration\/settings\.json and is not valid JSON/);
  assert.equal(statusSnapshot(f.root).blockers[0].path, legacyConfigFile, 'the fast status names the same file');
  // A value the runner refuses is corrected in the settings file.
  writeJSON(safePath(f.root, legacyConfigFile), { ...f.config, verificationMode: 'sometimes' });
  status = migrationStatus(f.root);
  assert.match(status.nextActions[0], /^Correct the setting in migration\/settings\.json \(the next kit command applies it; one the file does not hold is the kit's own, in migration\/config\.json\)/);
  // The command start reports it and leaves it where status names it, to be
  // restored there; once it reads again, the next command moves it.
  fs.writeFileSync(safePath(f.root, legacyConfigFile), '{ broken');
  const started = await settingsAtStart(f.root, list);
  assert.match(started.next, /could not be brought in step/);
  assert.equal(started.moved, undefined);
  assert.equal(fs.readFileSync(safePath(f.root, legacyConfigFile), 'utf8'), '{ broken');
  assert.equal(exists(f.root, configFile), false);
  writeJSON(safePath(f.root, legacyConfigFile), f.config);
  assert.deepEqual((await settingsAtStart(f.root, list)).moved, [`${legacyConfigFile} -> ${configFile}`]);
  assert.equal(migrationStatus(f.root).ok, true);
});

test('status names the records the next command moves while there is no settings file yet', async t => {
  const f = prepare(t);
  assert.equal(migrationStatus(f.root).settings, null, 'nothing to say');
  oldLayout(f.root);
  const status = migrationStatus(f.root);
  assert.deepEqual(status.settings, { state: 'absent', file: settingsFile, recordsToMove: [legacyConfigFile] });
  const markdown = statusMarkdown(status);
  assert.match(markdown, /Settings \(migration\/settings\.json\): not written yet\./);
  assert.match(markdown, /migration\/config\.json: the kit's records, moved into migration\/state\/ by the next command\./);
  assert.match(statusMarkdown(status, 'ja'), /設定 \(migration\/settings\.json\): まだありません。/);
  // Before phase 00 the next command moves the record and writes no file.
  const started = await settingsAtStart(f.root, list);
  assert.deepEqual(started, { moved: [`${legacyConfigFile} -> ${configFile}`] });
  assert.equal(exists(f.root, settingsFile), false);
  assert.equal(migrationStatus(f.root).settings, null);
});
