// SPDX-License-Identifier: Apache-2.0
// Second-opinion review of the build-loop change: quoted substitutions behind a
// read-only command, one build-loop at a time, and the loop's input budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { prepare, fake } from './helpers.mjs';
import { safePath, writeJSON, readJSON } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { buildLoop } from '../lib/build-loop.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';

const R = 'node migration-kit/scripts/run_migration.mjs';
async function approvedWith(t, options, change = () => {}) {
  const f = prepare(t, options);
  change(f.config); writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  return f;
}
const failingBuild = [process.execPath, '-e', 'console.error("ported/math_ops.mjs:1:1: error: still broken"); process.exit(1)'];
const live = t => { const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); t.after(() => p.kill()); return p; };
// A PID no process can hold: a reaped child's PID can be reused at once on Windows
// (see deadPid in stop-causes-2026-10-27.test.mjs).
const dead = async () => 0x7ffffff0;

test('a quoted substitution behind a read-only command still reaches the human gate and the guardrails file check', t => {
  for (const [command, gate] of [
    [`test -n "$(${R} approve build --note reviewed)"`, 'approve build'],
    [`jq . "$(${R} build-loop --note x)"`, 'build-loop'],
    [`cat "\`${R} phase complete 05\`"`, 'phase complete 05'],
    [`test -n "$(${R} frobnicate approve)"`, 'unrecognized runner command'],
    ['grep -n "approve build" scripts/run_migration.mjs', null],
    [`test -f "$(pwd)/migration/config.json"`, null]]) {
    assert.equal(humanGate(command), gate, command);
  }
  const f = prepare(t);
  const decide = command => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: f.root }, f.root);
  assert.equal(decide(`test -n "$(${R} approve build --note reviewed)"`).decision, 'ask');
  assert.equal(decide('test -n "$(rm migration/guardrails.json)"').decision, 'deny');
  assert.equal(decide('test -z "$(rm -rf migration)"').decision, 'deny');
  assert.equal(decide('cat migration/guardrails.json'), null);
});

test('a second build-loop stops before it saves a grant, whichever grant is listed first', async t => {
  const f = await approvedWith(t, {}, c => { c.commands.build = failingBuild; });
  await translate(f.root, f.config, fake);
  const gates = () => fs.readdirSync(safePath(f.root, 'migration/gates')).filter(n => n.startsWith('build-loop-'));
  const owner = live(t);
  writeJSON(safePath(f.root, 'migration/build-loop.lock'), { pid: owner.pid, grantId: 'other' });
  await assert.rejects(buildLoop(f.root, f.config, fake, { note: 'x' }), /build-loop \(grant other, pid \d+\) is already running/);
  assert.deepEqual(gates(), []);

  // A live grant without the lock (an older loop): this loop's own grant,
  // listed first or not, no longer hides it.
  fs.rmSync(safePath(f.root, 'migration/build-loop.lock'));
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  writeJSON(safePath(f.root, `migration/gates/build-loop-${id}.json`), { schemaVersion: 1, kind: 'build-loop', id, pid: owner.pid, maxRounds: 5, maxCalls: 10, rounds: [] });
  await assert.rejects(buildLoop(f.root, f.config, fake, { note: 'x' }), new RegExp(`build-loop \\(grant ${id}, pid ${owner.pid}\\) is running`));
  assert.ok(!fs.existsSync(safePath(f.root, 'migration/build-loop.lock')), 'the lock is released when the loop stops');
  fs.rmSync(safePath(f.root, `migration/gates/build-loop-${id}.json`));

  // A lock left by a process that is gone is retaken and released at the end.
  writeJSON(safePath(f.root, 'migration/build-loop.lock'), { pid: await dead(), grantId: 'crashed' });
  const report = await buildLoop(f.root, f.config, fake, { note: 'x', maxRounds: 1 });
  assert.equal(report.stopped, 'round-limit');
  assert.ok(!fs.existsSync(safePath(f.root, 'migration/build-loop.lock')));
});

test('build-loop starts no repair round once the input budget is spent', async t => {
  const f = await approvedWith(t, { count: 2 }, c => { c.commands.build = failingBuild; c.maxRunInputBytes = 10000; c.concurrency = 1; });
  await translate(f.root, f.config, fake);
  let calls = 0;
  // One completed call overshoots the whole budget, as an in-flight call can.
  const sized = async options => { calls++; return { ...(await fake(options)), promptBytes: 16000, responseBytes: 400 }; };
  const report = await buildLoop(f.root, f.config, sized, { note: 'x', maxRounds: 5 });
  assert.equal(report.stopped, 'budget'); assert.match(report.next, /input budget/);
  assert.equal(report.rounds.length, 2, 'the second build runs; no repair follows it');
  const grant = readJSON(safePath(f.root, `migration/gates/build-loop-${report.grantId}.json`));
  assert.equal(grant.promptBytes, calls * 16000);
  assert.equal(calls, grant.agentCalls);
});
