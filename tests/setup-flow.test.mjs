// SPDX-License-Identifier: Apache-2.0
// Setup settles the verification method before phase 00, and auto mode tells
// the person setup is manual until it hands over to autopilot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { modelCatalogCli } from './helpers.mjs';
import { install, kitRoot } from '../scripts/install.mjs';
import { readJSON, writeJSON, safePath } from '../lib/core.mjs';
import { normalizeModels, setRoleModels } from '../lib/models.mjs';
import { initRunSettings, applyRunSettings, syncRunSettings, runSettingsFile } from '../lib/run-settings.mjs';
import { setPreferences, readPreferences } from '../lib/preferences.mjs';

const catalog = [{ id: 'm', name: 'M', supportedReasoningEfforts: ['low', 'high'] }];
const models = normalizeModels(catalog);
function fresh(t, language = 'ja') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, layout: 'repository', language });
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/App.cs'), 'class App {}\n');
  setRoleModels(root, models, { role: 'all', model: 'm' });
  return root;
}
const settingsOf = root => readJSON(safePath(root, runSettingsFile));
// Answers the questions up to the phase mode, as the orchestrator would.
function upToMode(root, mode) {
  initRunSettings(root, models, { source: 'C#', target: 'TypeScript' });
  setPreferences(root, { phaseMode: mode }); syncRunSettings(root, { keys: ['phaseMode'] });
}
const runtime = (root, value) => { setPreferences(root, { originalRuntime: value }); syncRunSettings(root, { keys: ['originalRuntime'] }); };
const cli = (root, ...args) => spawnSync(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), ...args, '--copilot', modelCatalogCli(root, catalog)], { cwd: root, encoding: 'utf8' });

test('normal mode: an original that runs needs no fifth question, no notice and no handoff', t => {
  const root = fresh(t);
  upToMode(root, 'normal');
  runtime(root, 'available');
  const init = initRunSettings(root, models);
  assert.equal(init.specificationQuestion, undefined);
  assert.equal(init.setupNotice, undefined);
  assert.match(init.next, /filled in/);
  const applied = applyRunSettings(root, models);
  assert.equal(applied.applied, true, JSON.stringify(applied.errors));
  assert.equal(applied.next, undefined);
  assert.equal(applied.autoHandoff, undefined);
});

test('no runnable original and no specification: asked fifth, and source-as-spec is applied during setup with phase 00 next', t => {
  const root = fresh(t);
  upToMode(root, 'normal');
  runtime(root, 'unavailable');
  const asked = initRunSettings(root, models);
  assert.match(asked.next, /Ask specificationQuestion as one question.*preferences --specification available\|unavailable/s);
  assert.match(asked.specificationQuestion.question, /仕様書/);
  assert.deepEqual(asked.specificationQuestion.choices.map(c => c.value), ['available', 'unavailable']);
  // Applying before answering points back to the question.
  assert.match(applyRunSettings(root, models).next, /specificationQuestion before phase 00/);
  const out = cli(root, 'preferences', '--specification', 'unavailable');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(readPreferences(root).specification, 'unavailable');
  assert.equal(initRunSettings(root, models).specificationQuestion, undefined, 'answered once');
  const applied = applyRunSettings(root, models);
  assert.match(applied.next, /switch to source-as-spec now, before phase 00.*source-spec init --apply/s);
  const switched = cli(root, 'source-spec', 'init', '--apply');
  assert.equal(switched.status, 0, switched.stderr);
  const result = JSON.parse(switched.stdout);
  assert.match(result.next, /Phase 00 comes first/);
  assert.equal(result.autoHandoff, undefined, 'normal mode has no handoff');
  assert.equal(readJSON(safePath(root, 'migration/config.json')).preparationProfile, 'source-as-spec');
  // A specification that exists keeps the profile as it was.
  const other = fresh(t);
  upToMode(other, 'normal'); runtime(other, 'unavailable');
  setPreferences(other, { specification: 'available' });
  assert.equal(applyRunSettings(other, models).next, undefined);
  assert.throws(() => setPreferences(other, { specification: 'maybe' }), /available or unavailable/);
});

test('auto mode: every setup step says it is still manual, and setup ends with the autopilot handoff before phase 00', t => {
  const root = fresh(t);
  upToMode(root, 'auto');
  const fourth = initRunSettings(root, models);
  assert.match(fourth.setupNotice, /自動モードを選択済みです。初期設定が終わるまでは手動.*autopilot はまだ使えません。初期設定の確認は残り\d+回ほど/);
  const before = Number(fourth.setupNotice.match(/残り(\d+)回/)[1]);
  runtime(root, 'unavailable');
  const fifth = initRunSettings(root, models);
  assert.ok(fifth.specificationQuestion);
  assert.ok(Number(fifth.setupNotice.match(/残り(\d+)回/)[1]) < before, 'the count goes down as questions are answered');
  setPreferences(root, { specification: 'unavailable' });
  const filled = initRunSettings(root, models);
  assert.match(filled.next, /filled in/);
  assert.ok(filled.setupNotice);
  const applied = applyRunSettings(root, models);
  assert.equal(applied.applied, true, JSON.stringify(applied.errors));
  assert.ok(applied.setupNotice, 'the source-as-spec confirmation is still manual');
  assert.equal(applied.autoHandoff, undefined, 'no handoff before the switch');
  const switched = JSON.parse(cli(root, 'source-spec', 'init', '--apply').stdout);
  assert.match(switched.autoHandoff, /初期設定が完了しました。ここから autopilot が使えます。Shift\+Tab/);
  assert.match(switched.next, /end the turn now: do not start phase 00/);
  // With a runnable original, apply itself hands over.
  const other = fresh(t, 'en');
  upToMode(other, 'auto'); runtime(other, 'available');
  const done = applyRunSettings(other, models);
  assert.match(done.autoHandoff, /Setup is done, and autopilot can be used from here/);
  // Once phase 00 has started, apply never hands over again.
  writeJSON(safePath(other, 'migration/phases/starts/00.json'), { schemaVersion: 1 });
  assert.equal(applyRunSettings(other, models).autoHandoff, undefined);
  // Normal and relaxed mode never carry the notice.
  for (const mode of ['normal', 'relaxed']) {
    const r = fresh(t); upToMode(r, mode);
    assert.equal(initRunSettings(r, models).setupNotice, undefined, mode);
  }
});
