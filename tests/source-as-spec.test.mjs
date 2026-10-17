// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, kitRoot } from '../scripts/install.mjs';
import { mini } from './helpers.mjs';
import { loadConfig, safePath, readJSON, atomicWrite } from '../lib/core.mjs';
import { runStage } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { migrationStatus, statusTodo, statusChecklist } from '../lib/status.mjs';
import { initSourceSpec, sourceSpecReadiness, contractsFile } from '../lib/source-spec.mjs';
import { failureGuidance, guidanceMarkdown } from '../lib/guidance.mjs';
import { runProcess } from '../lib/process.mjs';

function project(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-as-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double', ...options });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  atomicWrite(safePath(root, 'tests/README.md'), 'No original runtime; contracts live in migration/source-spec.\n');
  return root;
}
// What the AI drafts from the source before the single user review.
function draftPackage(root) {
  const file = safePath(root, contractsFile);
  atomicWrite(file, fs.readFileSync(file, 'utf8').replaceAll('TODO(spec)', 'inferred from the cited source line'));
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
}

test('installer profile implies source-only and rejects runtime', t => {
  const root = project(t, { preparationProfile: 'source-as-spec' });
  const config = readJSON(safePath(root, 'migration/config.json'));
  assert.equal(config.verificationMode, 'source-only');
  assert.equal(config.preparationProfile, 'source-as-spec');
  assert.throws(() => install(fs.mkdtempSync(path.join(os.tmpdir(), 'sas-bad-')), { model: 'm', preparationProfile: 'source-as-spec', verificationMode: 'runtime' }), /source-only/);
  const file = safePath(root, 'migration/config.json');
  fs.writeFileSync(file, JSON.stringify({ ...config, verificationMode: 'runtime' }));
  assert.throws(() => loadConfig(root), /requires verificationMode source-only/);
});

test('source-spec init previews, then switches an existing runtime project and drafts only missing files', t => {
  const root = project(t);
  const config = loadConfig(root), before = fs.readFileSync(safePath(root, 'migration/config.json'), 'utf8');
  const preview = initSourceSpec(root, config);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.changes.map(c => c.path), ['migration/config.json', 'migration/judge-plan.json', contractsFile]);
  assert.equal(fs.readFileSync(safePath(root, 'migration/config.json'), 'utf8'), before, 'preview never writes');
  const applied = initSourceSpec(root, config, { apply: true });
  assert.match(applied.warning, /invalidates earlier approvals/);
  const saved = loadConfig(root);
  assert.equal(saved.preparationProfile, 'source-as-spec');
  const plan = readJSON(safePath(root, 'migration/judge-plan.json'));
  assert.deepEqual(plan.sources, ['src/main.py', 'src/math_ops.py', 'src/text_ops.py']);
  assert.equal(plan.scenarios[0].expectationBasis, 'source-inferred');
  atomicWrite(safePath(root, contractsFile), '# kept\n');
  assert.deepEqual(initSourceSpec(root, saved, { apply: true }).changes, [], 'existing drafts are never overwritten');
  assert.equal(fs.readFileSync(safePath(root, contractsFile), 'utf8'), '# kept\n');
  const readiness = sourceSpecReadiness(root, saved);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.items.find(i => i.path === 'migration/RULEBOOK.md').status, 'template');
  assert.match(readiness.commands.dependencyMap, /depmap_python\.py --root \. /);
});

test('one user OK records 00b-02 together; unfilled contracts and gaps stop with guidance', async t => {
  const root = project(t, { preparationProfile: 'source-as-spec' });
  let config = loadConfig(root);
  initSourceSpec(root, config, { apply: true }); config = loadConfig(root);
  phaseCommand(root, config, 'init');
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Three files; no original runtime or spec.\n');
  phaseCommand(root, config, 'complete', '00', { note: 'User reviewed feasibility' });
  draftPackage(root);
  const file = safePath(root, contractsFile);
  atomicWrite(file, `${fs.readFileSync(file, 'utf8')}\n- Extra: TODO(spec)\n`);
  let error;
  try { phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User OK' }); } catch (e) { error = e; }
  assert.match(error.message, /TODO\(spec\)/);
  assert.equal(failureGuidance(error, { root, language: 'ja' }).id, 'spec-placeholder');
  assert.equal(migrationStatus(root).workflow.next, '00b', 'nothing recorded past the failing phase');
  atomicWrite(file, fs.readFileSync(file, 'utf8').replace('TODO(spec)', 'unknown; kept as TODO(port)'));
  assert.throws(() => phaseCommand(root, config, 'complete', '00b,02', { note: 'x' }), /consecutive/);
  const recorded = phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User reviewed the specification package' });
  assert.deepEqual(recorded.map(r => r.phase), ['00b', '01', '02']);
  assert.equal(sourceSpecReadiness(root, config).ready, true);
  const judge = await runStage(root, config, 'judge');
  assert.equal(judge.success, true);
  assert.equal(migrationStatus(root).workflow.next, '03');
});

test('status lists ten phases with exactly one current phase for TODO and chat', t => {
  const root = project(t);
  phaseCommand(root, loadConfig(root), 'init');
  const report = migrationStatus(root);
  const todo = statusTodo(report, 'ja').todoList;
  assert.equal(todo.length, 10);
  assert.deepEqual(todo.map(i => i.status).filter(s => s === 'in-progress'), ['in-progress']);
  assert.equal(todo[0].title, '00 事前調査');
  const checklist = statusChecklist(report, 'en');
  assert.match(checklist, /^Migration flow: 0\/10 phases complete\. Current: 00 Feasibility/);
  assert.match(checklist, /▶ 00 Feasibility {2}← you are here/);
});

test('failure guidance names the cause and recommends one of several choices with reasons', async t => {
  const root = project(t);
  for (const [message, id] of [
    ['Phase 03 requires human-installed command guardrails. Ask the human...', 'guardrails'],
    ['Phase 01 is not reviewed for current inputs. Use phase next', 'phase-order'],
    ['Prepare runtime judge inputs and original/mutation/parity commands before phase 00b review', 'runtime-judge'],
    ['spawn copilot ENOENT', 'copilot-missing'],
    ['Fix-round limit reached; review recurring problems and propose a rule amendment', 'fix-limit'],
    ['Agent call limit reached; resume with a new run after reviewing usage', 'call-limit'],
    ['something nobody anticipated', 'unknown']]) {
    const g = failureGuidance(new Error(message), { root, language: 'ja' });
    assert.equal(g.id, id, message);
    assert.ok(g.cause && g.impact);
    assert.ok(g.options.length >= 2, `${id} offers choices`);
    assert.equal(g.options.filter(o => o.recommended).length, 1);
    assert.equal(g.recommended, g.options[0].id);
    assert.ok(g.options.every(o => o.label && o.reason));
  }
  const runtime = failureGuidance('Prepare runtime judge inputs and original/mutation/parity commands', { root, language: 'en' });
  assert.equal(runtime.recommended, 'switch-source-as-spec');
  assert.match(runtime.options[0].command, /^node \S*scripts\/run_migration\.mjs source-spec init$/);
  assert.match(guidanceMarkdown(runtime, 'ja'), /（推奨）/);
  // The installed runner prints the guidance after every error.
  const script = safePath(root, 'migration-kit/scripts/run_migration.mjs');
  phaseCommand(root, loadConfig(root), 'init');
  const skipped = await runProcess(process.execPath, [script, 'phase', 'start', '04'], { cwd: root });
  assert.equal(skipped.code, 1);
  assert.match(skipped.stderr, /^ERROR: Phase 03/);
  assert.match(skipped.stderr, /## This step did not succeed[\s\S]*\(recommended\)[\s\S]*Why:/);
  const explained = await runProcess(process.execPath, [script, 'guidance', '--message', 'Unit typecheck failed; inspect receipt', '--format', 'json'], { cwd: root });
  const typecheck = JSON.parse(explained.stdout);
  assert.equal(typecheck.id, 'typecheck');
  assert.match(typecheck.options[0].command, /^node migration-kit\/scripts\/run_migration\.mjs repair /, 'installed copies cite their project-relative runner');
  assert.ok(fs.existsSync(path.join(kitRoot, 'docs/SOURCE-AS-SPEC.en.md')));
});
