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
import { normalizeModels } from '../lib/models.mjs';
import { initRunSettings, checkRunSettings, applyRunSettings, runSettingsState, runSettingsFile } from '../lib/run-settings.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';

const catalog = [
  { id: 'big-model', name: 'Big Model', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' },
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
  assert.deepEqual(s.models.surveyor, { model: 'same-as-implementer', effort: 'default' });
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
  Object.assign(s, { reportLanguage: 'en', originalRuntime: 'unavailable' });
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
