import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ready, prepare, fake, modelCatalogCli } from './helpers.mjs';
import { install, kitRoot } from '../scripts/install.mjs';
import { contextHash, done, readJSON, writeJSON, safePath, loadConfig } from '../lib/core.mjs';
import { translate, runStage, approve } from '../lib/pipeline.mjs';
import { normalizeModels, setRoleModels } from '../lib/models.mjs';
import { initRunSettings, checkRunSettings, applyRunSettings, runSettingsState, syncRunSettings, runSettingsFile } from '../lib/run-settings.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';
import { detectSourceLanguages, languageQuestion } from '../lib/source-detect.mjs';

const catalog = [
  { id: 'big-model', name: 'Big Model', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium',
    billing: { tokenPrices: { inputPrice: 2, outputPrice: 8, batchSize: 1000, maxPromptTokens: 272000, longContext: { inputPrice: 4, outputPrice: 12 } } } },
  { id: 'small-model', name: 'Small Model', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'plain-model', name: 'Plain Model' },
  { id: 'blocked-model', name: 'Blocked Model', policy: { state: 'disabled' } }
];
const models = normalizeModels(catalog);

function fresh(t, language = 'ja') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, layout: 'repository', language });
  for (const dir of ['src', 'tests']) fs.mkdirSync(path.join(root, dir));
  return root;
}
const settingsOf = root => readJSON(safePath(root, runSettingsFile));
const writeSettings = (root, value) => writeJSON(safePath(root, runSettingsFile), value);
// Filled from the file settings init wrote (kept aside, since tests overwrite it).
const initial = new Map();
function filled(root) {
  if (!initial.has(root)) initial.set(root, settingsOf(root));
  const s = structuredClone(initial.get(root));
  Object.assign(s, { reportLanguage: 'ja', originalRuntime: 'available', sourceLanguage: 'C#', targetLanguage: 'TypeScript' });
  for (const role of ['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer']) s.models[role] = { model: 'small-model', effort: 'default' };
  s.models['reviewer-semantics'] = s.models['reviewer-rules'] = { model: 'big-model', effort: 'high' };
  return s;
}

test('settings init writes one file with the account\'s models as choices and placeholders where nothing was chosen', t => {
  const root = fresh(t);
  const result = initRunSettings(root, models);
  assert.equal(result.created, true);
  const s = settingsOf(root);
  assert.equal(s.reportLanguage, 'ja', 'the language asked first is already filled in');
  assert.equal(s.sourceLanguage, 'FILL_IN', 'template example languages are not presented as a choice');
  assert.equal(s.models.implementer.model, 'FILL_IN');
  assert.deepEqual(s.models.surveyor, { model: 'same-as-implementer', effort: 'default', context: 'default' });
  assert.deepEqual(s._choices.models.map(m => m.contexts), [['default', 'long_context'], ['default'], ['default']]);
  assert.deepEqual(s._choices.models.map(m => m.id), ['big-model', 'small-model', 'plain-model'], 'only enabled models are offered');
  assert.deepEqual(s._choices.models[0].efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.match(s._about, /記入した/);
  assert.match(s._help.models, /same-as-implementer/);
  assert.ok(result.pending.includes('sourceLanguage') && result.pending.includes('originalRuntime') && result.pending.includes('models.fixer.model'));
  assert.deepEqual(runSettingsState(root, readJSON(safePath(root, 'migration/config.json'))).state, 'unfilled');
});

test('settings init keeps the person\'s values and refreshes only explanations and choices', t => {
  const root = fresh(t, 'en');
  initRunSettings(root, models);
  const s = settingsOf(root);
  assert.match(s._about, /filled in/);
  s.sourceLanguage = 'Java'; s._choices.models = [];
  writeSettings(root, s);
  const again = initRunSettings(root, 'not signed in');
  assert.equal(again.refreshed, true);
  assert.equal(again.modelsListed, false);
  assert.equal(settingsOf(root).sourceLanguage, 'Java');
  assert.equal(settingsOf(root)._choices.models, 'not signed in', 'the reason the list is missing is written where the choices go');
  fs.writeFileSync(safePath(root, runSettingsFile), '{ broken');
  assert.throws(() => initRunSettings(root, models), /not valid JSON/);
});

test('settings apply reports every problem at once and writes nothing', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  filled(root);
  const config = readJSON(safePath(root, 'migration/config.json')), preferences = readJSON(safePath(root, 'migration/preferences.json'));
  let result = applyRunSettings(root, models);
  assert.equal(result.applied, false);
  for (const field of ['sourceLanguage', 'targetLanguage', 'originalRuntime', 'models.implementer.model']) assert.ok(result.errors.some(e => e.startsWith(`${field}: still FILL_IN`)), field);
  const s = filled(root);
  s.mode = 'rewrite';
  s.models.arbiter = { model: 'plain-model', effort: 'low' };
  s.models.fixer = { model: 'blocked-model', effort: 'default' };
  s.models.planner = { model: 'big-model' };
  s.colour = 'blue';
  s.reportLanguage = 'fr';
  writeSettings(root, s);
  result = applyRunSettings(root, models);
  assert.equal(result.applied, false);
  const text = result.errors.join('\n');
  assert.match(text, /reportLanguage: must be one of ja, en/);
  assert.match(text, /colour: unknown setting/);
  assert.match(text, /models\.planner: unknown role/);
  assert.match(text, /models\.arbiter: .*no selectable reasoning effort/);
  assert.match(text, /models\.fixer: .*disabled/);
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')), config, 'nothing written');
  assert.deepEqual(readJSON(safePath(root, 'migration/preferences.json')), preferences);
  // The runner's own configuration checks run on the result too.
  const roots = filled(root);
  roots.concurrency = 0;
  writeSettings(root, roots);
  assert.match(applyRunSettings(root, models).errors.join('\n'), /Invalid concurrency/);
  // Without the model list the other entries are still checked, and nothing is written.
  writeSettings(root, filled(root));
  assert.match(checkRunSettings(root, settingsOf(root), 'The Copilot CLI is not signed in').errors.join('\n'), /models: cannot check the model choices \(The Copilot CLI is not signed in\)/);
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')), config);
});

test('settings apply records a filled file in config.json and preferences.json, and status shows whether it still matches', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  const s = filled(root);
  s.models.surveyor = { model: 'same-as-implementer', effort: 'low' };
  s.commands.build = ['npm', 'run', 'build'];
  writeSettings(root, s);
  const result = applyRunSettings(root, models);
  assert.equal(result.applied, true, JSON.stringify(result.errors));
  assert.ok(result.changed.includes('sourceLanguage') && result.changed.includes('models') && result.changed.includes('originalRuntime'));
  const config = loadConfig(root);
  assert.equal(config.sourceLanguage, 'C#');
  assert.deepEqual(config.models, { implementer: 'small-model', 'reviewer-semantics': 'big-model', 'reviewer-rules': 'big-model', arbiter: 'small-model', fixer: 'small-model' });
  assert.deepEqual(config.reasoningEfforts, { 'reviewer-semantics': 'high', 'reviewer-rules': 'high', surveyor: 'low' });
  assert.equal(config.phaseModels?.survey, undefined, 'same-as-implementer keeps the surveyor on the implementer model');
  assert.deepEqual(config.commands.build, ['npm', 'run', 'build']);
  assert.equal(readJSON(safePath(root, 'migration/preferences.json')).originalRuntime, 'available');
  assert.deepEqual(runSettingsState(root, config), { state: 'applied', file: runSettingsFile });
  // A surveyor with its own model; model IDs match case-insensitively but are recorded as listed.
  s.models.surveyor = { model: 'BIG-MODEL', effort: 'xhigh' };
  writeSettings(root, s);
  assert.deepEqual(runSettingsState(root, loadConfig(root)).differs, ['models.surveyor']);
  assert.equal(applyRunSettings(root, models).applied, true);
  assert.equal(loadConfig(root).phaseModels.survey, 'big-model');
  assert.equal(runSettingsState(root, loadConfig(root)).state, 'applied');
  // An edit after apply shows in status until it is applied.
  s.concurrency = 2;
  writeSettings(root, s);
  assert.deepEqual(runSettingsState(root, loadConfig(root)), { state: 'differs', file: runSettingsFile, differs: ['concurrency'] });
  assert.match(statusMarkdown({ ...statusSnapshot(root) }, 'ja'), /実行設定（migration\/run-settings\.json）: 未反映の変更あり。settings apply で反映してください \(concurrency\)/);
  assert.deepEqual(statusSnapshot(root).runSettings.differs, ['concurrency']);
  // Applying the same file again changes nothing.
  applyRunSettings(root, models);
  assert.deepEqual(applyRunSettings(root, models).changed, []);
});

test('changing only the report language through the file keeps reviewed work', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, fake);
  const before = contextHash(f.root, f.config);
  assert.equal(done(f.root, f.units[0], before), true);
  // The fixture's model is not in the catalog; offer it so the file can name it.
  const list = normalizeModels([...catalog, { id: 'test-double', name: 'Test double' }]);
  initRunSettings(f.root, list);
  const s = settingsOf(f.root);
  assert.equal(s.models.implementer.model, 'test-double', 'chosen models are written as chosen');
  assert.equal(s.sourceLanguage, 'Python', 'a project with a manifest keeps its languages, even the template\'s');
  Object.assign(s, { reportLanguage: 'en', originalRuntime: 'available' });
  writeSettings(f.root, s);
  const result = applyRunSettings(f.root, list);
  assert.equal(result.applied, true, JSON.stringify(result.errors));
  assert.deepEqual(result.changed, ['reportLanguage', 'originalRuntime']);
  assert.equal(result.note, undefined);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, loadConfig(f.root))), true, 'preferences never revoke reviews');
  assert.equal(migrationStatus(f.root).runSettings.state, 'applied');
});

test('applying run settings asks the person; writing and checking the file do not', t => {
  const runner = 'node migration-kit/scripts/run_migration.mjs';
  assert.equal(humanGate(`${runner} settings apply`), 'settings apply');
  assert.equal(humanGate(`${runner} settings init`), null);
  assert.equal(humanGate(`${runner} settings check`), null);
  const root = fresh(t);
  const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command: `${runner} settings apply` }, cwd: root });
  assert.equal(decision.decision, 'ask');
  assert.match(decision.reason, /利用者が記入した内容/);
});

test('the runner writes, checks and applies run settings with the CLI\'s model list', t => {
  const root = fresh(t);
  const copilot = modelCatalogCli(root, catalog);
  const run = (...args) => spawnSync(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), ...args, '--copilot', copilot], { cwd: root, encoding: 'utf8' });
  let out = run('settings', 'init');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).created, true);
  out = run('settings', 'check');
  assert.equal(out.status, 1);
  assert.match(JSON.parse(out.stdout).errors.join('\n'), /sourceLanguage: still FILL_IN/);
  writeSettings(root, filled(root));
  out = run('settings', 'check');
  assert.equal(out.status, 0, out.stdout);
  out = run('settings', 'apply');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(JSON.parse(out.stdout).applied, true);
  assert.equal(readJSON(safePath(root, 'migration/config.json')).targetLanguage, 'TypeScript');
  assert.equal(fs.existsSync(safePath(root, 'migration/run.lock')), false, 'the lock is released');
});

test('applying an unchanged file never adds keys, rewrites a model\'s spelling or revokes reviews', async t => {
  // A configuration that leaves out keys the file shows with their defaults,
  // and records a model with another case than the account lists.
  const f = prepare(t);
  const config = readJSON(safePath(f.root, 'migration/config.json'));
  delete config.commands.typecheck;
  for (const key of ['verificationMode', 'executionMode']) delete config[key];
  config.models.arbiter = 'Big-Model';
  writeJSON(safePath(f.root, 'migration/config.json'), config);
  f.config = loadConfig(f.root);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  await translate(f.root, f.config, fake);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  const list = normalizeModels([...catalog, { id: 'test-double', name: 'Test double' }]);
  initRunSettings(f.root, list);
  const s = settingsOf(f.root);
  assert.equal(s.verificationMode, 'runtime');
  Object.assign(s, { reportLanguage: 'en', originalRuntime: 'available' });
  writeSettings(f.root, s);
  const result = applyRunSettings(f.root, list);
  assert.equal(result.applied, true, JSON.stringify(result.errors));
  assert.deepEqual(result.changed, ['reportLanguage', 'originalRuntime']);
  const after = readJSON(safePath(f.root, 'migration/config.json'));
  assert.equal(Object.hasOwn(after, 'verificationMode'), false);
  assert.equal(after.models.arbiter, 'Big-Model');
  assert.equal(done(f.root, f.units[0], contextHash(f.root, loadConfig(f.root))), true);
  assert.equal(runSettingsState(f.root, loadConfig(f.root)).state, 'applied');
  // An operational change alone (concurrency) is applied without the re-review note.
  s.concurrency = 3;
  writeSettings(f.root, s);
  const operational = applyRunSettings(f.root, list);
  assert.deepEqual(operational.changed, ['concurrency']);
  assert.equal(operational.note, undefined);
});

test('settings apply refuses unreadable preferences, malformed commands and a null effort before writing anything', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  const config = readJSON(safePath(root, 'migration/config.json'));
  writeSettings(root, filled(root));
  writeJSON(safePath(root, 'migration/preferences.json'), { schemaVersion: 1, userLanguage: 'ja', originalRuntime: 'maybe' });
  let result = applyRunSettings(root, models);
  assert.equal(result.applied, false);
  assert.match(result.errors.join('\n'), /originalRuntime must be available or unavailable; correct it before applying/);
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')), config, 'config.json is untouched');
  writeJSON(safePath(root, 'migration/preferences.json'), { schemaVersion: 1, userLanguage: 'ja' });
  for (const commands of [5, true, []]) {
    writeSettings(root, { ...filled(root), commands });
    assert.match(applyRunSettings(root, models).errors.join('\n'), /commands: must be an object/, JSON.stringify(commands));
  }
  const s = filled(root);
  s.models.fixer = { model: 'small-model', effort: null };
  writeSettings(root, s);
  assert.match(applyRunSettings(root, models).errors.join('\n'), /models\.fixer\.effort: must be default or one of/);
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')), config);
});

test('a file saved with a byte order mark is read like any other', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  fs.writeFileSync(safePath(root, runSettingsFile), `﻿${JSON.stringify(filled(root))}`);
  assert.equal(applyRunSettings(root, models).applied, true);
  assert.equal(runSettingsState(root, loadConfig(root)).state, 'applied');
  assert.equal(initRunSettings(root, models).refreshed, true);
});

test('re-review of 4eadc77: null commands, inherited efforts on a recorded spelling, and key order', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  writeSettings(root, { ...filled(root), commands: null });
  assert.match(applyRunSettings(root, models).errors.join('\n'), /commands: must be an object/);
  // The implementer recorded as Small-Model still supports only low/medium/high,
  // so a surveyor following it at xhigh is refused.
  const config = readJSON(safePath(root, 'migration/config.json'));
  writeSettings(root, filled(root));
  assert.equal(applyRunSettings(root, models).applied, true);
  const recorded = readJSON(safePath(root, 'migration/config.json'));
  recorded.models.implementer = 'Small-Model';
  writeJSON(safePath(root, 'migration/config.json'), recorded);
  const s = filled(root);
  s.models.surveyor = { model: 'same-as-implementer', effort: 'xhigh' };
  writeSettings(root, s);
  assert.match(applyRunSettings(root, models).errors.join('\n'), /surveyor would run small-model with reasoning effort xhigh/);
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')), recorded);
  // Commands written in another key order are not a change.
  const reordered = filled(root);
  reordered.commands = Object.fromEntries(Object.entries(recorded.commands).reverse());
  writeSettings(root, reordered);
  assert.equal(runSettingsState(root, loadConfig(root)).state, 'applied');
  const result = applyRunSettings(root, models);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(Object.keys(readJSON(safePath(root, 'migration/config.json')).commands), Object.keys(config.commands));
});

test('each role\'s context size is chosen in the file and checked against the model', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  const s = filled(root);
  s.models['reviewer-semantics'] = { model: 'big-model', effort: 'high', context: 'long_context' };
  s.models.fixer = { model: 'small-model', effort: 'default', context: 'long_context' };
  s.models.arbiter = { model: 'small-model', context: 'huge' };
  writeSettings(root, s);
  const text = applyRunSettings(root, models).errors.join('\n');
  assert.match(text, /models\.fixer: Model small-model offers no long_context tier/);
  assert.match(text, /models\.arbiter\.context: must be one of default, long_context/);
  s.models.fixer = { model: 'small-model', effort: 'default', context: 'default' };
  s.models.arbiter = { model: 'small-model', effort: 'default' };
  writeSettings(root, s);
  assert.equal(applyRunSettings(root, models).applied, true);
  assert.deepEqual(loadConfig(root).contextTiers, { 'reviewer-semantics': 'long_context' });
  assert.equal(runSettingsState(root, loadConfig(root)).state, 'applied');
  s.models['reviewer-semantics'].context = 'default';
  writeSettings(root, s);
  assert.deepEqual(runSettingsState(root, loadConfig(root)).differs, ['models.reviewer-semantics']);
  assert.equal(applyRunSettings(root, models).applied, true);
  assert.equal(loadConfig(root).contextTiers?.['reviewer-semantics'], undefined);
});

test('final review of 2edc8bf: emptied maps match models set, and runner checks join other errors', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  const s = filled(root);
  s.models.implementer = { model: 'big-model', effort: 'high', context: 'long_context' };
  writeSettings(root, s);
  assert.equal(applyRunSettings(root, models).applied, true);
  assert.deepEqual(loadConfig(root).contextTiers, { implementer: 'long_context' });
  s.models.implementer = { model: 'big-model', effort: 'default', context: 'default' };
  writeSettings(root, s);
  assert.equal(applyRunSettings(root, models).applied, true);
  const config = readJSON(safePath(root, 'migration/config.json'));
  assert.equal(Object.hasOwn(config, 'contextTiers'), false, 'an emptied map is left out, as models set leaves it');
  // The same choice recorded through models set changes nothing more.
  setRoleModels(root, models, { role: 'implementer', model: 'big-model', effort: 'default' });
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')), config);
  // A configuration error and a model error are returned together.
  s.mode = 'migrate';
  s.models.fixer = { model: 'no-such-model', effort: 'default' };
  writeSettings(root, s);
  const text = applyRunSettings(root, models).errors.join('\n');
  assert.match(text, /models\.fixer: Model no-such-model is not in your Copilot model list/);
  assert.match(text, /mode must be preserve or redesign/);
});

test('models come from one question first; the file then only needs the languages and whether the original runs', t => {
  const root = fresh(t);
  assert.match(initRunSettings(root, models).next, /models set --role all --model ID, then run settings init again/);
  setRoleModels(root, models, { role: 'all', model: 'big-model' });
  const result = initRunSettings(root, models);
  assert.deepEqual(result.pending, ['originalRuntime', 'sourceLanguage', 'targetLanguage']);
  assert.match(result.next, /Ask languages\.question as one question/, 'the languages come from one question next');
  const s = settingsOf(root);
  for (const role of ['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer']) assert.deepEqual(s.models[role], { model: 'big-model', effort: 'default', context: 'default' });
  assert.equal(s.models.surveyor.model, 'same-as-implementer');
  assert.match(s._help.models, /最初の質問で選んだモデル/);
});

test('a model or language changed from chat updates the file, so apply never writes the old choice back', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  writeSettings(root, filled(root));
  assert.equal(applyRunSettings(root, models).applied, true);
  // Unapplied edits in the file (arbiter, originalRuntime) survive a chat change of other roles.
  writeSettings(root, { ...settingsOf(root), originalRuntime: 'unavailable', models: { ...settingsOf(root).models, arbiter: { model: 'plain-model', effort: 'default', context: 'default' } } });
  const result = setRoleModels(root, models, { assign: 'implementer=small-model,reviewers=small-model:low,fixer=small-model' });
  assert.equal(syncRunSettings(root, { roles: result.updated }), runSettingsFile);
  let s = settingsOf(root);
  assert.deepEqual(s.models['reviewer-rules'], { model: 'small-model', effort: 'low', context: 'default' });
  assert.equal(s.models.arbiter.model, 'plain-model');
  assert.equal(s.originalRuntime, 'unavailable');
  assert.equal(s.sourceLanguage, 'C#', 'other entries are kept');
  // A chat choice equal to the configuration still wins over a conflicting unapplied edit.
  setRoleModels(root, models, { role: 'arbiter', model: 'small-model' });
  syncRunSettings(root, { roles: ['arbiter'] });
  writeJSON(safePath(root, 'migration/preferences.json'), { schemaVersion: 1, userLanguage: 'ja', originalRuntime: 'available' });
  syncRunSettings(root, { keys: ['originalRuntime'] });
  s = settingsOf(root);
  assert.equal(s.models.arbiter.model, 'small-model');
  assert.equal(s.originalRuntime, 'available');
  assert.equal(runSettingsState(root, loadConfig(root)).state, 'applied');
  assert.deepEqual(applyRunSettings(root, models).changed, []);
  // Unreadable preferences do not stop a model change from reaching the file.
  writeJSON(safePath(root, 'migration/preferences.json'), { schemaVersion: 1, userLanguage: 'ja', originalRuntime: 'maybe' });
  setRoleModels(root, models, { role: 'fixer', model: 'big-model' });
  assert.equal(syncRunSettings(root, { roles: ['fixer'] }), runSettingsFile);
  assert.equal(settingsOf(root).models.fixer.model, 'big-model');
  fs.writeFileSync(safePath(root, runSettingsFile), '{ broken');
  assert.equal(syncRunSettings(root, { roles: ['fixer'] }), null, 'an unreadable file is left for the person');
});

test('without a model list, settings init offers no model choices and says to sign in', t => {
  const root = fresh(t);
  const result = initRunSettings(root, 'The Copilot CLI is not signed in');
  assert.equal(result.modelsListed, false);
  assert.match(result.next, /Offer no model choices: .*copilot login/);
});

test('the runner keeps the file in step after models set', t => {
  const root = fresh(t);
  const copilot = modelCatalogCli(root, catalog);
  const run = (...args) => spawnSync(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), ...args, '--copilot', copilot], { cwd: root, encoding: 'utf8' });
  assert.equal(run('settings', 'init').status, 0);
  const out = run('models', 'set', '--role', 'all', '--model', 'big-model');
  assert.equal(out.status, 0, out.stderr);
  assert.match(JSON.parse(out.stdout).runSettings, /updated to match/);
  assert.equal(settingsOf(root).models.implementer.model, 'big-model');
});

test('an original that cannot run rules out runtime verification', t => {
  const root = fresh(t);
  initRunSettings(root, models);
  writeSettings(root, { ...filled(root), originalRuntime: 'unavailable' });
  assert.match(applyRunSettings(root, models).errors.join('\n'), /verificationMode: runtime runs the original, but originalRuntime is unavailable/);
  writeSettings(root, { ...filled(root), originalRuntime: 'unavailable', verificationMode: 'source-only' });
  const result = applyRunSettings(root, models);
  assert.equal(result.applied, true, JSON.stringify(result.errors));
  assert.equal(loadConfig(root).verificationMode, 'source-only');
});

const touch = (root, files) => { for (const f of files) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), ''); } };
const many = (dir, ext, n) => Array.from({ length: n }, (_, i) => `${dir}/f${i}${ext}`);

test('the source language is guessed from the files, leaving out dependencies, build output, tests and helper languages', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  touch(root, [...many('App/Core', '.cs', 12), ...many('Lib', '.cs', 3), ...many('wwwroot/js', '.js', 4), 'App/types.d.ts', 'db/schema.sql', 'Program.cs',
    ...many('node_modules/pkg', '.js', 50), ...many('bin/Debug', '.cs', 50), ...many('.git/hooks', '.py', 50), ...many('tests', '.cs', 5), ...many('ported', '.ts', 30)]);
  const d = detectSourceLanguages(root, { exclude: ['ported'] });
  assert.equal(d.primary, 'C#');
  assert.deepEqual(d.languages.map(l => [l.language, l.files]), [['C#', 21], ['JavaScript', 4], ['SQL', 1]], 'tests count toward the language; skipped folders and .d.ts do not');
  assert.deepEqual(d.languages[0].roots, ['App', 'Lib'], 'test folders and files at the root name no source folder');
  assert.deepEqual(d.mixed, []);
  assert.deepEqual(d.minor, ['JavaScript', 'SQL']);
  const q = languageQuestion(d, 'ja');
  assert.match(q.question, /^移行元は C#（App、Lib 配下、21 ファイル）と判定しました。JavaScript、SQLのファイルは移行元の言語として扱いません。移行先はどの言語にしますか？$/);
  assert.deepEqual(q.choices, ['TypeScript', 'Java', 'Go', 'Python'], 'the source itself is not offered as the target');
  assert.match(languageQuestion(d, 'en').question, /^The source looks like C# \(21 files in App, Lib\)\./);
});

test('two languages of comparable size are reported as mixed; a helper language never becomes the guess', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  touch(root, [...many('Cs', '.cs', 20), ...many('Vb', '.vb', 10), ...many('Sql', '.sql', 40)]);
  const d = detectSourceLanguages(root);
  assert.equal(d.primary, 'C#', 'SQL has the most files but accompanies the program');
  assert.deepEqual(d.mixed, ['VB.NET']);
  assert.deepEqual(d.minor, ['SQL']);
  assert.match(languageQuestion(d, 'ja').question, /VB\.NET（Vb 配下、10 ファイル）も同じくらいあります。キットが一度に移行できる移行元の言語は1つです。/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'source-detect-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const none = detectSourceLanguages(empty);
  assert.equal(none.primary, null);
  assert.deepEqual(languageQuestion(none, 'en').choices, [], 'with nothing found, the question asks for both languages as free text');
});

test('the language answer fills both languages and, over the template folders, the detected source folders', t => {
  const root = fresh(t);
  touch(root, many('Legacy/App', '.cs', 6));
  setRoleModels(root, models, { role: 'all', model: 'big-model' });
  const asked = initRunSettings(root, models);
  assert.equal(asked.languages.detected.primary, 'C#');
  assert.match(asked.languages.question, /移行元は C#（Legacy 配下、6 ファイル）/);
  assert.match(asked.next, /settings init --source SOURCE --target TARGET/);
  const answered = initRunSettings(root, models, { source: 'c#', target: 'TypeScript' });
  assert.equal(answered.languages, undefined);
  assert.deepEqual(answered.pending, ['originalRuntime']);
  assert.match(answered.next, /filled in/);
  const s = settingsOf(root);
  assert.equal(s.sourceLanguage, 'C#', 'the detected spelling is kept, which the bundled mapper recognizes');
  assert.equal(s.targetLanguage, 'TypeScript');
  assert.deepEqual(s.sourceRoots, ['Legacy']);
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')).sourceRoots, ['src'], 'nothing is applied until settings apply');
  // A folder the person wrote is theirs: a later answer changes only the languages.
  writeSettings(root, { ...s, sourceRoots: ['Legacy/App'] });
  initRunSettings(root, models, { source: 'VB.NET', target: 'Go' });
  assert.deepEqual([settingsOf(root).sourceLanguage, settingsOf(root).targetLanguage, settingsOf(root).sourceRoots], ['VB.NET', 'Go', ['Legacy/App']]);
  assert.throws(() => initRunSettings(root, models, { source: ' ' }), /--source must name a language/);
});

test('the runner takes the language answer on settings init', t => {
  const root = fresh(t);
  touch(root, many('Legacy', '.java', 3));
  const copilot = modelCatalogCli(root, catalog);
  const run = (...args) => spawnSync(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), ...args, '--copilot', copilot], { cwd: root, encoding: 'utf8' });
  let out = run('settings', 'init');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).languages.detected.primary, 'Java');
  out = run('settings', 'init', '--source', 'Java', '--target', 'Kotlin');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual([settingsOf(root).sourceLanguage, settingsOf(root).targetLanguage, settingsOf(root).sourceRoots], ['Java', 'Kotlin', ['Legacy']]);
});

test('review of 46230fb: monorepos, virtual environments, case, helper-only sources and typed names', t => {
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'source-detect-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
  let root = tmp();
  touch(root, [...many('packages/app/src', '.ts', 4), ...many('packages/api/src', '.ts', 4)]);
  assert.deepEqual(detectSourceLanguages(root).languages, [{ language: 'TypeScript', files: 8, roots: ['packages'] }], 'a monorepo\'s packages/ is source');
  root = tmp();
  touch(root, [...many('app', '.py', 2), ...many('env/lib/python3.12/site-packages/pkg', '.py', 20), ...many('myenv/lib/x', '.py', 20), 'myenv/pyvenv.cfg', ...many('Bin/Debug', '.py', 20)]);
  assert.deepEqual(detectSourceLanguages(root).languages, [{ language: 'Python', files: 2, roots: ['app'] }], 'virtual environments and Bin/ are skipped');
  root = tmp();
  touch(root, many('db', '.sql', 5));
  const sqlOnly = detectSourceLanguages(root);
  assert.equal(sqlOnly.primary, null, 'SQL alone names no source');
  assert.deepEqual(languageQuestion(sqlOnly, 'en').choices, []);
  const big = languageQuestion({ languages: [{ language: 'C#', files: 9, roots: ['App'] }], primary: 'C#', mixed: [], minor: [], truncated: true }, 'ja');
  assert.match(big.question, /先頭の 100000 件だけで判定しました/);
});

test('typed language names are recorded as the mappers recognize them, and missing source folders are pointed out', t => {
  let root = fresh(t);
  touch(root, many('Legacy', '.cs', 3));
  setRoleModels(root, models, { role: 'all', model: 'big-model' });
  initRunSettings(root, models, { source: 'csharp', target: 'TypeScript' });
  assert.deepEqual([settingsOf(root).sourceLanguage, settingsOf(root).sourceRoots], ['C#', ['Legacy']]);
  root = fresh(t);
  touch(root, many('Forms', '.frm', 3));
  initRunSettings(root, models, { source: 'Visual Basic', target: 'C#' });
  assert.equal(settingsOf(root).sourceLanguage, 'VB6', 'Visual Basic over .frm files is VB6, which has no bundled mapper');
  // Files only at the repository root: the template folder stays and the result says so.
  root = fresh(t);
  fs.rmSync(path.join(root, 'src'), { recursive: true });
  touch(root, ['main.py', 'util.py']);
  setRoleModels(root, models, { role: 'all', model: 'big-model' });
  const result = initRunSettings(root, models, { source: 'Python', target: 'TypeScript' });
  assert.equal(result.sourceRootsUnchosen, true);
  assert.match(result.next, /ask the person to write the source folders/);
  assert.deepEqual(settingsOf(root).sourceRoots, ['src']);
  // Re-review of 4ed07f5: a src/ holding another language is pointed out too,
  // and a source folder named env is source.
  root = fresh(t);
  touch(root, ['src/index.ts', 'main.py']);
  assert.equal(initRunSettings(root, models, { source: 'Python', target: 'Go' }).sourceRootsUnchosen, true);
  touch(root, many('env', '.ts', 3));
  assert.deepEqual(detectSourceLanguages(root).languages.find(l => l.language === 'TypeScript').roots, ['env', 'src']);
});
