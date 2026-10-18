// SPDX-License-Identifier: Apache-2.0
// Follow-ups to the 2026-10-18 review: the build repair loop, shared review
// focus, local-only worker sessions, the descriptor limit, retry visibility and
// the tool-assisted reviewer path check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, ready, result, fake } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, writeJSON, readJSON, loadConfig } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { buildLoop } from '../lib/build-loop.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';
import { agentPrompt, copilotArgs, fileLimits, fileLimitMinimum, createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { workerSessions, sessionsStatus, pruneSessions } from '../lib/sessions.mjs';
import { isSystemicFailure } from '../lib/failures.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { decide } from '../scripts/migration_hook.mjs';
import { runProcess } from '../lib/process.mjs';

const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);
// Configure before the translation approval: the approval binds the config.
async function approvedWith(t, options, change) {
  const f = prepare(t, options);
  change(f.config); persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  return f;
}
// The build fails on ported/math_ops.mjs until a repair marks it FIXED.
const fixedBuild = [process.execPath, '-e', 'const fs=require("fs");if(!fs.readFileSync("ported/math_ops.mjs","utf8").includes("FIXED")){console.error("ported/math_ops.mjs:1:1: error: not fixed");process.exit(1)}console.log("build OK")'];
// Reviewers confirm the build diagnostic until the target is fixed; the fixer fixes it.
const repairing = async args => {
  const value = await fake(args);
  const fixed = fs.readFileSync(safePath(args.root, args.unit.target), 'utf8').includes('FIXED');
  if (args.role.startsWith('reviewer-') && !fixed && /not fixed/.test(args.reviewInput ?? '')) {
    value.result = result(args.role, args.unit, { findings: [{ id: 'F1', message: 'Build error', evidence: 'ported/math_ops.mjs:1 not fixed', rule: 'Build must pass' }] });
  }
  if (args.role === 'fixer') value.result.content = `// FIXED\n${value.result.content}`;
  return value;
};

test('build-loop repairs until the build is clean and records every round under one grant', async t => {
  const f = await approvedWith(t, { count: 2 }, c => { c.commands.build = fixedBuild; });
  await translate(f.root, f.config, fake);
  const report = await buildLoop(f.root, f.config, repairing, { note: 'Fixture loop', maxRounds: 4 });
  assert.equal(report.stopped, 'clean');
  assert.deepEqual(report.rounds.map(r => [r.round, r.success, r.errors]), [[1, false, 1], [2, true, 0]]);
  assert.match(fs.readFileSync(safePath(f.root, 'ported/math_ops.mjs'), 'utf8'), /FIXED/);
  const grant = readJSON(safePath(f.root, `migration/gates/build-loop-${report.grantId}.json`));
  assert.equal(grant.rounds.length, 2); assert.ok(grant.finishedAt);
  const gate = readJSON(safePath(f.root, 'migration/gates/build.json'));
  assert.deepEqual(gate.loop, { grantId: report.grantId, round: 2 });
});

test('build-loop stops when the error count stops falling and at the round limit', async t => {
  const f = await approvedWith(t, {}, c => { c.commands.build = fixedBuild; });
  await translate(f.root, f.config, fake);
  const stalled = await buildLoop(f.root, f.config, fake, { note: 'Fixture loop', maxRounds: 6 });
  assert.equal(stalled.stopped, 'stalled'); assert.equal(stalled.rounds.length, 3);
  const limited = await buildLoop(f.root, f.config, fake, { note: 'Fixture loop', maxRounds: 2 });
  assert.equal(limited.stopped, 'round-limit'); assert.equal(limited.rounds.length, 2);
  await assert.rejects(buildLoop(f.root, f.config, fake, { note: ' ' }), /--note/);
  await assert.rejects(buildLoop(f.root, f.config, fake, { note: 'x', maxRounds: 0 }), /--max-rounds/);
});

test('build-loop is a host-confirmed human gate and loop metadata is build-only', async t => {
  const loop = 'node migration-kit/scripts/run_migration.mjs build-loop --note "agreed" --max-rounds 3';
  assert.equal(humanGate(loop), 'build-loop');
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs sessions prune --run 1-abcdef01'), 'sessions prune');
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs sessions status'), null);
  const f = await ready(t);
  const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command: loop }, cwd: f.root }, f.root);
  assert.equal(decision.decision, 'ask'); assert.match(decision.reason, /round limit/);
  assert.throws(() => approve(f.root, f.config, 'smoke', 'x', { loop: { grantId: 'g', round: 1 } }), /loop/);
});

test('shared review focus asks each reviewer for both checks; specialized keeps one lens', t => {
  const f = prepare(t);
  const unit = f.units[0];
  const shared = agentPrompt({ role: 'reviewer-rules', unit, reviewInput: 'x', reviewFocus: 'shared' });
  const specialized = agentPrompt({ role: 'reviewer-rules', unit, reviewInput: 'x', reviewFocus: 'specialized' });
  assert.match(shared, /You are one of two independent full reviewers/);
  assert.doesNotMatch(specialized, /two independent full reviewers/);
  assert.equal(loadConfig(f.root).reviewFocus, undefined, 'fixture removes the new-install default');
  assert.equal(JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/migration-config.json'), 'utf8')).reviewFocus, 'shared');
  writeJSON(safePath(f.root, 'migration/config.json'), { ...f.config, reviewFocus: 'both' });
  assert.throws(() => loadConfig(f.root), /reviewFocus/);
});

test('workers run as named local-only sessions whose IDs the attempt records keep', async t => {
  const f = await ready(t);
  const args = copilotArgs('implementer', 'm', undefined, undefined, { id: 'abc', name: 'migration-kit implementer x' });
  assert.ok(args.includes('--no-remote-export'));
  assert.deepEqual(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 4), ['--session-id', 'abc', '--name', 'migration-kit implementer x']);
  const file = safePath(f.root, 'argv-double.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 0.0.0-test.'); process.exit(0); }
for await (const c of process.stdin);
fs.appendFileSync('argv.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(1);
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [file] });
  const error = await adapter({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} }).catch(e => e);
  assert.match(error.cliSessionId, /^[0-9a-f-]{36}$/);
  const argv = JSON.parse(fs.readFileSync(safePath(f.root, 'argv.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(argv[argv.indexOf('--session-id') + 1], error.cliSessionId);
  assert.equal(argv[argv.indexOf('--name') + 1], `migration-kit implementer ported/math_ops.mjs ${error.cliSessionId.slice(0, 8)}`);
});

test('sessions status and prune touch only recorded worker session directories', t => {
  const f = prepare(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = process.env.COPILOT_HOME; process.env.COPILOT_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; });
  const worker = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222', linked = '33333333-3333-4333-8333-333333333333';
  const state = path.join(home, 'session-state');
  for (const id of [worker, user]) { fs.mkdirSync(path.join(state, id), { recursive: true }); fs.writeFileSync(path.join(state, id, 'events.jsonl'), 'x'.repeat(10)); }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.symlinkSync(outside, path.join(state, linked));
  writeJSON(safePath(f.root, 'migration/runs/1-abcdef01/attempts/a.json'), { cliSessionId: worker });
  writeJSON(safePath(f.root, 'migration/surveys/s/b.json'), { cliSessionId: linked });
  writeJSON(safePath(f.root, 'migration/runs/1-abcdef01/attempts/c.json'), { cliSessionId: 'not-a-uuid' });
  assert.deepEqual([...workerSessions(f.root).keys()].sort(), [worker, linked]);
  assert.deepEqual([...workerSessions(f.root, { run: '1-abcdef01' }).keys()], [worker]);
  assert.throws(() => workerSessions(f.root, { run: '../x' }), /--run/);
  const status = sessionsStatus(f.root);
  assert.equal(status.recorded, 2); assert.equal(status.present, 1); assert.equal(status.bytes, 10);
  const pruned = pruneSessions(f.root);
  assert.equal(pruned.removed, 1);
  assert.equal(fs.existsSync(path.join(state, worker)), false);
  assert.equal(fs.existsSync(path.join(state, user)), true, 'user sessions are never touched');
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep', 'symlinked directories are skipped');
});

test('the descriptor check reports the hard limit and only warns when it is low', { skip: process.platform === 'win32' }, async () => {
  const limits = await fileLimits();
  assert.equal(limits.ok, true);
  assert.ok(limits.unknown || limits.hard === 'unlimited' || Number.isInteger(limits.hard));
  // A lowered hard limit (allowed without privileges) is inherited and reported.
  const probe = `import(${JSON.stringify(path.join(kitRoot, 'scripts/copilot_adapter.mjs'))}).then(m => m.fileLimits()).then(r => console.log(JSON.stringify(r)))`;
  const low = await runProcess('/bin/sh', ['-c', 'ulimit -n 1024 && exec "$0" --input-type=module -e "$1"', process.execPath, probe], {});
  const reported = JSON.parse(low.stdout);
  assert.equal(reported.hard, 1024); assert.equal(reported.ok, true);
  assert.match(reported.warning, /below 4096/); assert.equal(fileLimitMinimum, 4096);
  // Workers start directly: no shell wrapper in front of the CLI.
  assert.ok(!copilotArgs('implementer', 'm').includes('ulimit'));
});

test('EMFILE stops the run with descriptor-limit guidance', () => {
  const error = new Error('Copilot implementer failed (exit 1): Error: EMFILE: too many open files, watch');
  assert.equal(isSystemicFailure(error), true);
  const advice = failureGuidance(error);
  assert.equal(advice.id, 'file-limit');
  assert.equal(failureGuidance(error, { language: 'ja' }).options.length, advice.options.length);
});

test('status tells the person while a worker is retrying after a transient failure', async t => {
  const f = await approvedWith(t, {}, c => { c.transientRetries = 1; c.transientRetryDelayMs = 0; });
  let failed = false, seen;
  const adapter = async args => {
    if (args.role === 'implementer' && !failed) { failed = true; throw new Error('Copilot implementer failed (exit 1): session.error rate_limit 429: slow down'); }
    if (args.role === 'implementer') seen = migrationStatus(f.root);
    return fake(args);
  };
  await translate(f.root, f.config, adapter);
  assert.equal(seen.retrying?.length, 1);
  assert.equal(seen.retrying[0].role, 'implementer'); assert.equal(seen.retrying[0].retries, 1);
  assert.ok(seen.nextActions.some(a => /retried after a transient failure \(rate limit\)/.test(a)));
  assert.match(statusMarkdown(seen), /implementer, retrying after a transient failure, attempt 1/);
  assert.match(statusMarkdown(seen, 'ja'), /レート制限/);
});

test('tool-assisted reviewers cannot read run records by case or symlink tricks', t => {
  const f = prepare(t);
  fs.mkdirSync(safePath(f.root, 'migration/runs'), { recursive: true });
  fs.symlinkSync(safePath(f.root, 'migration/runs'), safePath(f.root, 'alias'));
  const ask = target => decide({ toolName: 'view', toolArgs: { path: target }, cwd: f.root }, 'reviewer-rules-read');
  for (const target of ['migration/runs/x.json', 'Migration/Runs/x.json', 'alias', 'alias/x.json', 'MIGRATION', '../outside', 'migration/Gates/translation.json']) {
    assert.match(String(ask(target)), /may not read/, target);
  }
  assert.equal(ask('src/math_ops.py'), null);
  assert.equal(ask('migration/RULEBOOK.md'), null);
});

test('repository instructions stay short and point at the skill', () => {
  const text = fs.readFileSync(path.join(kitRoot, '.github/copilot-instructions.md'), 'utf8');
  assert.ok(Buffer.byteLength(text) < 1200, `${Buffer.byteLength(text)} bytes`);
  assert.match(text, /skills\/code-migration\/SKILL\.md/);
  assert.match(text, /chat only/i);
});
