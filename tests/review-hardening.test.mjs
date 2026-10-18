// SPDX-License-Identifier: Apache-2.0
// Second-opinion review fixes: quote-aware human gates with a best-effort
// fallback for unreadable forms, guardrails-file protection, runner-chosen
// session IDs, the build-loop's shared budget and visibility, and path edge
// cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepare, result, fake } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, activeBuildLoop, lockRun } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { buildLoop } from '../lib/build-loop.mjs';
import { humanGate, interactiveDecision, shellSegments } from '../lib/guardrails.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { workerSessions, sessionStateDir } from '../lib/sessions.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { decide } from '../scripts/migration_hook.mjs';

const R = 'node migration-kit/scripts/run_migration.mjs';
const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);
async function approvedWith(t, options, change = () => {}) {
  const f = prepare(t, options);
  change(f.config); persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  return f;
}
const failingBuild = [process.execPath, '-e', 'console.error("ported/math_ops.mjs:1:1: error: still broken"); process.exit(1)'];

test('human gates read quoted values and ask on unreadable forms within a segment', t => {
  for (const [command, gate] of [
    [`${R} --note "reviewed all of it" build-loop`, 'build-loop'],
    [`${R} --root "/Users/me/My Project" approve build`, 'approve build'],
    [`${R} guardrails --waiver "a b" install`, 'guardrails install'],
    [`${R} build-loop --note "fix; then approve" --max-rounds 3`, 'build-loop'],
    [`cd /x && FOO=1 time ${R} approve smoke --note "a b"`, 'approve smoke'],
    ['node scripts/run_migration.m* approve build', 'approve build'],
    [`${R} --unknown x approve build`, 'approve build'],
    [`bash -c "${R} status || ${R} approve build"`, 'approve build'],
    [`echo "$(${R} sessions prune)"`, 'sessions prune'],
    [`${R} frobnicate approve`, 'unrecognized runner command'],
    [`node -e "import('./lib/pipeline.mjs').then(m => m.approve(r, c, 'build', 'x'))"`, 'unrecognized runner command'],
    [`node --input-type=module -e "import('./migration-kit/lib/guardrails.mjs').then(m => m.installGuardrails('.', '.', {}))"`, 'unrecognized runner command'],
    [`${R} repair --target ported/install.mjs --evidence migration/x.txt`, null],
    [`${R} status --format markdown`, null],
    [`${R} guidance --message "approve translation"`, null],
    ['grep -n "approve build" scripts/run_migration.mjs', null],
    ['git log -S approve -- scripts/run_migration.mjs', null],
    [`node -e "import('./scripts/run_migration.mjs')"`, null]]) {
    assert.equal(humanGate(command), gate, command);
  }
  const f = prepare(t);
  const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command: `${R} frobnicate approve` }, cwd: f.root }, f.root);
  assert.equal(decision.decision, 'ask'); assert.match(decision.reason, /cannot read/);
  assert.deepEqual(shellSegments(`a "b c" | d 'e;f' && g`).map(s => s.words), [['a', 'b c'], ['d', 'e;f'], ['g']]);
});

test('globs, bare names and whole-directory deletes cannot remove the guardrails file', t => {
  const f = prepare(t);
  const decision = command => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: f.root }, f.root)?.decision ?? null;
  for (const command of ['rm migration/guard*.json', 'rm -rf migration', 'rm -rf ./migration/', 'rm -rf migration/*', 'mv migration old',
    'find migration -delete', 'cd migration && rm guardrails.json', 'Remove-Item migration -Recurse', 'cp a migration/guardrails.json']) {
    assert.equal(decision(command), 'deny', command);
  }
  for (const command of ['cat migration/guardrails.json', 'ls migration', 'rm -rf migration/build-diagnostics', 'cp -r migration /tmp/backup',
    'git diff migration/guardrails.json', 'cp migration-kit/templates/guardrails.json /tmp/x']) {
    assert.notEqual(decision(command), 'deny', command);
  }
});

test('a phased production run refuses to translate once the guardrails file is gone', async t => {
  const f = prepare(t);
  f.config.phasePolicy = 'strict'; persist(f);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, name), 'Synthetic preparation evidence only.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture only' });
  await runStage(f.root, f.config, 'judge');
  fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(f.root, 'migration/guardrails.json'));
  phaseCommand(f.root, f.config, 'complete', '03', { note: 'Synthetic stress fixture only' });
  approve(f.root, f.config, 'translation', 'Fixture authorizes these outputs');
  fs.rmSync(safePath(f.root, 'migration/guardrails.json'));
  await assert.rejects(translate(f.root, f.config, fake), /requires human-installed command guardrails/);
  await assert.rejects(buildLoop(f.root, f.config, fake, { note: 'x' }), /requires human-installed command guardrails/);
});

test('the runner journals a session ID before every worker call, retries included, and the CLI gets it', async t => {
  const f = await approvedWith(t, {}, c => { c.transientRetries = 1; c.transientRetryDelayMs = 0; });
  const seen = [];
  let failed = false;
  await translate(f.root, f.config, async args => {
    seen.push(args.sessionId);
    if (args.role === 'implementer' && !failed) { failed = true; throw new Error('Copilot implementer failed (exit 1): session.error rate_limit 429: slow down'); }
    return fake(args);
  });
  assert.equal(seen.length, 4, 'one failed implementer call, its retry and two reviews');
  assert.ok(seen.every(id => /^[0-9a-f-]{36}$/.test(id))); assert.equal(new Set(seen).size, 4);
  const recorded = workerSessions(f.root);
  for (const id of seen) assert.ok(recorded.has(id), `journaled ${id}`);
  // The CLI adapter starts the worker with the journaled ID.
  const file = safePath(f.root, 'argv-double.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 0.0.0-test.'); process.exit(0); }
for await (const c of process.stdin);
fs.appendFileSync('argv.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(1);
`);
  const id = '44444444-4444-4444-8444-444444444444';
  const error = await createCopilotAdapter({ command: process.execPath, prefixArgs: [file] })({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {}, sessionId: id }).catch(e => e);
  assert.equal(error.cliSessionId, id);
  const argv = JSON.parse(fs.readFileSync(safePath(f.root, 'argv.jsonl'), 'utf8').trim());
  assert.equal(argv[argv.indexOf('--session-id') + 1], id);
});

test('a relative COPILOT_HOME resolves against the project, like the workers see it', t => {
  const f = prepare(t);
  const previous = process.env.COPILOT_HOME; process.env.COPILOT_HOME = '.copilot-test-home';
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; });
  assert.equal(sessionStateDir(f.root), path.join(f.root, '.copilot-test-home', 'session-state'));
});

test('build-loop shares one call budget across repair rounds and stops at it', async t => {
  const f = await approvedWith(t, { count: 2 }, c => { c.commands.build = failingBuild; });
  await translate(f.root, f.config, fake);
  // A repair round of one unit whose reviews pass takes two calls; three run
  // out inside the second round, which resumes later within the approval.
  const report = await buildLoop(f.root, f.config, fake, { note: 'Fixture loop', maxRounds: 10, maxCalls: 3 });
  assert.equal(report.stopped, 'budget');
  assert.equal(report.agentCalls, 3); assert.equal(report.rounds.length, 2);
  assert.deepEqual(report.pendingRepairs, ['ported/math_ops.mjs']);
  const grant = readJSON(safePath(f.root, `migration/gates/build-loop-${report.grantId}.json`));
  assert.equal(grant.maxCalls, 3); assert.equal(grant.stage, 'finished'); assert.ok(grant.finishedAt);
  await assert.rejects(buildLoop(f.root, f.config, fake, { note: 'x', maxCalls: 0 }), /--max-calls/);
  assert.match(humanGate(`${R} build-loop --note "agreed" --max-rounds 3 --max-calls 60`), /^build-loop$/);
});

test('build-loop errors stop it with the grant closed: unmapped failure, timeout, interrupt, stale approval', async t => {
  const unmapped = await approvedWith(t, {}, c => { c.commands.build = [process.execPath, '-e', 'console.error("linker: undefined reference"); process.exit(1)']; });
  await translate(unmapped.root, unmapped.config, fake);
  await assert.rejects(buildLoop(unmapped.root, unmapped.config, fake, { note: 'x' }), /no diagnostic maps to a manifest target/);
  const grants = root => fs.readdirSync(safePath(root, 'migration/gates')).filter(n => n.startsWith('build-loop-')).map(n => readJSON(safePath(root, `migration/gates/${n}`)));
  assert.ok(grants(unmapped.root).every(g => g.finishedAt));

  const slow = await approvedWith(t, {}, c => { c.commandTimeoutSeconds = 1; c.commands.build = [process.execPath, '-e', 'setTimeout(() => {}, 5000)']; });
  await translate(slow.root, slow.config, fake);
  await assert.rejects(buildLoop(slow.root, slow.config, fake, { note: 'x' }), /timed out/);
  assert.equal(grants(slow.root)[0].rounds.length, 0, 'a build that never finished is not a round');

  const stopped = await approvedWith(t, {}, c => { c.commands.build = failingBuild; });
  await translate(stopped.root, stopped.config, fake);
  const controller = new AbortController();
  await assert.rejects(buildLoop(stopped.root, stopped.config, async args => { controller.abort(); return fake(args); }, { note: 'x', signal: controller.signal }), /Interrupted/);
  assert.ok(grants(stopped.root).every(g => g.finishedAt && g.stage === 'finished'));

  const stale = await approvedWith(t, {}, c => { c.commands.build = failingBuild; });
  await translate(stale.root, stale.config, fake);
  await assert.rejects(buildLoop(stale.root, stale.config, async args => {
    // The person's rules change mid-loop: the next round's approval must fail.
    fs.appendFileSync(safePath(stale.root, 'migration/RULEBOOK.md'), '\nAmended.\n');
    return fake(args);
  }, { note: 'x' }), /stale|changed/i);
});

test('a running build-loop shows in status and keeps other processes out between its steps', async t => {
  const f = prepare(t);
  // A live process other than this one owns the grant.
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => owner.kill());
  const id = '55555555-5555-4555-8555-555555555555';
  writeJSON(safePath(f.root, `migration/gates/build-loop-${id}.json`), { schemaVersion: 1, kind: 'build-loop', id, pid: owner.pid, maxRounds: 5, maxCalls: 100, agentCalls: 12, stage: 'repair round 1: 3 errors in 2 targets', rounds: [{ round: 1 }] });
  assert.equal(activeBuildLoop(f.root).id, id);
  assert.throws(() => lockRun(f.root, 'translation'), /build-loop .* is running/);
  const status = migrationStatus(f.root);
  assert.equal(status.buildLoop.id, id);
  assert.match(status.nextActions[0], /build-loop .* is running .*12\/100 AI calls/);
  assert.match(statusMarkdown(status), /Build loop: repair round 1/);
  // A finished or dead owner no longer blocks.
  owner.kill(); await new Promise(resolve => owner.once('exit', resolve));
  assert.equal(activeBuildLoop(f.root), null);
  lockRun(f.root, 'translation')();
});

test('tool-assisted reviewers may read names that merely start with two dots', t => {
  const f = prepare(t);
  fs.mkdirSync(safePath(f.root, '..notes'), { recursive: true });
  assert.equal(decide({ toolName: 'view', toolArgs: { path: '..notes/a.md' }, cwd: f.root }, 'reviewer-rules-read'), null);
  assert.match(String(decide({ toolName: 'view', toolArgs: { path: '../outside' }, cwd: f.root }, 'reviewer-rules-read')), /may not read/);
});

test('the guardrails template describes the chat-only install', () => {
  const notes = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/guardrails.json'), 'utf8')).notes;
  assert.match(notes, /guardrails install/); assert.doesNotMatch(notes, /^Copy to/);
});
