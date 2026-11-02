// SPDX-License-Identifier: Apache-2.0
// 0.43.1: in a source-as-spec project, pilot prepare stopped with "Missing
// scenario input: migration/source-spec/sources.md" (found on 2026-11-02 while
// reviewing 0.42.1; 0.42.0 and 0.43.0 stop the same way). A source-only judge
// reads its plan and every file the plan names. A source-as-spec plan keeps
// its scenarios in migration/source-spec, and the copy held only the source
// roots, the verification roots and inputs, and named records, so the copy's
// inputs could not be read and pilot prepare removed it again. The copy now
// holds every file the plan names.
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

// A source-only source-as-spec project with no original runtime and no tests
// folder: 00 recorded, the specification package 00b to 02 recorded together,
// the formal judge run. memo: the plan also names a filled contract memo, as
// plans made before 0.10.0 do.
async function specProject(t, { memo = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-source-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double', preparationProfile: 'source-as-spec' });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  let config = loadConfig(root);
  initSourceSpec(root, config, { apply: true }); config = loadConfig(root);
  assert.deepEqual([config.verificationMode, config.preparationProfile], ['source-only', 'source-as-spec']);
  assert.equal(fs.existsSync(safePath(root, 'tests')), false, 'no verification root holds a scenario');
  if (memo) {
    atomicWrite(safePath(root, contractsFile), '# Source-derived contracts\n\n## src/math_ops.py\n\n- Floor division for negative operands (src/math_ops.py:4).\n');
    const plan = readJSON(safePath(root, 'migration/judge-plan.json'));
    plan.scenarios.push({ path: contractsFile, contract: 'Contracts inferred from cited source lines', expectationBasis: 'source-inferred' });
    writeJSON(safePath(root, 'migration/judge-plan.json'), plan);
  }
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
const childPath = (t, f) => { const child = `${f.root}-pilot`; t.after(() => fs.rmSync(child, { recursive: true, force: true })); return child; };
const scenarios = root => readJSON(safePath(root, 'migration/judge-plan.json')).scenarios.map(s => s.path);
// The installer's marker policy wants a counted trailer; the canned outputs carry an older one.
const worker = async call => {
  const answer = await fake(call);
  if (answer.result.kind === 'implementation') answer.result.content = `${answer.result.content.replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd()}\n// PORT STATUS: confidence=high todos=0\n`;
  return answer;
};

test('a source-as-spec pilot holds the plan\'s scenarios and runs to the end', async t => {
  const f = await specProject(t), child = childPath(t, f);
  assert.deepEqual(scenarios(f.root), [sourcesFile]);
  const plan = planPilot(f.root, f.config, { sources: ['src/main.py'] });
  assert.deepEqual([plan.scopeKind, plan.counts.total], ['with-dependencies', 3]);
  const before = { status: migrationStatus(f.root).ok, files: fs.readdirSync(f.root).sort(), index: fileHash(safePath(f.root, sourcesFile)) };
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Disposable source-as-spec pilot', expectTotal: 3 });
  assert.deepEqual(grant.sources, ['src/math_ops.py', 'src/text_ops.py', 'src/main.py']);
  // The copy holds every file the plan names, unchanged.
  for (const name of ['migration/judge-plan.json', sourcesFile, ...readJSON(safePath(f.root, 'migration/judge-plan.json')).sources])
    assert.equal(fileHash(safePath(child, name)), fileHash(safePath(f.root, name)), name);
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
  // The project itself is as before: its status, its files, its index.
  assert.deepEqual({ status: migrationStatus(f.root).ok, files: fs.readdirSync(f.root).sort(), index: fileHash(safePath(f.root, sourcesFile)) }, before);
  assert.equal(fs.existsSync(safePath(f.root, 'ported')), false);
});

test('in auto mode a source-as-spec pilot of the chosen file also holds a contract memo the plan names', async t => {
  const f = await specProject(t, { memo: true }), child = childPath(t, f);
  assert.deepEqual(scenarios(f.root), [sourcesFile, contractsFile]);
  setPreferences(f.root, { phaseMode: 'auto' });
  const plan = planPilot(f.root, f.config, { sources: ['src/math_ops.py'] });
  assert.deepEqual([plan.scopeKind, plan.counts.total], ['chosen-only', 1]);
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Auto mode: 1 chosen file', expectTotal: 1 });
  for (const name of [sourcesFile, contractsFile]) assert.equal(fileHash(safePath(child, name)), fileHash(safePath(f.root, name)), name);
  const config = loadConfig(child);
  assert.deepEqual(readManifest(child, config).map(u => u.source), ['src/math_ops.py']);
  const run = await runPilot(child, config, worker);
  assert.equal(run.pilotId, grant.id);
  const translation = run.results.find(r => r.stage === 'translation').result;
  assert.deepEqual([translation.done, translation.total, translation.errors], [1, 1, []]);
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
