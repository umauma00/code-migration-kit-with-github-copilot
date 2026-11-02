// SPDX-License-Identifier: Apache-2.0
// 0.43.1: in a source-as-spec project, pilot prepare stopped with "Missing
// scenario input: migration/source-spec/sources.md" (contracts.md for a plan
// made before 0.10.0). Found on 2026-11-02 while reviewing 0.42.1; every
// release since 0.3.0, which added source-as-spec, stops the same way. A
// source-only judge reads its plan and every file the plan names, and so do
// the input checks of a pilot's copy. A source-as-spec plan keeps its
// scenarios in migration/source-spec, which the copy did not include, so the
// copy's inputs could not be checked and pilot prepare removed it again. The
// copy now holds every file the plan names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fake, mini } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, fileHash, loadConfig, readManifest } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { install } from '../scripts/install.mjs';
import { initSourceSpec, sourcesFile, contractsFile } from '../lib/source-spec.mjs';
import { runStage, runPilot } from '../lib/pipeline.mjs';
import { planPilot, preparePilot, requirePilot } from '../lib/pilot.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { setPreferences } from '../lib/preferences.mjs';

const planFile = 'migration/judge-plan.json';
const editConfig = (root, fn) => { const c = readJSON(safePath(root, 'migration/config.json')); fn(c); writeJSON(safePath(root, 'migration/config.json'), c); };
// A source-only source-as-spec project with no original runtime: 00 recorded,
// the specification package 00b to 02 recorded together, the formal judge run.
// legacy: the plan was made before 0.10.0 and names only a filled contract
// memo (source-spec init then keeps it and adds no index). before: edits
// before phase 00 (the configuration, the plan and the files it names).
async function specProject(t, { legacy = false, before = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-source-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double', preparationProfile: 'source-as-spec' });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  if (legacy) {
    atomicWrite(safePath(root, contractsFile), '# Source-derived contracts\n\n## src/math_ops.py\n\n- Floor division for negative operands (src/math_ops.py:4).\n');
    writeJSON(safePath(root, planFile), { schemaVersion: 1, verificationMode: 'source-only', method: 'Source-as-spec contracts inferred from cited source lines',
      sources: ['src/main.py', 'src/math_ops.py', 'src/text_ops.py'],
      scenarios: [{ path: contractsFile, contract: 'Contracts inferred from cited source lines', expectationBasis: 'source-inferred' }],
      unverified: ['The original runtime was not executed; behavioral equivalence is unverified.'] });
  }
  initSourceSpec(root, loadConfig(root), { apply: true });
  before(root);
  const config = loadConfig(root);
  assert.deepEqual([config.verificationMode, config.preparationProfile], ['source-only', 'source-as-spec']);
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
  return { root, config };
}
// Adds a scenario file to the plan (in before, so the records include it).
const addScenario = (root, name, text) => {
  atomicWrite(safePath(root, name), text);
  const plan = readJSON(safePath(root, planFile));
  plan.scenarios.push({ path: name, contract: 'Contracts inferred from cited source lines', expectationBasis: 'source-inferred' });
  writeJSON(safePath(root, planFile), plan);
};
const childPath = (t, f) => { const child = `${f.root}-pilot`; t.after(() => fs.rmSync(child, { recursive: true, force: true })); return child; };
const scenarios = root => readJSON(safePath(root, planFile)).scenarios.map(s => s.path);
const planNames = root => { const plan = readJSON(safePath(root, planFile)); return [planFile, ...plan.sources, ...plan.scenarios.map(s => s.path)]; };
// Every file of the project and its hash, but the pilot grants that prepare adds.
const tree = root => Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(String).map(name => name.split(path.sep).join('/'))
  .filter(name => !name.startsWith('migration/pilots/') && fs.statSync(path.join(root, name)).isFile()).sort().map(name => [name, fileHash(path.join(root, name))]));
const grants = root => fs.existsSync(safePath(root, 'migration/pilots')) ? fs.readdirSync(safePath(root, 'migration/pilots')) : [];
// How many times fn reads each of the given files.
function readsOf(files, fn) {
  const real = files.map(file => fs.realpathSync(file)), counts = real.map(() => 0), original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string') { const i = real.indexOf(path.resolve(file)); if (i >= 0) counts[i]++; }
    return original.call(this, file, ...rest);
  };
  try { fn(); } finally { fs.readFileSync = original; }
  return counts;
}
// The installer's marker policy wants a counted trailer; the canned outputs carry an older one.
const worker = async call => {
  const answer = await fake(call);
  if (answer.result.kind === 'implementation') answer.result.content = `${answer.result.content.replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd()}\n// PORT STATUS: confidence=high todos=0\n`;
  return answer;
};

test('a source-as-spec pilot holds the plan\'s scenarios and runs to the end, leaving the project as it was', async t => {
  const f = await specProject(t), child = childPath(t, f);
  assert.deepEqual(scenarios(f.root), [sourcesFile]);
  assert.equal(fs.existsSync(safePath(f.root, 'tests')), false, 'no verification root holds a scenario');
  const plan = planPilot(f.root, f.config, { sources: ['src/main.py'] });
  assert.deepEqual([plan.scopeKind, plan.counts.total], ['with-dependencies', 3]);
  const before = tree(f.root);
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Disposable source-as-spec pilot', expectTotal: 3 });
  assert.deepEqual(grant.sources, ['src/math_ops.py', 'src/text_ops.py', 'src/main.py']);
  // The copy holds every file the plan names, unchanged.
  for (const name of planNames(f.root)) assert.equal(fileHash(safePath(child, name)), fileHash(safePath(f.root, name)), name);
  const config = loadConfig(child);
  assert.equal(requirePilot(child, config).id, grant.id);
  assert.equal(migrationStatus(child).ok, true);

  const run = await runPilot(child, config, worker);
  assert.equal(run.productionCompletion, false);
  assert.equal(run.results.find(r => r.stage === 'judge').result.success, true, 'the copy\'s source-only judge reads its scenarios');
  const translation = run.results.find(r => r.stage === 'translation').result;
  assert.deepEqual([translation.done, translation.total, translation.errors, translation.scopeComplete], [3, 3, [], true]);
  const status = migrationStatus(child);
  assert.deepEqual([status.purpose, status.done, status.total, status.blockers], ['pilot', 3, 3, []]);
  // The project gained the grant and nothing else.
  assert.equal(migrationStatus(f.root).ok, true);
  assert.deepEqual(tree(f.root), before);
  assert.deepEqual(grants(f.root), [`${grant.id}.json`]);
});

test('in auto mode a pilot of the chosen file in a plan made before 0.10.0 holds its contract memo', async t => {
  const f = await specProject(t, { legacy: true }), child = childPath(t, f);
  assert.deepEqual(scenarios(f.root), [contractsFile]);
  assert.equal(fs.existsSync(safePath(f.root, sourcesFile)), false, 'source-spec init kept the plan and added no index');
  setPreferences(f.root, { phaseMode: 'auto' });
  const plan = planPilot(f.root, f.config, { sources: ['src/math_ops.py'] });
  assert.deepEqual([plan.scopeKind, plan.counts.total], ['chosen-only', 1]);
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Auto mode: 1 chosen file', expectTotal: 1 });
  for (const name of planNames(f.root)) assert.equal(fileHash(safePath(child, name)), fileHash(safePath(f.root, name)), name);
  const config = loadConfig(child);
  assert.deepEqual(readManifest(child, config).map(u => u.source), ['src/math_ops.py']);
  const run = await runPilot(child, config, worker);
  assert.equal(run.pilotId, grant.id);
  const translation = run.results.find(r => r.stage === 'translation').result;
  assert.deepEqual([translation.done, translation.total, translation.errors], [1, 1, []]);
});

test('a source-as-spec pilot through smoke type-checks, builds and runs the copy', async t => {
  const ok = [process.execPath, '-e', 'console.log("ok")'];
  const f = await specProject(t, { before: root => editConfig(root, c => { c.commands.build = ok; c.commands.smoke = ok; c.commands.typecheck = [process.execPath, '--check', '{target}']; }) });
  const child = childPath(t, f);
  preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], through: 'smoke', note: 'Disposable source-as-spec pilot through smoke' });
  const run = await runPilot(child, loadConfig(child), worker);
  assert.deepEqual(run.results.map(r => r.stage), ['judge', 'translation', 'build', 'smoke']);
  for (const { stage, result } of run.results) assert.notEqual(result.success, false, stage);
  assert.equal(run.results.find(r => r.stage === 'translation').result.done, 3);
  assert.deepEqual(migrationStatus(child).blockers, []);
});

test('plan files the folder walk skips are copied, but a file inside a .git folder stops pilot plan and prepare', async t => {
  // node_modules and __pycache__ folders are skipped by the walk of the copied roots.
  const skipped = 'tests/node_modules/contract.md';
  const f = await specProject(t, { before: root => addScenario(root, skipped, 'Contracts inferred from src/math_ops.py:4.\n') }), child = childPath(t, f);
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable source-as-spec pilot' });
  assert.equal(fileHash(safePath(child, skipped)), fileHash(safePath(f.root, skipped)));
  assert.ok(requirePilot(child, loadConfig(child)));

  // A pilot never copies a .git folder: the plan names one of its files.
  const inGit = 'tests/fixture/.git/config';
  const g = await specProject(t, { before: root => addScenario(root, inGit, '[remote "origin"]\n\turl = https://example.invalid/repo.git\n') }), other = childPath(t, g);
  const refusal = new RegExp(`^Error: Pilot cannot copy ${inGit.replace(/[.]/g, '\\.')}: the source-only judge plan names it, and a pilot never copies a file inside a \\.git folder\\. Remove it from the plan's sources or scenarios; phase next then says what to record again$`);
  assert.throws(() => planPilot(g.root, g.config, { sources: ['src/math_ops.py'] }), refusal);
  const before = tree(g.root);
  assert.throws(() => preparePilot(g.root, g.config, { target: other, sources: ['src/math_ops.py'], note: 'Disposable source-as-spec pilot' }), refusal);
  assert.equal(fs.existsSync(other), false);
  assert.deepEqual([tree(g.root), grants(g.root)], [before, []]);
});

test('the copied scenarios are sealed like the other inputs of a pilot', async t => {
  const f = await specProject(t), child = childPath(t, f);
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable source-as-spec pilot' });
  const config = loadConfig(child), copy = safePath(child, sourcesFile), original = fs.readFileSync(copy, 'utf8');
  assert.ok(requirePilot(child, config));
  // An edit in the copy changes what the copy checks.
  fs.appendFileSync(copy, '- src/extra.py\n');
  assert.throws(() => requirePilot(child, config), /Pilot scope or sealed inputs changed/);
  atomicWrite(copy, original);
  assert.ok(requirePilot(child, config));
  // An edit in the project changes what the pilot was prepared on.
  fs.appendFileSync(safePath(f.root, sourcesFile), '\nReviewed again.\n');
  assert.throws(() => requirePilot(child, config), /Pilot parent preparation or judge changed; prepare a new isolated pilot/);
});

test('a plan changed while the copy is made stops prepare with that cause and leaves no copy or grant', async t => {
  const f = await specProject(t), child = childPath(t, f), original = fs.mkdirSync;
  let edited = false;
  // When prepare creates the copy, after it listed the files to copy.
  fs.mkdirSync = function (dir, ...rest) {
    if (!edited && !rest.length && path.basename(String(dir)) === path.basename(child)) {
      edited = true;
      addScenario(f.root, 'migration/source-spec/notes.md', 'A note on src/main.py:1.\n');
    }
    return original.call(this, dir, ...rest);
  };
  try {
    assert.throws(() => preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable source-as-spec pilot' }),
      /^Error: Parent inputs changed while preparing the pilot$/);
  } finally { fs.mkdirSync = original; }
  assert.equal(edited, true);
  assert.equal(fs.existsSync(child), false);
  assert.deepEqual(grants(f.root), []);
});

test('listing the plan\'s files reads no source of the project again', async t => {
  const f = await specProject(t), child = childPath(t, f);
  const files = ['src/main.py', 'src/math_ops.py', sourcesFile].map(name => safePath(f.root, name));
  // Each is read 4 times: for the project's context, for the copy, for the
  // check of the project after the copy, and by requirePilot.
  const counts = readsOf(files, () => preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable source-as-spec pilot' }));
  assert.deepEqual(counts, [4, 4, 4]);
});
