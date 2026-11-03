// SPDX-License-Identifier: Apache-2.0
// 0.45.0: a settings change sends back only the work it can change. Until
// 0.44.x every record (a finished unit, an approval, a run, a record of
// phase 02 or later) held one hash of everything the kit read, the models
// and every command included, so changing a model, a command or a test made
// every finished unit be reviewed again. A record is now bound to what its
// work depends on (lib/core.mjs inputContext): a finished unit, an approval
// and the records of phases 02 and later to the content (sources, rules,
// languages, folders...), a run to the content, the test inputs and its own
// commands. The records of 0.44.x stay current through the update
// (migration/state/context-upgrade.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare, fake, scopesOf, throughSmoke as through, holding as state, allHolding as everything, modelCatalogCli } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, fileHash, loadConfig, inputContext, settingsEffect, legacyContextHash, legacyContextParts,
  readContextUpgrade, contextUpgradeFile, contentConfig, done, unitState, readRepairIntent, repairIntentPath } from '../lib/core.mjs';
import { judgeInputHash, legacyJudgeInputHash } from '../lib/judge.mjs';
import { approve, runStage, translate, requireGate } from '../lib/pipeline.mjs';
import { phaseStaleness } from '../lib/phases.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { makeRepairQueue } from '../scripts/diagnostic_queue.mjs';
import { recordContextUpgrade } from '../lib/context-upgrade.mjs';
import { settingsAtStart, settingsFile, settingsHelpFile, settingsBaseFile, legacySettingsFile, legacySettingsHelpFile } from '../lib/settings.mjs';
import { normalizeModels } from '../lib/models.mjs';
import { preparePilot, requirePilot } from '../lib/pilot.mjs';
import { migrationStatus } from '../lib/status.mjs';

const configPath = f => safePath(f.root, 'migration/state/config.json');
const write = (f, name, value) => atomicWrite(safePath(f.root, name), value);
const edit = (f, change) => { const before = readJSON(configPath(f)), after = structuredClone(before); change(after); writeJSON(configPath(f), after); return { before, after }; };
const models = async () => normalizeModels([{ id: 'test-double', name: 'Test double' }, { id: 'another-model', name: 'Another model' }]);

test('how the work is done keeps every record: models, efforts, context tiers, the review procedure and the per-unit typecheck', async t => {
  const f = await through(t);
  assert.deepEqual(state(f), everything(2));
  const scopes = scopesOf(f.root, f.config);
  const changes = {
    'models.fixer': c => { c.models.fixer = 'another-model'; },
    phaseModels: c => { c.phaseModels = { survey: 'another-model', judgeAudit: 'another-model' }; },
    reasoningEfforts: c => { c.reasoningEfforts = { implementer: 'high' }; },
    contextTiers: c => { c.contextTiers = { arbiter: 'long_context' }; },
    fixPolicy: c => { c.fixPolicy = 'single-pass'; },
    reviewFocus: c => { c.reviewFocus = 'shared'; },
    dependencyOrder: c => { c.dependencyOrder = 'auto'; },
    maxReviewInputBytes: c => { c.maxReviewInputBytes = 2097152; },
    'commands.typecheck': c => { c.commands.typecheck = null; },
    workerBackend: c => { c.workerBackend = 'copilot-cli'; },
    concurrency: c => { c.concurrency = 1; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const { before, after } = edit(f, change), config = loadConfig(f.root);
    assert.equal(scopesOf(f.root, config), scopes, name);
    assert.deepEqual(state(f, config), everything(2), name);
    assert.equal(settingsEffect(before, after), null, name);
  }
  let calls = 0;
  const report = await translate(f.root, loadConfig(f.root), async args => { calls++; return fake(args); });
  assert.equal(calls, 0, 'nothing to review again');
  assert.equal(report.done, 2);
});

test('a command change sends back that run, its approval and the runs after it; units, the runs before it and phases stay', async t => {
  const f = await through(t);
  // The build command: build is approved and runs again, then smoke.
  const build = edit(f, c => { c.commands.build = [process.execPath, '-e', 'console.log("build v2")']; });
  assert.equal(settingsEffect(build.before, build.after), 'This changes how the build run checks the migration: build, smoke and parity are approved and run again. Finished units are kept.');
  let config = loadConfig(f.root);
  assert.deepEqual(state(f, config), { ...everything(2), gates: { translation: true, build: 'build approval is stale; inputs or outputs changed', smoke: 'Run build successfully for the current inputs first' },
    records: { judge: true, build: false, smoke: false } });
  assert.equal(phaseCommand(f.root, config, 'next').next, '05');
  await assert.rejects(runStage(f.root, config, 'build'), /build approval is stale; inputs or outputs changed/, 'a changed command runs only once it is approved');
  approve(f.root, config, 'build', 'Reviewed the new build command'); await runStage(f.root, config, 'build');
  assert.throws(() => requireGate(f.root, config, 'smoke', inputContext(f.root, config)), /No smoke approval/, 'a run removes the approvals after it');
  approve(f.root, config, 'smoke', 'Fixture snapshot after the new build command'); await runStage(f.root, config, 'smoke');
  assert.deepEqual(state(f, config), everything(2));
  // The smoke command: only smoke, from its approval.
  const smoke = edit(f, c => { c.commands.smoke = [process.execPath, '-e', 'console.log("smoke v2")']; });
  assert.equal(settingsEffect(smoke.before, smoke.after), 'This changes how the smoke run checks the migration: smoke and parity are approved and run again. Finished units are kept.');
  config = loadConfig(f.root);
  assert.deepEqual(state(f, config), { ...everything(2), gates: { translation: true, build: true, smoke: 'smoke approval is stale; inputs or outputs changed' },
    records: { judge: true, build: true, smoke: false } });
  // Put back, the smoke approval and run hold again.
  writeJSON(configPath(f), smoke.before);
  assert.deepEqual(state(f), everything(2));
  edit(f, c => { c.commands.smoke = smoke.after.commands.smoke; });
  // The original command: the judge, so 00b's judge inputs and the translation approval; units stay.
  const original = edit(f, c => { c.commands.original = [process.execPath, '-e', 'console.log("original v2")']; });
  assert.equal(settingsEffect(original.before, original.after), 'This changes how the judge and parity runs check the migration: the judge runs again, build, smoke and parity are approved and run again, ' +
    'the phases from 00b are checked and recorded again (phase next says which), and translation is approved again. Finished units are kept.');
  config = loadConfig(f.root);
  const now = state(f, config);
  assert.deepEqual(now.units, [true, true]);
  assert.deepEqual(now.records, { judge: false, build: false, smoke: false });
  assert.deepEqual(now.phases, { '00': true, '00b': false, '01': false, '02': false, '03': false });
  assert.equal(phaseStaleness(f.root, config, '00b').reasons[0].kind, 'judge-inputs');
  assert.equal(phaseStaleness(f.root, config, '02').action, 'record-again', 'only the record before it changed');
  // The test settings: every run. The verification mode and folders are
  // named by every phase record too, so the note says the phases from 00.
  const c = original.after;
  assert.equal(settingsEffect(c, { ...c, verificationInputs: ['tools/env.json'] }), 'This changes how the judge, build, smoke and parity runs check the migration: the judge runs again, ' +
    'build, smoke and parity are approved and run again, the phases from 00b are checked and recorded again (phase next says which), and translation is approved again. Finished units are kept.');
  assert.match(settingsEffect(c, { ...c, verificationRoots: ['tests', 'more-tests'] }), /parity are approved and run again, the phases from 00 are checked and recorded again \(phase next says which\), and translation is approved again\./);
  // To source-only: the runs of that mode, handoff instead of parity.
  assert.equal(settingsEffect(c, { ...c, verificationMode: 'source-only' }), 'This changes how the judge, build and smoke runs check the migration: the judge runs again, ' +
    'build, smoke and handoff are approved and run again, the phases from 00 are checked and recorded again (phase next says which), and translation is approved again. Finished units are kept.');
  assert.equal(settingsEffect(c, { ...c, verificationMode: 'runtime' }), null, 'the default written out is no change');
  // The build outputs: every run (the judge reads them), and phase 03, which names the judge's record.
  assert.equal(settingsEffect(c, { ...c, buildArtifactRoots: ['dist'] }), 'This changes how the judge, build, smoke and parity runs check the migration: the judge runs again, ' +
    'build, smoke and parity are approved and run again, phase 03 is recorded again after the judge, and translation is approved again. Finished units are kept.');
  // In source-only mode a build command change ends with handoff.
  const so = { ...c, verificationMode: 'source-only' };
  assert.equal(settingsEffect(so, { ...so, commands: { ...so.commands, build: [process.execPath, '-e', 'console.log("build v3")'] } }),
    'This changes how the build run checks the migration: build, smoke and handoff are approved and run again. Finished units are kept.');
});

test('a parity command change sends back the parity approval and run and the phases from 00b; the other approvals and units hold once they are recorded again', async t => {
  const f = await through(t);
  approve(f.root, f.config, 'parity', 'Fixture snapshot before the parity command change');
  const parity = edit(f, c => { c.commands.parity = [process.execPath, '-e', 'console.log("parity v2")']; });
  assert.equal(settingsEffect(parity.before, parity.after),
    'This changes how the parity run checks the migration: parity is approved and run again, and the phases from 00b are checked and recorded again (phase next says which). Finished units are kept.');
  const config = loadConfig(f.root), now = state(f, config);
  assert.deepEqual(now.units, [true, true]);
  assert.deepEqual(now.records, { judge: true, build: true, smoke: true }, 'the runs before parity keep their records');
  assert.deepEqual(now.phases, { '00': true, '00b': false, '01': false, '02': false, '03': false });
  assert.match(now.gates.translation, /Phase 03's record is out of date because phase 00b's record is/);
  for (const id of ['00b', '01', '02', '03']) phaseCommand(f.root, config, 'complete', id, { note: 'Recorded again after the parity command change' });
  assert.deepEqual(state(f, config), everything(2), 'translation, build and smoke are not approved again');
  assert.throws(() => requireGate(f.root, config, 'parity', inputContext(f.root, config)), /parity approval is stale; inputs or outputs changed/, 'the new parity command is approved before it runs');
});

test('a test change sends back the judge and what follows it, and keeps the finished units', async t => {
  const f = await through(t);
  write(f, 'tests/judge.py', `${fs.readFileSync(safePath(f.root, 'tests/judge.py'), 'utf8')}\n# A case added after translation.\n`);
  const config = loadConfig(f.root), now = state(f, config);
  assert.deepEqual(now.units, [true, true]);
  assert.deepEqual(now.records, { judge: false, build: false, smoke: false });
  assert.deepEqual(now.phases, { '00': true, '00b': false, '01': false, '02': false, '03': false });
  assert.equal(phaseStaleness(f.root, config, '00b').action, 'redo');
  for (const phase of ['01', '02', '03']) assert.equal(phaseStaleness(f.root, config, phase).action, 'record-again', phase);
  // 00b to 02 recorded again, the judge run again, 03 recorded again and
  // translation approved again: the finished units were made from what did
  // not change, so none runs again.
  for (const id of ['00b', '01', '02']) phaseCommand(f.root, config, 'complete', id, { note: 'Recorded again for the added test case' });
  await runStage(f.root, config, 'judge');
  phaseCommand(f.root, config, 'complete', '03', { note: 'Recorded again for the added test case' });
  approve(f.root, config, 'translation', 'Approved again after the added test case');
  let calls = 0;
  await translate(f.root, config, async args => { calls++; return fake(args); });
  assert.equal(calls, 0);
  assert.deepEqual(state(f, config).units, [true, true]);
});

test('a change of what the migration produces still sends every finished unit back', async t => {
  const f = await through(t);
  const target = edit(f, c => { c.targetLanguage = 'TypeScript'; });
  assert.match(settingsEffect(target.before, target.after), /^This changes what the migration produces: finished units are reviewed again/);
  const config = loadConfig(f.root), now = state(f, config);
  assert.deepEqual(now.units, [false, false]);
  assert.match(now.gates.translation, /stale|out of date/);
  assert.equal(now.phases['02'], false);
  // Put back, everything holds again.
  writeJSON(configPath(f), target.before);
  assert.deepEqual(state(f), everything(2));
  // A source edit is content too: the whole source tree, as before 0.45.0.
  fs.appendFileSync(safePath(f.root, f.units[0].source), '\n# Changed after translation.\n');
  assert.deepEqual(state(f).units, [false, false]);
});

test('the content and run scopes ignore how a setting is written: absent, null, empty and a written-out default are the same', t => {
  const f = prepare(t);
  const scopes = scopesOf(f.root, f.config);
  for (const [name, change] of Object.entries({
    verificationMode: c => { c.verificationMode = 'runtime'; }, preparationProfile: c => { c.preparationProfile = 'standard'; },
    verificationInputs: c => { c.verificationInputs = []; }, designInputs: c => { c.designInputs = []; }, phaseModels: c => { c.phaseModels = {}; },
    reorder: c => { const entries = Object.entries(c).reverse(); for (const [k] of entries) delete c[k]; Object.assign(c, Object.fromEntries(entries)); }
  })) {
    const { after } = edit(f, change);
    assert.equal(scopesOf(f.root, loadConfig(f.root)), scopes, name);
    assert.deepEqual(Object.keys(contentConfig(after)), Object.keys(contentConfig(after)).sort(), name);
  }
});

// The records as 0.44.x wrote them: each holds the one hash of all inputs
// (legacyContextHash), the 00b record and the judge preparation the schema 2
// fingerprint, each phase record names the one before it, and a record that
// names another one (phase 03 names the judge's) names it as rewritten.
const before = { '00b': '00', '01': '00b', '02': '01', '03': '02', '05c': '03', '06': '03' };
function toLegacy(f) {
  const config = loadConfig(f.root), L = legacyContextHash(f.root, config), P = legacyContextParts(f.root, config), J = legacyJudgeInputHash(f.root, config);
  const rewritten = new Set();
  const rewrite = (name, change) => { const file = safePath(f.root, name); if (!fs.existsSync(file)) return; const r = readJSON(file); change(r); writeJSON(file, r); rewritten.add(name); };
  for (const unit of f.units) rewrite(`migration/state/units/${unit.id}.json`, r => { r.contextHash = L; });
  const gates = safePath(f.root, 'migration/gates');
  for (const name of fs.existsSync(gates) ? fs.readdirSync(gates) : []) rewrite(`migration/gates/${name}`, r => { r.contextHash = L; });
  for (const stage of ['judge', 'build', 'smoke', 'parity', 'handoff']) rewrite(`migration/results/${stage}.json`, r => { r.contextHash = L; });
  rewrite('migration/results/judge-preparation.json', r => { r.inputHash = J; delete r.inputSchema; });
  for (const phase of ['00b', '01', '02', '03', '05c', '06']) {
    const name = `migration/phases/${phase}.json`, previous = safePath(f.root, `migration/phases/${before[phase]}.json`);
    rewrite(name, r => {
      if (phase === '00b') Object.assign(r, { judgeInputHash: J, judgeInputSchema: 2 });
      if (['02', '03', '05c', '06'].includes(phase)) { Object.assign(r, { contextHash: L, contextParts: P }); delete r.contextScope; }
      r.predecessorHash = fileHash(previous);
      r.evidence = r.evidence.map(([p, h]) => [p, rewritten.has(p) ? fileHash(safePath(f.root, p)) : h]);
    });
  }
  fs.rmSync(safePath(f.root, contextUpgradeFile), { force: true });
  return { L, J };
}

test('records of 0.44.x hold through the update, and after it as only the 0.45.0 ones do', async t => {
  const f = await through(t), { L, J } = toLegacy(f);
  // Before any command of this kit: what the records stand for is read now.
  assert.deepEqual(state(f), everything(2));
  // The first command writes it down, before it can change anything.
  assert.deepEqual(recordContextUpgrade(f.root), { file: contextUpgradeFile, added: ['contexts', 'judgeInput'] });
  const upgrade = readContextUpgrade(f.root), context = inputContext(f.root, f.config);
  assert.deepEqual(upgrade.contexts.map(e => e.legacy), [L]);
  assert.equal(upgrade.contexts[0].content, context.content);
  assert.deepEqual(upgrade.judgeInput, { legacy: J, current: judgeInputHash(f.root, f.config) });
  assert.equal(recordContextUpgrade(f.root), null, 'written once');
  assert.deepEqual(state(f), everything(2));
  // A model change keeps them, as it keeps those of this kit.
  edit(f, c => { c.models.fixer = 'another-model'; c.fixPolicy = 'single-pass'; });
  assert.notEqual(legacyContextHash(f.root, loadConfig(f.root)), L, 'the old formula would have revoked them');
  assert.deepEqual(state(f), everything(2));
  // A build command naming a file of its own: only build, from its approval,
  // and what follows it. The 00b record (schema 2 named every command's
  // files) holds.
  write(f, 'tools/build.mjs', 'process.exit(0);\n');
  edit(f, c => { c.commands.build = [process.execPath, 'tools/build.mjs']; });
  const config = loadConfig(f.root);
  assert.notEqual(legacyJudgeInputHash(f.root, config), J);
  assert.deepEqual(state(f, config), { ...everything(2), gates: { translation: true, build: 'build approval is stale; inputs or outputs changed', smoke: 'Run build successfully for the current inputs first' },
    records: { judge: true, build: false, smoke: false } });
  // An old record already out of date stays out of date: a source edit.
  fs.appendFileSync(safePath(f.root, f.units[1].source), '\n# Changed after the update.\n');
  assert.deepEqual(state(f, config).units, [false, false]);
  assert.match(phaseStaleness(f.root, config, '02').next, /Phase 02 was recorded, then source files under sourceRoots changed|redo|phase start 02/);
});

test('an old record made before a copy update replaced the kit\'s agent files holds when a phase record shows nothing else changed', async t => {
  const f = await through(t), { L } = toLegacy(f);
  for (const name of fs.readdirSync(safePath(f.root, '.github/agents'))) fs.appendFileSync(safePath(f.root, `.github/agents/${name}`), '\n<!-- a newer kit -->\n');
  const config = loadConfig(f.root);
  assert.notEqual(legacyContextHash(f.root, config), L, 'the old hash of now differs');
  assert.deepEqual(state(f, config), everything(2));
  recordContextUpgrade(f.root);
  assert.ok(readContextUpgrade(f.root).contexts.some(e => e.legacy === L));
  edit(f, c => { c.models.implementer = 'another-model'; });
  assert.deepEqual(state(f), everything(2));
  // Without such a phase record nothing tells what the old hash stood for.
  const g = await through(t);
  toLegacy(g);
  for (const phase of ['02', '03']) {
    const file = safePath(g.root, `migration/phases/${phase}.json`), r = readJSON(file);
    r.contextParts = { ...r.contextParts, source: '0'.repeat(64) };
    writeJSON(file, r);
  }
  fs.appendFileSync(safePath(g.root, '.github/agents/migration-fixer.agent.md'), '\n<!-- a newer kit -->\n');
  assert.deepEqual(state(g).units, [false, false]);
});

test('the first command writes down what the old records stand for before it applies an edit of the settings file', async t => {
  const f = await through(t);
  await settingsAtStart(f.root, models);
  assert.ok(fs.existsSync(safePath(f.root, settingsFile)), 'the file is written from the configuration');
  // Filled in, as the person does during setup.
  writeJSON(safePath(f.root, settingsFile), { ...readJSON(safePath(f.root, settingsFile)), reportLanguage: 'en', originalRuntime: 'available', phaseMode: 'normal' });
  assert.ok((await settingsAtStart(f.root, models)).changed);
  const { L } = toLegacy(f);
  const settings = readJSON(safePath(f.root, settingsFile));
  settings.models.fixer = { ...settings.models.fixer, model: 'another-model' };
  writeJSON(safePath(f.root, settingsFile), settings);
  const started = await settingsAtStart(f.root, models);
  assert.deepEqual(started.applied, ['models.fixer'], JSON.stringify(started));
  assert.equal(loadConfig(f.root).models.fixer, 'another-model');
  assert.equal(readContextUpgrade(f.root).contexts[0].legacy, L);
  assert.deepEqual(state(f), everything(2));
});

test('a pilot prepared by 0.44.x holds through the update and a model change, and ends when a command changes', async t => {
  const f = prepare(t, { count: 2 });
  f.config.phasePolicy = 'strict';
  writeJSON(configPath(f), f.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) write(f, name, 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await runStage(f.root, f.config, 'judge');
  const child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable pilot fixture', through: 'translation' });
  // As 0.44.x wrote them: the parent's records and the grant hold one hash each.
  const childConfig = loadConfig(child), parentL = legacyContextHash(f.root, f.config), childL = legacyContextHash(child, childConfig);
  const legacyGrant = { ...grant, parentContext: parentL, context: childL };
  delete legacyGrant.parentStages; delete legacyGrant.stages;
  toLegacy({ ...f, units: [] });
  writeJSON(safePath(f.root, 'migration/results/judge.json'), { ...readJSON(safePath(f.root, 'migration/results/judge.json')), contextHash: parentL });
  writeJSON(safePath(f.root, `migration/pilots/${grant.id}.json`), { ...legacyGrant, phase02Hash: fileHash(safePath(f.root, 'migration/phases/02.json')), judgeHash: fileHash(safePath(f.root, 'migration/results/judge.json')) });
  fs.copyFileSync(safePath(f.root, `migration/pilots/${grant.id}.json`), safePath(child, 'migration/pilot.json'));
  assert.ok(requirePilot(child, childConfig));
  // The pilot's command start writes down both projects' old hashes first.
  await settingsAtStart(child, models);
  assert.ok(readContextUpgrade(f.root)?.contexts.some(e => e.legacy === parentL));
  assert.ok(readContextUpgrade(child)?.contexts.some(e => e.legacy === childL));
  edit(f, c => { c.models.fixer = 'another-model'; c.fixPolicy = 'single-pass'; });
  assert.ok(requirePilot(child, loadConfig(child)));
  edit(f, c => { c.commands.build = [process.execPath, '-e', 'console.log("build v2")']; });
  assert.throws(() => requirePilot(child, loadConfig(child)), /Pilot parent preparation or judge changed; prepare a new isolated pilot/);
});

test('a pilot grant seals the copy\'s tests and commands, not its models', async t => {
  const f = prepare(t, { count: 2 });
  f.config.phasePolicy = 'strict';
  writeJSON(configPath(f), f.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) write(f, name, 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await runStage(f.root, f.config, 'judge');
  const child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable pilot fixture', through: 'translation' });
  const childFile = safePath(child, 'migration/state/config.json'), original = readJSON(childFile);
  writeJSON(childFile, { ...original, models: { ...original.models, implementer: 'another-model' } });
  assert.ok(requirePilot(child, loadConfig(child)));
  writeJSON(childFile, { ...original, commands: { ...original.commands, smoke: [process.execPath, '-e', 'console.log("smoke v2")'] } });
  assert.throws(() => requirePilot(child, loadConfig(child)), /Pilot scope or sealed inputs changed/);
  writeJSON(childFile, original);
  assert.ok(requirePilot(child, loadConfig(child)));
  fs.appendFileSync(safePath(child, 'tests/judge.py'), '\n# Edited in the copy.\n');
  assert.throws(() => requirePilot(child, loadConfig(child)), /Pilot scope or sealed inputs changed/);
});

// As 0.44.x laid the project out: the kit's records beside the settings
// file, which has its old name, and no record of what was applied.
function oldLayout(f) {
  for (const [from, to] of [['migration/state/config.json', 'migration/config.json'], ['migration/state/preferences.json', 'migration/preferences.json'],
    [settingsFile, legacySettingsFile], [settingsHelpFile, legacySettingsHelpFile]]) if (fs.existsSync(safePath(f.root, from))) fs.renameSync(safePath(f.root, from), safePath(f.root, to));
  fs.rmSync(safePath(f.root, settingsBaseFile), { force: true });
}
// Set up as setup leaves it: the settings file written, filled in and applied.
async function filledIn(f) {
  await settingsAtStart(f.root, models);
  writeJSON(safePath(f.root, settingsFile), { ...readJSON(safePath(f.root, settingsFile)), reportLanguage: 'en', originalRuntime: 'available', phaseMode: 'normal' });
  await settingsAtStart(f.root, models);
}

test('models set, settings apply or preferences as the first command after the update keep the records of 0.44.x', async t => {
  const catalog = [{ id: 'test-double', name: 'Test double' }, { id: 'another-model', name: 'Another model' }];
  const firsts = {
    'models set': run => run('models', 'set', '--role', 'fixer', '--model', 'another-model'),
    'settings apply': (run, f) => {
      const file = safePath(f.root, legacySettingsFile), settings = readJSON(file);
      settings.models.fixer = { ...settings.models.fixer, model: 'another-model' };
      writeJSON(file, settings);
      return run('settings', 'apply');
    },
    preferences: run => run('preferences', '--language', 'ja')
  };
  for (const [name, first] of Object.entries(firsts)) {
    const f = await through(t);
    await filledIn(f);
    const { L } = toLegacy(f);
    oldLayout(f);
    assert.deepEqual(state(f), everything(2), `${name}: right after the update`);
    const copilot = modelCatalogCli(f.root, catalog);
    const run = (...args) => spawnSync(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), ...args, '--copilot', copilot], { cwd: f.root, encoding: 'utf8' });
    const out = first(run, f);
    assert.equal(out.status, 0, `${name}: ${out.stderr}${out.stdout}`);
    assert.deepEqual(readContextUpgrade(f.root)?.contexts?.map(e => e.legacy), [L], `${name}: written down before the change`);
    if (name !== 'preferences') assert.equal(loadConfig(f.root).models.fixer, 'another-model', name);
    // The next command that does work starts like this.
    await settingsAtStart(f.root, models);
    assert.deepEqual(state(f), everything(2), name);
  }
});

test('an input the first command cannot read: the record of that moment is kept, so a model changed meanwhile keeps the records of 0.44.x', async t => {
  const f = await through(t);
  await filledIn(f);
  const { L } = toLegacy(f);
  const manifest = safePath(f.root, 'migration/manifest.tsv');
  fs.renameSync(manifest, `${manifest}.away`);
  const settings = readJSON(safePath(f.root, settingsFile));
  settings.models.fixer = { ...settings.models.fixer, model: 'another-model' };
  writeJSON(safePath(f.root, settingsFile), settings);
  const started = await settingsAtStart(f.root, models);
  assert.deepEqual(started.applied, ['models.fixer']);
  const waiting = readContextUpgrade(f.root);
  assert.equal(waiting.contexts, null, 'the old hash cannot be read without the manifest');
  assert.ok(waiting.judgeInput, 'the part that could be read is written');
  assert.equal(waiting.config.models.fixer, 'test-double', 'the record as it was before the change');
  fs.renameSync(`${manifest}.away`, manifest);
  assert.notEqual(legacyContextHash(f.root, loadConfig(f.root)), L, 'the formula of now would have revoked them');
  assert.deepEqual(state(f), everything(2), 'read from the record of that moment');
  // The next command that can read it writes it down from that record.
  assert.equal(recordContextUpgrade(f.root).added[0], 'contexts');
  const upgrade = readContextUpgrade(f.root);
  assert.deepEqual(upgrade.contexts.map(e => e.legacy), [L]);
  assert.equal(upgrade.config, undefined, 'no longer needed');
  assert.deepEqual(state(f), everything(2));
  // An input that changed meanwhile still sends back what depends on it.
  fs.appendFileSync(safePath(f.root, f.units[0].source), '\n# Changed after the update.\n');
  assert.deepEqual(state(f).units, [false, false]);
});

// A repair round admitted from build diagnostics and stopped after its first
// unit: one unit repaired under it, one waiting.
async function repairing(t) {
  const f = await through(t);
  edit(f, c => { c.concurrency = 1; });
  write(f, 'migration/build-diagnostics.tsv', 'file\tmodule\tcode\tmessage\n' + f.units.map((u, i) => `${u.target}\tslice-${i}\tCHECK\tExplicit diagnostic for ${u.target}\n`).join(''));
  makeRepairQueue(f.root, loadConfig(f.root), { diagnostics: 'migration/build-diagnostics.tsv' });
  return f;
}
test('an admitted repair ends when the run its queue came from changes; the unit it repaired stays done, the other keeps its review', async t => {
  const f = await repairing(t), controller = new AbortController();
  await assert.rejects(translate(f.root, loadConfig(f.root), fake, { repairQueue: 'migration/repair-queue.json', signal: controller.signal,
    onProgress: e => { if (e.stage === 'done') controller.abort(); } }), /Interrupted/);
  let config = loadConfig(f.root), context = inputContext(f.root, config);
  const intent = readRepairIntent(f.root, context);
  assert.deepEqual([intent.stage, intent.stageHash], ['build', context.stages.build]);
  const pending = migrationStatus(f.root).pendingRepairs;
  assert.equal(pending.length, 1);
  const repaired = f.units.find(u => !pending.includes(u.target)), waiting = f.units.find(u => pending.includes(u.target));
  assert.equal(unitState(f.root, repaired).repairIntentId, intent.id);
  // How the work is done, or another run's command: the repair goes on.
  edit(f, c => { c.models.fixer = 'another-model'; c.commands.smoke = [process.execPath, '-e', 'console.log("smoke v2")']; });
  config = loadConfig(f.root); context = inputContext(f.root, config);
  assert.equal(readRepairIntent(f.root, context)?.id, intent.id);
  assert.deepEqual([done(f.root, repaired, context), done(f.root, waiting, context)], [true, false]);
  // The build command: the diagnostics may no longer stand, so the repair ends.
  edit(f, c => { c.commands.build = [process.execPath, '-e', 'console.log("build v2")']; });
  config = loadConfig(f.root); context = inputContext(f.root, config);
  assert.equal(readRepairIntent(f.root, context), null);
  assert.deepEqual([done(f.root, repaired, context), done(f.root, waiting, context)], [true, true]);
  assert.deepEqual(migrationStatus(f.root).pendingRepairs ?? [], []);
  await assert.rejects(translate(f.root, config, fake, { repairQueue: 'migration/repair-queue.json' }), /Repair queue is missing or stale for the current build run/);
  approve(f.root, config, 'build', 'Reviewed the new build command');
  assert.equal((await runStage(f.root, config, 'build')).success, true);
});

test('a repair admitted by 0.44.x holds through the update and a model change, and ends when any run that makes queues changes', async t => {
  const f = await repairing(t);
  await assert.rejects(translate(f.root, loadConfig(f.root), fake, { repairQueue: 'migration/repair-queue.json',
    onProgress: e => { if (e.stage === 'repair-planned') throw new Error('Simulated stop before worker dispatch'); } }), /before worker dispatch/);
  // As 0.44.x wrote it: the one hash, and no run named.
  const { L } = toLegacy(f), refFile = safePath(f.root, 'migration/state/repair.json'), ref = readJSON(refFile), file = repairIntentPath(f.root, ref.id), r = readJSON(file);
  delete r.stage; delete r.stageHash;
  writeJSON(file, { ...r, contextHash: L });
  writeJSON(refFile, { ...ref, checksum: fileHash(file) });
  recordContextUpgrade(f.root);
  assert.equal(readRepairIntent(f.root, inputContext(f.root, loadConfig(f.root)))?.id, ref.id);
  assert.deepEqual(state(f).units, [false, false], 'both wait for their repair');
  edit(f, c => { c.models.fixer = 'another-model'; });
  assert.equal(readRepairIntent(f.root, inputContext(f.root, loadConfig(f.root)))?.id, ref.id, 'a model change keeps it');
  edit(f, c => { c.commands.smoke = [process.execPath, '-e', 'console.log("smoke v2")']; });
  assert.equal(readRepairIntent(f.root, inputContext(f.root, loadConfig(f.root))), null, 'it names no run, so a change of any run that makes queues ends it');
  assert.deepEqual(state(f).units, [true, true]);
});

test('a source-only project, which runs no judge command, keeps every record when one changes', async t => {
  const f = await through(t);
  write(f, 'tests/scenarios.md', 'Scenario notes.\n');
  writeJSON(safePath(f.root, 'migration/judge-plan.json'), { schemaVersion: 1, verificationMode: 'source-only', method: 'Source review', sources: f.units.map(u => u.source),
    scenarios: [{ path: 'tests/scenarios.md', contract: 'The functions keep their results', expectationBasis: 'source-inferred' }], unverified: ['Original not executed'] });
  edit(f, c => { c.verificationMode = 'source-only'; });
  const scopes = scopesOf(f.root, loadConfig(f.root)), judge = judgeInputHash(f.root, loadConfig(f.root));
  for (const key of ['original', 'mutation', 'parity']) {
    const { before, after } = edit(f, c => { c.commands[key] = [process.execPath, '-e', `console.log("${key} v2")`]; });
    assert.equal(settingsEffect(before, after), null, key);
    assert.equal(scopesOf(f.root, loadConfig(f.root)), scopes, key);
    assert.equal(judgeInputHash(f.root, loadConfig(f.root)), judge, `${key}: phase 00b's fingerprint`);
  }
  // A runtime project runs them: the same change sends the judge back.
  edit(f, c => { c.verificationMode = 'runtime'; });
  const runtime = { scopes: scopesOf(f.root, loadConfig(f.root)), judge: judgeInputHash(f.root, loadConfig(f.root)) };
  edit(f, c => { c.commands.original = [process.execPath, '-e', 'console.log("original v3")']; });
  assert.notEqual(scopesOf(f.root, loadConfig(f.root)), runtime.scopes);
  assert.notEqual(judgeInputHash(f.root, loadConfig(f.root)), runtime.judge);
});

test('a test setting no phase record names keeps phases 00 to 02, and phase 03 is recorded again once the judge has run', async t => {
  const f = await through(t);
  edit(f, c => { c.buildArtifactRoots = ['dist']; });
  let config = loadConfig(f.root), now = state(f, config);
  assert.deepEqual([now.units, now.phases, now.records], [[true, true], { '00': true, '00b': true, '01': true, '02': true, '03': true }, { judge: false, build: false, smoke: false }]);
  assert.match(now.gates.translation, /Run judge successfully for the current inputs first/);
  await runStage(f.root, config, 'judge');
  now = state(f, config);
  assert.deepEqual(now.phases, { '00': true, '00b': true, '01': true, '02': true, '03': false }, 'phase 03 names the judge\'s record');
  phaseCommand(f.root, config, 'complete', '03', { note: 'Recorded again after the judge ran with the build outputs left out' });
  approve(f.root, config, 'translation', 'Approved again after the judge ran again');
  let calls = 0;
  await translate(f.root, config, async args => { calls++; return fake(args); });
  assert.equal(calls, 0, 'no unit is reviewed again');
  for (const stage of ['build', 'smoke']) { approve(f.root, config, stage, 'Fixture snapshot'); await runStage(f.root, config, stage); }
  assert.deepEqual(state(f, config), everything(2));
});
