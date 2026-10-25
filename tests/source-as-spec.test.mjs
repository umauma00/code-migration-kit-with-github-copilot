// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, kitRoot } from '../scripts/install.mjs';
import { mini, python } from './helpers.mjs';
import { loadConfig, safePath, readJSON, atomicWrite } from '../lib/core.mjs';
import { runStage } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { migrationStatus, statusTodo, statusChecklist } from '../lib/status.mjs';
import { initSourceSpec, sourceSpecReadiness, contractsFile } from '../lib/source-spec.mjs';
import { failureGuidance, guidanceMarkdown } from '../lib/guidance.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { runProcess } from '../lib/process.mjs';
import { doctor } from '../scripts/run_migration.mjs';
const writeJSONFile = (root, rel, value) => atomicWrite(safePath(root, rel), `${JSON.stringify(value, null, 2)}\n`);

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
  assert.match(applied.warning, /verification mode invalidates every phase record from 00/);
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
  // src has no __init__.py: parse from src (sibling imports resolve) and re-prefix paths.
  assert.match(readiness.commands.dependencyMap, /depmap_python\.py --root src /);
  assert.match(readiness.commands.manifest, /--prefix 'src\/'/);
  assert.match(readiness.commands.reviewDependencies, /--depmap-root src /);
});

test('source-as-spec suggests the bundled mapper for each legacy language, C# before C', t => {
  const root = project(t);
  initSourceSpec(root, loadConfig(root), { apply: true });
  const config = loadConfig(root);
  const command = language => sourceSpecReadiness(root, { ...config, sourceLanguage: language }).commands.dependencyMap;
  for (const [language, script] of [['C#', 'csharp'], ['csharp', 'csharp'], ['Java', 'java'], ['PHP', 'php'], ['VB.NET', 'vbnet'], ['COBOL', 'cobol'], ['C', 'c'], ['C++', 'c'], ['JavaScript', 'ts']])
    assert.match(command(language), new RegExp(`depmap_${script}\\.(?:py|mjs) --root src `), language);
  assert.match(command('RPG'), /No bundled parser for RPG; write a deterministic adapter under migration\/tools\/ \(docs\/DEPENDENCY-MAPPERS\.md\)/);
  // VB6 and VBA are not VB.NET: depmap_vbnet.py reads .vb only and would map nothing.
  for (const language of ['VB6', 'VBA', 'Visual Basic 6', 'Visual Basic 6.0', 'Visual Basic for Applications'])
    assert.match(command(language), /^No bundled parser for /, language);
  // Visual Studio years name VB.NET: Visual Basic 2010 is not Visual Basic 2.
  for (const language of ['Visual Basic', 'Visual Basic .NET', 'Visual Basic 2008', 'Visual Basic 2010', 'Visual Basic 2022'])
    assert.match(command(language), /depmap_vbnet\.py --root src /, language);
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
  const todo = statusTodo(report, 'ja');
  assert.equal(todo.todoList.length, 10);
  // Nothing runs yet: no item is in progress, while current still names 00.
  assert.ok(todo.todoList.every(i => i.status === 'not-started'));
  assert.deepEqual(todo.current, { id: 1, phase: '00', title: '00 事前調査', state: 'not-started' });
  assert.equal(todo.todoList[0].title, '00 事前調査');
  const checklist = statusChecklist(report, 'en');
  assert.match(checklist, /^Migration flow: 0\/10 phases complete\. Current: 00 Feasibility/);
  assert.match(checklist, /▶ 00 Feasibility {2}← you are here/);
  // Started work is the one item in progress.
  phaseCommand(root, loadConfig(root), 'start', '00');
  const started = statusTodo(migrationStatus(root), 'ja').todoList;
  assert.deepEqual(started.filter(i => i.status === 'in-progress').map(i => i.title), ['00 事前調査【作業中】']);
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
  // The recommendation follows whether the original can still run; unknown asks first.
  const runtimeMessage = 'Prepare runtime judge inputs and original/mutation/parity commands';
  const runtime = failureGuidance(runtimeMessage, { root, language: 'en' });
  assert.equal(runtime.recommended, 'answer-runtime');
  // The person answers first, so there is no command line to run yet.
  assert.equal(runtime.options[0].command, undefined);
  assert.match(runtime.options[0].reason, /preferences --original-runtime available \(or unavailable\)/);
  setPreferences(root, { originalRuntime: 'unavailable' });
  const unavailable = failureGuidance(runtimeMessage, { root, language: 'en' });
  assert.equal(unavailable.recommended, 'switch-source-as-spec');
  assert.match(unavailable.options[0].command, /^node \S*scripts\/run_migration\.mjs source-spec init$/);
  setPreferences(root, { originalRuntime: 'available' });
  assert.equal(failureGuidance(runtimeMessage, { root, language: 'en' }).recommended, 'configure-runtime');
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

test('review fixes: guidance does not misroute file/diagnostic errors and never pre-fills review notes', t => {
  const root = project(t);
  for (const [message, id] of [
    ['Build failed but no diagnostic maps to a manifest target (parsed 1, unmapped 1). src/login.ts:12', 'build-failed'],
    ['Invalid review result for src/login.py', 'worker-output'],
    ['Copilot implementer failed (exit 1): session.error rate_limit 429: Rate limit exceeded', 'rate-limit'],
    ['ENOENT: no such file or directory, open migration/RULEBOOK.md', 'unknown'],
    ['spawn copilot ENOENT', 'copilot-missing'],
    ['Copilot implementer failed (exit 1): To authenticate, you can use any of the following methods', 'copilot-auth']]) {
    assert.equal(failureGuidance(message, { root, language: 'en' }).id, id, message);
  }
  // 00 is incomplete too, so the guidance leads with it, as phase next does.
  const runtime = failureGuidance('Phase 01 is not reviewed for current inputs.', { root, language: 'en' });
  assert.deepEqual(runtime.options.map(o => o.id), ['go-first', 'review-previous', 'pause'], 'no source-as-spec bundle in runtime projects');
  assert.match(runtime.options[1].command, /phase complete 00 --note "<確認した内容 \/ what you reviewed>"$/);
  const runner = failureGuidance('Phase 04 is not reviewed for current inputs.', { root, language: 'en' });
  assert.ok(!runner.options.some(o => /phase complete 04\b/.test(o.command ?? '')), 'runner phases are never recorded by hand');
  initSourceSpec(root, loadConfig(root), { apply: true });
  phaseCommand(root, loadConfig(root), 'init');
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Three files; no original runtime or spec.\n');
  phaseCommand(root, loadConfig(root), 'complete', '00', { note: 'User reviewed feasibility' });
  assert.ok(failureGuidance('Phase 01 is not reviewed for current inputs.', { root }).options.some(o => o.id === 'bundle-spec'));
});

test('review fixes: an invalid config never reads as "all phases complete"', t => {
  const root = project(t);
  fs.writeFileSync(safePath(root, 'migration/config.json'), '{bad');
  const report = migrationStatus(root);
  assert.match(statusChecklist(report, 'en'), /^Migration flow: progress cannot be determined\. Cause: migration\/config\.json/);
  const todo = statusTodo(report, 'ja');
  assert.ok(todo.blocked && todo.todoList.every(i => i.status !== 'completed' && i.description.startsWith('判定不能')));
});

test('review fixes: the bundle records nothing when a later phase is incomplete', t => {
  const root = project(t, { preparationProfile: 'source-as-spec' });
  let config = loadConfig(root);
  initSourceSpec(root, config, { apply: true }); config = loadConfig(root);
  phaseCommand(root, config, 'init');
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Three files; no original runtime or spec.\n');
  phaseCommand(root, config, 'complete', '00', { note: 'User reviewed feasibility' });
  draftPackage(root);
  fs.rmSync(safePath(root, 'migration/gap-report.md'));
  assert.throws(() => phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User OK' }), /gap-report\.md/);
  assert.equal(migrationStatus(root).workflow.next, '00b');
  for (const id of ['00b', '01', '02']) assert.equal(fs.existsSync(safePath(root, `migration/phases/${id}.json`)), false, id);
  assert.throws(() => phaseCommand(root, config, 'complete', '02,03', { note: 'x' }), /00 through 02/);
});

test('review fixes: TODO(spec) only blocks source-as-spec; a profile-only switch keeps 00-01 valid', t => {
  const root = project(t, { verificationMode: 'source-only' });
  const config = loadConfig(root);
  phaseCommand(root, config, 'init');
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Feasible.\n');
  phaseCommand(root, config, 'complete', '00', { note: 'Reviewed' });
  atomicWrite(safePath(root, 'tests/scenarios.md'), 'Scenario notes; the literal TODO(spec) is allowed here.\n');
  writeJSONFile(root, 'migration/judge-plan.json', { schemaVersion: 1, verificationMode: 'source-only', method: 'Source review', sources: ['src/main.py'],
    scenarios: [{ path: 'tests/scenarios.md', contract: 'main prints results', expectationBasis: 'source-inferred' }], unverified: ['Original not executed'] });
  atomicWrite(safePath(root, 'migration/judge-report.md'), 'Judge plan reviewed.\n');
  phaseCommand(root, config, 'complete', '00b', { note: 'Reviewed plan' });
  const preview = initSourceSpec(root, config);
  assert.match(preview.warning, /phase 02 onward/);
  initSourceSpec(root, config, { apply: true });
  const after = migrationStatus(root).workflow;
  assert.equal(after.phases.find(p => p.id === '00b').complete, true, 'profile switch keeps 00b');
});

test('review fixes: python depmap keeps a real migration package; manifest --include keeps only source roots', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depmap-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [p, text] of [['src/app/__init__.py', ''], ['src/app/migration/__init__.py', ''], ['src/app/migration/step.py', 'X = 1\n'],
    ['tests/test_app.py', 'import app\n'], ['migration/config.json', '{}'], ['migration/x.py', '']]) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text);
  }
  const map = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_python.py'), '--root', '.', '--out', 'migration/depmap'], { cwd: dir });
  assert.equal(map.code, 0, map.stderr);
  const order = fs.readFileSync(path.join(dir, 'migration/depmap/order.txt'), 'utf8');
  assert.match(order, /src\/app\/migration\/step\.py/);
  assert.doesNotMatch(order, /migration\/x\.py$/m);
  const manifest = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/make_manifest.py'), '--order', 'migration/depmap/order.txt', '--out', 'migration/manifest.tsv',
    '--include', 'src/', '--sub', 'src/=ported/', '--sub', '.py=.mjs'], { cwd: dir });
  assert.equal(manifest.code, 0, manifest.stderr);
  const rows = fs.readFileSync(path.join(dir, 'migration/manifest.tsv'), 'utf8');
  assert.match(rows, /src\/app\/migration\/step\.py\tported\/app\/migration\/step\.mjs/);
  assert.doesNotMatch(rows, /tests\//);
});

test('review fixes: doctor runs the configured hook command and fails when it points at a missing script', async t => {
  const root = project(t);
  const ok = (await doctor(root, loadConfig(root))).checks.find(c => c.check === 'hook responds before its timeout');
  assert.equal(ok.ok, true);
  assert.match(ok.command, /migration_hook\.mjs/);
  const file = safePath(root, '.github/hooks/code-migration.json'), hook = JSON.parse(fs.readFileSync(file, 'utf8'));
  hook.hooks.preToolUse[0].bash = 'node migration-kit/scripts/missing_hook.mjs';
  fs.writeFileSync(file, JSON.stringify(hook));
  assert.equal((await doctor(root, loadConfig(root))).checks.find(c => c.check === 'hook responds before its timeout').ok, false);
});
