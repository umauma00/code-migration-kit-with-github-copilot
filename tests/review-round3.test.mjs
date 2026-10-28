// SPDX-License-Identifier: Apache-2.0
// Third review round: upstream fidelity, parallel resilience, progress and
// failure guidance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare, ready, fake, result, finding, mini } from './helpers.mjs';
import { install, kitRoot } from '../scripts/install.mjs';
import { loadConfig, safePath, writeJSON, readJSON, atomicWrite, done, contextHash, unitState } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { migrationStatus, statusChecklist } from '../lib/status.mjs';
import { interactiveDecision, humanGate } from '../lib/guardrails.mjs';
import { decisionOutput } from '../scripts/migration_hook.mjs';
import { pairFindings } from '../lib/review.mjs';
import { isTransientFailure, isSystemicFailure } from '../lib/failures.mjs';
import { failureGuidance, failureGuidanceList, doctorGuidance } from '../lib/guidance.mjs';
import { setPreferences, readPreferences } from '../lib/preferences.mjs';
import { sourceSpecReadiness } from '../lib/source-spec.mjs';
import { runProcess } from '../lib/process.mjs';

const fixture = (t, options) => {
  const f = prepare(t, options);
  Object.assign(f.config, { transientRetryDelayMs: 1 });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  return f;
};
const approved = async f => { await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Round-3 fixture'); };
const lastSummary = f => {
  const runs = fs.readdirSync(safePath(f.root, 'migration/runs')).sort();
  return readJSON(safePath(f.root, `migration/runs/${runs.at(-1)}/summary.json`));
};

test('hook: agents cannot write guardrails.json; approvals and phase records ask the person', t => {
  const f = prepare(t), root = f.root;
  const shell = command => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: root });
  assert.equal(shell('cp migration-kit/templates/guardrails.json migration/guardrails.json').decision, 'deny');
  assert.equal(shell('echo {} > migration/guardrails.json').decision, 'deny');
  assert.equal(shell('cat migration/guardrails.json'), null);
  for (const command of ['node migration-kit/scripts/run_migration.mjs approve translation --note ok',
    'node migration-kit/scripts/run_migration.mjs --root . phase complete 00 --note "reviewed scope"',
    "bash -c 'node /abs/kit/scripts/run_migration.mjs approve build --note ok'",
    'node migration-kit/scripts/run_migration.mjs pilot prepare --target /tmp/x --sources src/a.py --note ok',
    'node migration-kit/scripts/run_migration.mjs source-spec init --apply']) assert.equal(shell(command)?.decision, 'ask', command);
  for (const command of ['node migration-kit/scripts/run_migration.mjs status --format markdown', 'node migration-kit/scripts/run_migration.mjs source-spec init',
    'node migration-kit/scripts/run_migration.mjs phase next']) assert.equal(shell(command), null, command);
  const write = (toolName, toolArgs) => interactiveDecision({ toolName, toolArgs, cwd: root });
  assert.equal(write('create', { path: 'migration/guardrails.json', file_text: '{}' }).decision, 'deny');
  assert.equal(write('replace_string_in_file', { filePath: path.join(root, 'migration/guardrails.json') }).decision, 'deny');
  assert.equal(write('apply_patch', { input: '*** Begin Patch\n*** Update File: migration/guardrails.json\n*** End Patch' }).decision, 'deny');
  assert.equal(write('create', { path: 'migration/notes.md', file_text: 'mentions migration/guardrails.json only' }), null, 'text mentions are fine');
  assert.equal(humanGate('node x/run_migration.mjs approve smoke --note ok'), 'approve smoke');
  const ask = decisionOutput({ decision: 'ask', reason: 'confirm' });
  assert.deepEqual([ask.permissionDecision, ask.hookSpecificOutput.permissionDecision], ['ask', 'ask']);
  // Through the installed hook script too.
  const r = spawnSync(process.execPath, [safePath(root, 'migration-kit/scripts/migration_hook.mjs')], { cwd: root, encoding: 'utf8',
    input: JSON.stringify({ toolName: 'bash', toolArgs: { command: 'node migration-kit/scripts/run_migration.mjs approve build --note ok' } }), env: { ...process.env, MIGRATION_KIT_ROLE: '' } });
  assert.equal(JSON.parse(r.stdout).permissionDecision, 'ask');
});

test('phase 01 refuses an all-empty dependency map unless independence is confirmed; 02 refuses untouched templates', t => {
  const f = prepare(t, { count: 3 });
  Object.assign(f.config, { phasePolicy: 'strict' }); writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  for (const [p, text] of [['migration/judge-report.md', 'judge'], ['migration/depmap/report.md', 'map'], ['migration/gap-report.md', 'gap']]) atomicWrite(safePath(f.root, p), `${text}\n`);
  phaseCommand(f.root, f.config, 'init');
  phaseCommand(f.root, f.config, 'complete', '00', { note: 'reviewed' });
  phaseCommand(f.root, f.config, 'complete', '00b', { note: 'reviewed' });
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: { 'src/math_ops.py': [], 'src/text_ops.py': [], 'src/main.py': [] } });
  assert.throws(() => phaseCommand(f.root, f.config, 'complete', '01', { note: 'reviewed' }), /declares no dependencies between 3 manifest files/);
  assert.equal(failureGuidance('Review dependency map declares no dependencies between 3 manifest files.', { root: f.root }).id, 'no-dependencies');
  const r = phaseCommand(f.root, f.config, 'complete', '01', { note: 'Scripts are independent', 'confirm-no-dependencies': true });
  assert.equal(r.confirmedNoDependencies, true);
  fs.copyFileSync(path.join(kitRoot, 'templates/RULEBOOK.md'), safePath(f.root, 'migration/RULEBOOK.md'));
  assert.throws(() => phaseCommand(f.root, f.config, 'complete', '02', { note: 'reviewed' }), /still the installed template/);
  atomicWrite(safePath(f.root, 'migration/RULEBOOK.md'), '# Rules for this project\nFloor division.\n');
  fs.copyFileSync(path.join(kitRoot, 'templates/inventory.tsv'), safePath(f.root, 'migration/inventory.tsv'));
  assert.throws(() => phaseCommand(f.root, f.config, 'complete', '02', { note: 'reviewed' }), /template example rows/);
  assert.equal(failureGuidance('migration/inventory.tsv still contains the template example rows.', { root: f.root }).id, 'template-rules');
});

test('depmap commands follow the import base: src layout re-prefixes, a package root parses from its parent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depmap-base-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'm' });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  const config = loadConfig(root);
  const flat = sourceSpecReadiness(root, config).commands;
  assert.match(flat.dependencyMap, /--root src /);
  for (const command of [flat.dependencyMap, flat.manifest.replace(".SOURCE_EXT=.TARGET_EXT", '.py=.mjs'), flat.reviewDependencies]) {
    const r = await runProcess('bash', ['-c', command], { cwd: root });
    assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  }
  assert.match(fs.readFileSync(safePath(root, 'migration/manifest.tsv'), 'utf8'), /^source\ttarget\nsrc\/math_ops\.py\tported\/math_ops\.js/m);
  assert.deepEqual(readJSON(safePath(root, 'migration/review-dependencies.json')).dependencies['src/main.py'], ['src/math_ops.py', 'src/text_ops.py']);
  fs.writeFileSync(safePath(root, 'src/__init__.py'), '');
  const pkg = sourceSpecReadiness(root, config).commands;
  assert.match(pkg.dependencyMap, /--root \. /);
  assert.match(pkg.manifest, /--include 'src\/'/);
  assert.doesNotMatch(pkg.manifest, /--prefix/);
});

test('findings at the same source line still go to the arbiter, which keeps one side of a conflict', async t => {
  const f = fixture(t); await approved(f);
  const calls = [], fixerInputs = [], arbiterInputs = [];
  let round = 0;
  // Same line, opposite changes: citing one place is not agreeing on the fix.
  const conflict = { ...finding, id: 'R1', message: 'Round the quotient toward zero' };
  await translate(f.root, f.config, async args => {
    calls.push(args.role);
    if (args.role.startsWith('reviewer-') && round === 0) return { result: result(args.role, args.unit, { findings: [args.role === 'reviewer-rules' ? conflict : finding] }) };
    if (args.role === 'arbiter') {
      arbiterInputs.push(args.extra);
      return { result: result(args.role, args.unit, { decisions: args.extra.findings.map(x => ({ finding: x.reference, confirmed: x.reference === 'reviewer-semantics:F1', reason: x.evidence })) }) };
    }
    if (args.role === 'fixer') { fixerInputs.push(args.extra.confirmedFindings.map(x => x.reference)); round++; }
    return fake(args);
  });
  assert.equal(calls.filter(r => r === 'arbiter').length, 1);
  assert.deepEqual(arbiterInputs[0].findings.map(x => x.reference), ['reviewer-semantics:F1', 'reviewer-rules:R1']);
  assert.deepEqual(arbiterInputs[0].samePlace, [['reviewer-semantics:F1', 'reviewer-rules:R1']]);
  assert.deepEqual(fixerInputs, [['reviewer-semantics:F1']], 'only the confirmed side reaches the fixer');
  assert.ok(done(f.root, f.units[0], contextHash(f.root, f.config)));
  const pair = pairFindings({ 'reviewer-semantics': { result: { findings: [finding, { ...finding, id: 'F2', evidence: 'src/math_ops.py:9 other' }] } },
    'reviewer-rules': { result: { findings: [{ ...finding, evidence: 'see ./src/math_ops.py:4' }] } } });
  assert.deepEqual(pair.findings.map(x => x.reference), ['reviewer-semantics:F1', 'reviewer-semantics:F2', 'reviewer-rules:F1']);
  assert.deepEqual(pair.samePlace, [['reviewer-semantics:F1', 'reviewer-rules:F1']]);
});

test('a failing in-loop typecheck becomes a confirmed finding for the fixer', async t => {
  const f = fixture(t); await approved(f);
  let fixer = null, implemented = false;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer') { implemented = true; return { result: result(args.role, args.unit, { content: 'this is not valid JavaScript !' }) }; }
    if (args.role === 'fixer') fixer = args.extra.confirmedFindings;
    return fake(args);
  });
  assert.ok(implemented);
  assert.equal(report.done, 1);
  assert.equal(fixer[0].reference, 'typecheck:TC1');
  assert.match(fixer[0].message, /Unit typecheck failed/);
});

test('transient failures retry; unit failures stay isolated; systemic failures and failure streaks stop the run', async t => {
  assert.equal(isTransientFailure(new Error('Copilot implementer failed (exit 1): 429 Too Many Requests')), true);
  assert.equal(isTransientFailure(new Error('Copilot worker timed out after 600 s')), false);
  assert.equal(isSystemicFailure(new Error('Copilot reviewer-rules failed (exit 1): To authenticate, you can use any of the following methods')), true);
  const f = fixture(t, { count: 3 }); f.config.concurrency = 3; f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config); await approved(f);
  let flaky = 0;
  const error = await translate(f.root, f.config, async args => {
    if (args.unit.target.includes('text_ops') && args.role === 'implementer' && flaky++ < 2) throw new Error('Copilot implementer failed (exit 1): 503 Service Unavailable');
    if (args.unit.target.includes('math_ops') && args.role === 'reviewer-rules') throw new Error('Agent did not return one valid JSON object');
    return fake(args);
  }).catch(e => e);
  const context = contextHash(f.root, f.config);
  assert.equal(done(f.root, f.units[1], context), true, 'text_ops finished after two retries');
  assert.match(error.message, /ported\/math_ops\.mjs: Agent did not return/);
  assert.match(error.message, /ported\/main\.mjs: Waiting on unfinished dependencies \(ported\/math_ops\.mjs\)/);
  const groups = failureGuidanceList(error, { root: f.root }).map(g => g.guidance.id);
  assert.deepEqual(groups, ['worker-output', 'waiting-dependency']);
  const retried = fs.readdirSync(safePath(f.root, `migration/runs/${lastSummary(f).runId}`)).map(n => n.endsWith('.json') && n !== 'summary.json' ? readJSON(safePath(f.root, `migration/runs/${lastSummary(f).runId}/${n}`)) : null).filter(a => a?.retries);
  assert.equal(retried[0].retries.length, 2);
  // Streak breaker: three independent units failing in a row stop dispatching.
  const g = fixture(t, { count: 3 }); Object.assign(g.config, { concurrency: 1, maxConsecutiveFailures: 2 }); g.config.commands.typecheck = null;
  writeJSON(safePath(g.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: Object.fromEntries(g.units.map(u => [u.source, []])) });
  writeJSON(safePath(g.root, 'migration/config.json'), g.config); await approved(g);
  const implemented = [];
  const streak = await translate(g.root, g.config, async args => { if (args.role === 'implementer') { implemented.push(args.unit.target); throw new Error('Agent did not return one valid JSON object'); } return fake(args); }).catch(e => e);
  assert.equal(implemented.length, 2, 'the third unit is not dispatched');
  assert.match(streak.message, /Stopped dispatching after 2 consecutive unit failures/);
});

test('status estimates the rest from finished runs and names what the current phase waits for', async t => {
  const f = fixture(t, { count: 2 });
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'First batch only', { batch: 1 });
  await translate(f.root, f.config, fake);
  const summary = lastSummary(f);
  assert.equal(summary.unitsCompleted, 1);
  assert.ok(summary.startedAt);
  const report = migrationStatus(f.root);
  assert.equal(report.timeEstimate.remainingUnits, 1);
  assert.ok(report.timeEstimate.agentCalls >= 1);
  assert.match(report.timeEstimate.basis, /1 units completed in 1 runs/);
  const fresh = prepare(t); fresh.config.phasePolicy = 'strict'; writeJSON(safePath(fresh.root, 'migration/config.json'), fresh.config);
  phaseCommand(fresh.root, fresh.config, 'init');
  const start = migrationStatus(fresh.root);
  assert.equal(start.currentState, 'awaiting-review', 'feasibility.md exists, so 00 waits for review');
  assert.match(statusChecklist(start, 'ja'), /00 事前調査【確認待ち】/);
});

test('doctor failures and blocked units come with guidance; the 00b recommendation follows the recorded runtime answer', async t => {
  const list = doctorGuidance({ checks: [
    { check: 'repository hooks load in Copilot CLI', ok: false, status: 'untrusted' },
    { check: 'worker agents resolve', ok: false, detail: "The CLI did not report its agent list (exit 1); To authenticate, you can use any of the following methods" },
    { check: 'required flags', ok: false, missing: ['--no-custom-instructions'] },
    { check: 'configuration', ok: true }] }, { language: 'en' });
  assert.deepEqual(list.map(x => x.guidance.id), ['untrusted-folder', 'copilot-auth', 'cli-options']);
  const f = fixture(t);
  assert.throws(() => setPreferences(f.root, { originalRuntime: 'maybe' }), /available or unavailable/);
  setPreferences(f.root, { originalRuntime: 'unavailable' });
  assert.equal(readPreferences(f.root).originalRuntime, 'unavailable');
  assert.equal(failureGuidance('Prepare runtime judge inputs and original/mutation/parity commands', { root: f.root }).recommended, 'switch-source-as-spec');
  await approved(f);
  await translate(f.root, f.config, async args => { if (args.role === 'reviewer-rules') throw new Error('Agent did not return one valid JSON object'); return fake(args); }).catch(() => {});
  const script = safePath(f.root, 'migration-kit/scripts/run_migration.mjs');
  const status = await runProcess(process.execPath, [script, 'status', '--format', 'markdown'], { cwd: f.root });
  assert.match(status.stdout, /ported\/math_ops\.mjs[\s\S]*This step did not succeed[\s\S]*\(recommended\)/);
  const doc = await runProcess(process.execPath, [script, 'doctor'], { cwd: f.root, env: { ...process.env, COPILOT_HOME: path.join(f.root, 'no-home') } });
  assert.equal(doc.code, 0, doc.stderr);
});

test('installer maps the upstream model plan per role', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'mid', models: 'reviewers=large,implementer=small' });
  assert.deepEqual(readJSON(safePath(root, 'migration/config.json')).models,
    { implementer: 'small', 'reviewer-semantics': 'large', 'reviewer-rules': 'large', arbiter: 'mid', fixer: 'mid' });
  assert.throws(() => install(root, { model: 'm', models: 'judge=x' }), /role=MODEL_ID/);
});
