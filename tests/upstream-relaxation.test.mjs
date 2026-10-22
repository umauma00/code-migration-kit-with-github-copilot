// SPDX-License-Identifier: Apache-2.0
// Fewer repeated confirmations, as upstream: one grant reruns build, smoke and
// parity after repairs, and the 03 review and the translation approval are one
// confirmation. The guardrails and each confirmation itself stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, result, fake } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, writeJSON, readJSON, atomicWrite } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { buildLoop } from '../lib/build-loop.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { currentPhase } from '../lib/phases.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';
import { runProcess } from '../lib/process.mjs';

const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);
// Smoke fails on ported/math_ops.mjs until a repair marks it FIXED; build always passes.
const fixedSmoke = [process.execPath, '-e', 'const fs=require("fs");if(!fs.readFileSync("ported/math_ops.mjs","utf8").includes("FIXED")){console.error("ported/math_ops.mjs:1:1: error: smoke not fixed");process.exit(1)}console.log("smoke OK")'];
const repairing = async args => {
  const value = await fake(args);
  const fixed = fs.readFileSync(safePath(args.root, args.unit.target), 'utf8').includes('FIXED');
  if (args.role.startsWith('reviewer-') && !fixed && /not fixed/.test(args.reviewInput ?? '')) {
    value.result = result(args.role, args.unit, { findings: [{ id: 'F1', message: 'Smoke error', evidence: 'ported/math_ops.mjs:1 smoke not fixed', rule: 'Smoke must pass' }] });
  }
  if (args.role === 'fixer') value.result.content = `// FIXED\n${value.result.content}`;
  return value;
};

test('build-loop --through smoke repairs a smoke failure and reruns build and smoke under one grant', async t => {
  const f = prepare(t, { count: 2 });
  f.config.commands.smoke = fixedSmoke; persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  await translate(f.root, f.config, fake);
  const report = await buildLoop(f.root, f.config, repairing, { note: 'Fixture loop', through: 'smoke', maxRounds: 4 });
  assert.equal(report.stopped, 'clean'); assert.equal(report.through, 'smoke');
  assert.deepEqual(report.rounds.map(r => [r.round, r.stage, r.success, r.errors]), [[1, 'smoke', false, 1], [2, 'smoke', true, 0]]);
  assert.match(report.next, /parity approval/);
  for (const stage of ['build', 'smoke']) assert.deepEqual(readJSON(safePath(f.root, `migration/gates/${stage}.json`)).loop, { grantId: report.grantId, round: 2 });
  assert.equal(readJSON(safePath(f.root, 'migration/results/smoke.json')).success, true);
  assert.equal(readJSON(safePath(f.root, `migration/gates/build-loop-${report.grantId}.json`)).through, 'smoke');
});

test('build-loop --through checks its stage and source-only stops at smoke', async t => {
  const f = prepare(t);
  await assert.rejects(buildLoop(f.root, f.config, fake, { note: 'x', through: 'deploy' }), /--through/);
  await assert.rejects(buildLoop(f.root, { ...f.config, verificationMode: 'source-only' }, fake, { note: 'x', through: 'parity' }), /source-only/);
  assert.throws(() => approve(f.root, f.config, 'translation', 'x', { loop: { grantId: 'g', round: 1 } }), /build, smoke and parity/);
});

function strictFixture(t) {
  const f = prepare(t);
  f.config.phasePolicy = 'strict'; persist(f);
  fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(f.root, 'migration/guardrails.json'));
  atomicWrite(safePath(f.root, 'migration/judge-report.md'), 'Reviewed public arithmetic scenarios, commands, normalization and limitations.');
  atomicWrite(safePath(f.root, 'migration/depmap/report.md'), 'Audited parser coverage, isolated files and source dependency map.');
  atomicWrite(safePath(f.root, 'migration/gap-report.md'), 'Audited floor division, Unicode semantics and inventory coverage.');
  phaseCommand(f.root, f.config, 'init');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: `Reviewed fixture phase ${id} evidence` });
  return f;
}

test('approve translation --complete-phase 03 records the 03 review and the approval in one command', async t => {
  const f = strictFixture(t);
  await runStage(f.root, f.config, 'judge');
  const script = safePath(f.root, 'migration-kit/scripts/run_migration.mjs');
  const wrong = await runProcess(process.execPath, [script, 'approve', 'build', '--complete-phase', '03', '--note', 'x'], { cwd: f.root });
  assert.equal(wrong.code, 1); assert.match(wrong.stderr, /--complete-phase applies only/);
  assert.equal(currentPhase(f.root, f.config, '03'), false);
  const run = await runProcess(process.execPath, [script, 'approve', 'translation', '--complete-phase', '03', '--note', 'Reviewed the stress-test report and pilot'], { cwd: f.root });
  assert.equal(run.code, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.phase.phase, '03'); assert.equal(out.approval.stage, 'translation');
  assert.ok(currentPhase(f.root, f.config, '03'));
  assert.equal(readJSON(safePath(f.root, 'migration/gates/translation.json')).note, 'Reviewed the stress-test report and pilot');
});

test('the combined approval is one host-confirmed gate that names phase 03', async t => {
  const f = prepare(t);
  const command = 'node migration-kit/scripts/run_migration.mjs approve translation --complete-phase 03 --note "reviewed"';
  assert.equal(humanGate(command), 'approve translation + phase complete');
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs approve translation --note "reviewed"'), 'approve translation');
  const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: f.root }, f.root);
  assert.equal(decision.decision, 'ask'); assert.match(decision.reason, /phase 03|工程03/);
  const loop = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'node migration-kit/scripts/run_migration.mjs build-loop --through parity --note "agreed"' }, cwd: f.root }, f.root);
  assert.equal(loop.decision, 'ask'); assert.match(loop.reason, /--through/);
});

test('new installs default to upstream single-pass fixes; older configurations keep rereview', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/migration-config.json'), 'utf8')).fixPolicy, 'single-pass');
});
