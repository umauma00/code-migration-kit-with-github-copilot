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
import { initRunSettings, applyRunSettings, syncRunSettings, runSettingsFile, autoHandoff } from '../lib/run-settings.mjs';
import { setPreferences, readPreferences, autoModeFile } from '../lib/preferences.mjs';
import { autoModeOn } from '../lib/auto-mode.mjs';
import { interactiveDecision } from '../lib/guardrails.mjs';

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
  assert.match(switched.autoHandoff, /^初期設定が完了しました。autopilot モードに切り替えて/);
  assert.match(switched.next, /end the turn now: do not start phase 00/);
  // With a runnable original, apply itself hands over.
  const other = fresh(t, 'en');
  upToMode(other, 'auto'); runtime(other, 'available');
  const done = applyRunSettings(other, models);
  assert.match(done.autoHandoff, /^Setup is done\. Switch to autopilot mode/);
  // Once phase 00 has started, apply never hands over again.
  writeJSON(safePath(other, 'migration/phases/starts/00.json'), { schemaVersion: 1 });
  assert.equal(applyRunSettings(other, models).autoHandoff, undefined);
  // Normal and relaxed mode never carry the notice.
  for (const mode of ['normal', 'relaxed']) {
    const r = fresh(t); upToMode(r, mode);
    assert.equal(initRunSettings(r, models).setupNotice, undefined, mode);
  }
});

test('a mid-run project is past setup: no fifth question, no notice, no handoff', t => {
  for (const record of ['migration/phases/00.json', 'migration/phases/starts/00.json', 'migration/phases/waivers/00.json', 'migration/phases/starts/00b.json']) {
    const root = fresh(t);
    upToMode(root, 'auto'); runtime(root, 'unavailable');
    writeJSON(safePath(root, record), { schemaVersion: 1 });
    const init = initRunSettings(root, models);
    assert.equal(init.specificationQuestion, undefined, record);
    assert.equal(init.setupNotice, undefined, record);
    assert.doesNotMatch(init.next, /specificationQuestion/, record);
    const applied = applyRunSettings(root, models);
    assert.equal(applied.applied, true, JSON.stringify(applied.errors));
    assert.equal(applied.next, undefined, record);
    assert.equal(applied.autoHandoff, undefined, record);
    // A source-spec switch after phase 00 has started keeps its own next.
    const switched = JSON.parse(cli(root, 'source-spec', 'init', '--apply').stdout);
    assert.doesNotMatch(switched.next ?? '', /Phase 00 comes first/, record);
    assert.equal(switched.autoHandoff, undefined, record);
  }
});

test('auto mode hands over once per choice of auto, and counts what is left exactly', t => {
  const root = fresh(t);
  upToMode(root, 'auto'); runtime(root, 'unavailable');
  // Apply before the specification answer: that question and the switch are left.
  assert.match(applyRunSettings(root, models).setupNotice, /残り2回/);
  setPreferences(root, { specification: 'unavailable' });
  assert.match(applyRunSettings(root, models).setupNotice, /残り1回/);
  assert.ok(JSON.parse(cli(root, 'source-spec', 'init', '--apply').stdout).autoHandoff);
  assert.equal(typeof readJSON(safePath(root, autoModeFile)).handedOffAt, 'string');
  assert.equal(autoModeOn(root), true, 'the handoff mark keeps auto mode in effect');
  // A later apply neither repeats the handoff nor says setup is manual.
  const again = applyRunSettings(root, models);
  assert.equal(again.autoHandoff, undefined);
  assert.equal(again.setupNotice, undefined);
  assert.equal(initRunSettings(root, models).setupNotice, undefined);
  // Leaving auto and choosing it again hands over again.
  setPreferences(root, { phaseMode: 'relaxed' }); syncRunSettings(root, { keys: ['phaseMode'] });
  const back = JSON.parse(cli(root, 'preferences', '--phase-mode', 'auto').stdout);
  assert.match(back.autoHandoff, /初期設定が完了しました/);
  assert.match(back.next, /end the turn now/);
  // Choosing auto when it already is does not.
  assert.equal(JSON.parse(cli(root, 'preferences', '--phase-mode', 'auto').stdout).autoHandoff, undefined);
  // A hand-edited auto has no record and is not in effect; choosing it
  // properly, as status advises, is a new choice and hands over.
  setPreferences(root, { phaseMode: 'relaxed' }); syncRunSettings(root, { keys: ['phaseMode'] });
  const file = safePath(root, 'migration/preferences.json');
  writeJSON(file, { ...readJSON(file), phaseMode: 'auto' });
  syncRunSettings(root, { keys: ['phaseMode'] });
  assert.equal(autoModeOn(root), false);
  assert.match(JSON.parse(cli(root, 'preferences', '--phase-mode', 'auto').stdout).autoHandoff ?? '', /初期設定が完了しました/);
});

test('choosing auto after setup is applied hands over at once; during setup or after phase 00 it does not', t => {
  const root = fresh(t, 'en');
  upToMode(root, 'normal'); runtime(root, 'available');
  assert.equal(applyRunSettings(root, models).applied, true);
  const out = cli(root, 'preferences', '--phase-mode', 'auto');
  assert.equal(out.status, 0, out.stderr);
  assert.match(JSON.parse(out.stdout).autoHandoff, /Setup is done/);
  // During setup (the file is not applied yet) the handoff waits for apply.
  const early = fresh(t);
  initRunSettings(early, models, { source: 'C#', target: 'TypeScript' });
  assert.equal(JSON.parse(cli(early, 'preferences', '--phase-mode', 'auto').stdout).autoHandoff, undefined);
  // After phase 00 has started it never comes.
  const late = fresh(t);
  upToMode(late, 'normal'); runtime(late, 'available'); applyRunSettings(late, models);
  writeJSON(safePath(late, 'migration/phases/starts/00.json'), { schemaVersion: 1 });
  assert.equal(JSON.parse(cli(late, 'preferences', '--phase-mode', 'auto').stdout).autoHandoff, undefined);
});

test('the specification answer: validated everywhere, recorded unasked, and the switch runs unasked in auto mode', t => {
  const root = fresh(t);
  upToMode(root, 'auto');
  assert.equal(autoModeOn(root), true);
  const kit = 'node migration-kit/scripts/run_migration.mjs';
  const decide = command => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: root }, root);
  assert.equal(decide(`${kit} preferences --specification unavailable`), null);
  assert.equal(decide(`${kit} source-spec init --apply`), null);
  assert.equal(decide(`${kit} preferences --phase-mode auto`)?.decision, 'ask');
  const bad = cli(root, 'preferences', '--specification', 'maybe');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--specification must be one of available, unavailable, not maybe/);
  // A hand-edited invalid answer is rejected by the runner and is never auto mode.
  const file = safePath(root, 'migration/preferences.json');
  writeJSON(file, { ...readJSON(file), specification: 'maybe' });
  assert.throws(() => readPreferences(root), /specification must be available or unavailable/);
  assert.equal(autoModeOn(root), false);
});

test('a setup answer changed after the handoff still settles the verification method before phase 00', t => {
  const root = fresh(t);
  upToMode(root, 'auto'); runtime(root, 'available');
  assert.ok(applyRunSettings(root, models).autoHandoff);
  // The original turns out not to run.
  runtime(root, 'unavailable');
  const init = initRunSettings(root, models);
  assert.ok(init.specificationQuestion);
  assert.equal(init.setupNotice, undefined, 'handed off already');
  assert.match(applyRunSettings(root, models).next, /specificationQuestion before phase 00/);
  setPreferences(root, { specification: 'unavailable' });
  const applied = applyRunSettings(root, models);
  assert.match(applied.next, /switch to source-as-spec now, before phase 00/);
  assert.equal(applied.autoHandoff, undefined);
  const switched = JSON.parse(cli(root, 'source-spec', 'init', '--apply').stdout);
  assert.match(switched.next, /Phase 00 comes first/);
  assert.equal(switched.autoHandoff, undefined, 'the handoff is not repeated');
  assert.equal(readJSON(safePath(root, 'migration/config.json')).preparationProfile, 'source-as-spec');
});

test('phase 00 cannot start, complete or be waived before setup settles the verification method', t => {
  const root = fresh(t);
  upToMode(root, 'relaxed'); runtime(root, 'unavailable');
  assert.equal(applyRunSettings(root, models).applied, true);
  for (const args of [['phase', 'start', '00'], ['phase', 'complete', '00', '--note', 'Reviewed setup'], ['phase', 'waive', '00', '--note', 'later']]) {
    const out = cli(root, ...args);
    assert.notEqual(out.status, 0, args.join(' '));
    assert.match(out.stderr, /Setup is not finished: .*specificationQuestion/s, args.join(' '));
    assert.match(out.stderr, /初期設定がまだ終わっていません.*仕様書・移行先でも使える自動テストの有無に答える/s, args.join(' '));
  }
  assert.equal(fs.existsSync(safePath(root, 'migration/phases/starts/00.json')), false);
  setPreferences(root, { specification: 'unavailable' });
  assert.match(cli(root, 'phase', 'start', '00').stderr, /Setup is not finished: there is no specification.*source-spec init --apply/s);
  assert.equal(cli(root, 'source-spec', 'init', '--apply').status, 0);
  const started = cli(root, 'phase', 'start', '00');
  assert.equal(started.status, 0, started.stderr);
  // A specification that exists, or an original that runs, never blocks.
  for (const [rt, spec] of [['unavailable', 'available'], ['available', undefined]]) {
    const r = fresh(t); upToMode(r, 'normal'); runtime(r, rt);
    if (spec) setPreferences(r, { specification: spec });
    applyRunSettings(r, models);
    const out = cli(r, 'phase', 'start', '00');
    assert.equal(out.status, 0, `${rt}/${spec}: ${out.stderr}`);
  }
});

test('source-spec init --apply before settings apply does not end setup', t => {
  const root = fresh(t);
  upToMode(root, 'auto'); runtime(root, 'unavailable'); setPreferences(root, { specification: 'unavailable' });
  // The file is not applied yet (a role still differs from it).
  const file = safePath(root, runSettingsFile), settings = readJSON(file);
  settings.models.fixer = { ...settings.models.fixer, effort: 'low' };
  writeJSON(file, settings);
  const out = cli(root, 'source-spec', 'init', '--apply');
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.equal(result.autoHandoff, undefined);
  assert.match(result.next, /setup, which is not finished: run settings init/);
  assert.match(applyRunSettings(root, models).autoHandoff, /初期設定が完了しました/);
});

// Copilot CLI, the Copilot app and VS Code each switch to autopilot their own
// way, and the kit cannot tell which one runs it: the handoff says to switch
// and names no app's key, picker or command.
test('the autopilot handoff names no app-specific way to switch', () => {
  for (const language of ['ja', 'en']) {
    const text = autoHandoff(language);
    assert.match(text, /autopilot/);
    assert.match(text, language === 'ja' ? /「続けて」と送って/ : /send "continue"/);
    assert.match(text, language === 'ja' ? /切り替えなくても、ある程度は自動で進みます/ : /without switching, the run still goes on by itself/);
    assert.doesNotMatch(text, /Shift|Tab|\/autopilot|picker|一覧|Copilot CLI|VS Code|Copilot app|\n/, language);
  }
});
