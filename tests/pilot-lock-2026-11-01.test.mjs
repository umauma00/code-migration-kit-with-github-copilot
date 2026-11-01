// SPDX-License-Identifier: Apache-2.0
// 2026-11-01 (Windows, kit 0.40.0, Copilot CLI 1.0.105, one worker at a time):
// a phase 03 pilot stayed at 0 of 40. Every worker failed at session.send with
// "The shared writer lock timed out." and the kit blocked each unit at once,
// several minutes apart. The kit now retries the CLI's lock waits a few times,
// a pilot's input check reads each source file once per check (it read every
// file of the production project and of the pilot copy about 17 times), and
// workers share the person's CLI home unless the configuration says otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, ready, fake, result, nodeCli } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, loadConfig, contextHash, readMemo, roles } from '../lib/core.mjs';
import { runStage, runPilot, translate } from '../lib/pipeline.mjs';
import { preparePilot, requirePilot } from '../lib/pilot.mjs';
import { currentPhase } from '../lib/phases.mjs';
import { judgeInputHash } from '../lib/judge.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { createCopilotAdapter, requiredCopilotFlags } from '../scripts/copilot_adapter.mjs';
import { runtimeLayout } from '../lib/runtime.mjs';
import { assistedReviewerRoles } from '../lib/review.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { isTransientFailure, isSystemicFailure, isLimitedRetry, isHomeStateFailure, isCliLock, hostStallRetries } from '../lib/failures.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { workerCopilotHome, prepareWorkerHome, workerHomeDefault, resetPreparedWorkerHomes } from '../lib/worker-home.mjs';

const lockError = 'Copilot implementer failed (exit 1): Error: Request session.send failed with message: The shared writer lock timed out.';

test('the CLI\'s lock waits are retried a few times, never a stop or a reason to move workers', () => {
  for (const message of [lockError,
    'Copilot surveyor failed (exit 1): Error: MCP installation storage is busy; retry after the current operation completes.',
    'Copilot reviewer-rules failed (exit 1): Error: Another process is changing MCP configuration.']) {
    const e = new Error(message);
    assert.equal(isCliLock(e), true, message);
    assert.equal(isTransientFailure(e), true, message);
    assert.equal(isLimitedRetry(e), true, message);
    assert.equal(isSystemicFailure(e), false, message);
    assert.equal(isHomeStateFailure(e), false, message);
  }
  // The CLI may print it on stderr only.
  assert.equal(isTransientFailure(Object.assign(new Error('Copilot implementer failed (exit 1)'), { result: { stderr: 'Error: The shared writer lock timed out.\n' } })), true);
  // A cancellation and the kit's own deadline stay final.
  assert.equal(isTransientFailure(new Error(`Interrupted; ${lockError}`)), false);
  assert.equal(isTransientFailure(new Error(`Process timed out after 600000ms (explicit bounded deadline); ${lockError}`)), false);
  // A lock that changed under the CLI is not a busy one.
  assert.equal(isTransientFailure(new Error('Copilot implementer failed (exit 1): The shared writer lock or its directory changed.')), false);
});

async function lockedRun(t, executionMode) {
  const f = await ready(t, { executionMode });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  return f;
}

test('a worker whose CLI waits on its lock is retried, the unit completes, and status says why', async t => {
  const f = await lockedRun(t, 'continuous');
  let failures = 0, seen;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && failures < 2) { failures++; throw new Error(lockError); }
    if (args.role === 'implementer') seen = migrationStatus(f.root);
    return fake(args);
  });
  assert.equal(report.done, 1);
  assert.deepEqual(report.errors, []);
  // Three implementer calls (two retried) and the two reviewers.
  assert.equal(report.agentCalls, 5);
  const dir = safePath(f.root, `migration/runs/${report.runId}`);
  const implementer = fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'summary.json').map(n => readJSON(path.join(dir, n))).find(a => a.role === 'implementer');
  assert.equal(implementer.retries.length, 2);
  assert.ok(implementer.retries.every(r => r.cliLock === true && !r.hostStall), JSON.stringify(implementer.retries));
  assert.equal(seen.retrying?.[0]?.cliLock, true);
  assert.ok(seen.nextActions.some(a => /retried after a transient failure \(a lock inside the Copilot CLI/.test(a)), seen.nextActions.join('\n'));
});

for (const [mode, calls] of [['continuous', hostStallRetries + 1], ['bounded', 3]]) test(`a lock that never comes free blocks the unit after ${calls} calls in ${mode} mode`, async t => {
  // Continuous mode retries other transient failures without a count limit;
  // a lock held for good must not keep one unit retrying forever.
  const f = await lockedRun(t, mode);
  let count = 0;
  const failure = await translate(f.root, f.config, async () => { count++; throw new Error(lockError); }).then(() => null, e => e);
  assert.ok(failure, 'the run reports the blocked unit');
  assert.match(failure.message, /The shared writer lock timed out/);
  assert.equal(count, calls);
  assert.equal(failureGuidance(failure, { language: 'ja' }).id, 'cli-lock');
});

test('guidance for a lock that stayed busy offers the other CLI home first; switching keeps approvals', t => {
  const f = prepare(t);
  for (const [home, first] of [[undefined, 'separate-home'], ['shared', 'separate-home'], ['separate', 'shared-home']]) {
    const config = { ...f.config };
    if (home) config.workerCopilotHome = home; else delete config.workerCopilotHome;
    writeJSON(safePath(f.root, 'migration/config.json'), config);
    for (const language of ['ja', 'en']) {
      const g = failureGuidance(new Error(lockError), { root: f.root, language });
      assert.equal(g.id, 'cli-lock', `${home} ${language}`);
      assert.deepEqual(g.options.map(o => o.id), [first, 'rerun', 'leftover-cli', 'pause'], `${home} ${language}`);
    }
  }
  // Without a project, the default home (shared) is assumed.
  assert.equal(failureGuidance(new Error(lockError)).recommended, 'separate-home');
  // It says "timed out", but it is not the kit's deadline; a cancellation is not described as retried.
  assert.notEqual(failureGuidance(new Error(lockError)).id, 'timeout');
  assert.notEqual(failureGuidance(new Error(`Interrupted; ${lockError}`)).id, 'cli-lock');
  // The choice is a run setting: the inputs approvals bind to stay the same.
  const config = loadConfig(f.root), before = contextHash(f.root, config);
  for (const value of ['shared', 'separate']) {
    writeJSON(safePath(f.root, 'migration/config.json'), { ...config, workerCopilotHome: value });
    assert.equal(contextHash(f.root, loadConfig(f.root)), before, value);
  }
});

// A person's CLI home in a temporary folder, restored after the test.
function personHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-person-home-')), home = path.join(dir, '.copilot');
  fs.mkdirSync(home);
  const previous = process.env.COPILOT_HOME; process.env.COPILOT_HOME = home;
  resetPreparedWorkerHomes();
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; resetPreparedWorkerHomes(); fs.rmSync(dir, { recursive: true, force: true }); });
  return home;
}

test('workers share the person\'s CLI home unless the configuration asks for a home of their own', async t => {
  assert.equal(workerHomeDefault, 'shared');
  const home = personHome(t), f = prepare(t);
  assert.equal(f.config.workerCopilotHome, undefined, 'a new installation does not choose');
  assert.equal(workerCopilotHome(f.root, f.config), null);
  assert.equal(prepareWorkerHome(f.root, f.config), null);
  assert.equal(workerCopilotHome(f.root, { ...f.config, workerCopilotHome: 'separate' }), `${home}-migration-kit-workers`);
  const script = safePath(f.root, 'home-cli.mjs'), log = safePath(f.root, 'homes.jsonl');
  atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
for await (const _ of process.stdin);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.env.COPILOT_HOME) + '\\n');
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(result('implementer', f.units[0]))}), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [script] });
  const response = await adapter({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} });
  assert.equal(response.cliHomeWarning, undefined);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [home]);
  assert.equal(fs.existsSync(`${home}-migration-kit-workers`), false, 'no worker home is made');
});

test('doctor names the CLI home workers use, shared by default and separate when chosen', async t => {
  const home = personHome(t), f = prepare(t);
  t.after(() => fs.rmSync(`${home}-migration-kit-workers`, { recursive: true, force: true }));
  const ids = [...roles, ...assistedReviewerRoles, 'surveyor', 'preparation-auditor'].map(role => `migration-${role}`);
  const command = nodeCli(safePath(f.root, 'agent-cli.mjs'), `const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('GitHub Copilot CLI 9.9.9.'); process.exit(0); }
if (argv.includes('--help')) { console.log(${JSON.stringify(requiredCopilotFlags(runtimeLayout(f.root, f.config)).join(' '))}); process.exit(0); }
console.error('No such agent: ' + argv[argv.indexOf('--agent') + 1] + ', available: ' + ${JSON.stringify(ids.join(', '))});
process.exit(1);
`);
  const check = async config => (await doctor(f.root, config, { checkCLI: true, command })).checks.find(c => c.check === 'worker Copilot CLI home');
  const shared = await check(f.config);
  assert.equal(shared.status, 'shared');
  assert.equal(shared.path, undefined);
  assert.match(shared.note, /person's Copilot CLI home.*the default/);
  resetPreparedWorkerHomes();
  const separate = await check({ ...f.config, workerCopilotHome: 'separate' });
  assert.equal(separate.status, 'separate');
  assert.equal(separate.path, `${home}-migration-kit-workers`);
  assert.match(separate.note, /home of their own/);
});

// A production project with phases 00 to 02 recorded and its judge run.
async function reviewedPreparation(t) {
  const f = prepare(t, { realCommands: true, count: 3, executionMode: 'continuous' });
  f.config.phasePolicy = 'strict'; f.config.concurrency = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  for (const p of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, p), 'Disposable preparation fixture; not actual AI review or human signoff.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for a regression test only' });
  await runStage(f.root, f.config, 'judge');
  return f;
}
function pilotOf(t, f) {
  const child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Disposable regression pilot' });
  return { child, config: loadConfig(child) };
}
// Counts reads of the given files until stop().
function readCounter(files) {
  const real = files.map(file => fs.realpathSync(file)), counts = real.map(() => 0), original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string') { const i = real.indexOf(path.resolve(file)); if (i >= 0) counts[i]++; }
    return original.call(this, file, ...rest);
  };
  return { counts, stop: () => { fs.readFileSync = original; } };
}

test('one input check hashes each file once, and the shared read gives the same answers', async t => {
  const f = await reviewedPreparation(t), source = safePath(f.root, 'src/math_ops.py');
  // math_ops.py is in the source tree, the manifest and the dependency map.
  const reads = readCounter([source]);
  try { contextHash(f.root, f.config); } finally { reads.stop(); }
  assert.deepEqual(reads.counts, [1]);
  const context = contextHash(f.root, f.config), memo = readMemo();
  assert.equal(contextHash(f.root, f.config, memo), context);
  assert.equal(judgeInputHash(f.root, f.config, memo), judgeInputHash(f.root, f.config));
  assert.ok(currentPhase(f.root, f.config, '02'));
  assert.deepEqual(currentPhase(f.root, f.config, '02', { contextKnown: true, context, memo }), currentPhase(f.root, f.config, '02'));
  // A changed source makes both reads stale alike.
  fs.appendFileSync(source, '\n# changed\n');
  const changed = contextHash(f.root, f.config);
  assert.notEqual(changed, context);
  assert.equal(currentPhase(f.root, f.config, '02', { contextKnown: true, context: changed, memo: readMemo() }), false);
  assert.equal(currentPhase(f.root, f.config, '02'), false);
});

test('a pilot\'s input checks read each production and pilot file once per check', async t => {
  const f = await reviewedPreparation(t), { child, config } = pilotOf(t, f);
  const marks = [], reads = readCounter([safePath(f.root, 'src/math_ops.py'), path.join(child, 'src/math_ops.py')]);
  try {
    await runPilot(child, config, async () => { throw new Error('Copilot implementer failed (exit 1): Error: unexpected end of input'); },
      { onProgress: event => { if (event.stage === 'blocked') marks.push({ unit: event.unit, reads: [...reads.counts] }); } }).catch(() => {});
  } finally { reads.stop(); }
  // math_ops and text_ops fail; main waits on them.
  assert.deepEqual(marks.map(m => m.unit), ['ported/math_ops.mjs', 'ported/text_ops.mjs']);
  // From one failure to the next: the dispatch check, the check before the
  // call and the check after it failed. Before 0.42.0 that was 33 reads of a
  // production source and 18 of its pilot copy (11 and 6 per check).
  const [parent, copy] = [0, 1].map(i => marks[1].reads[i] - marks[0].reads[i]);
  assert.ok(parent <= 3, `production reads per failed unit: ${parent}`);
  assert.ok(copy <= 4, `pilot copy reads per failed unit: ${copy}`);
});

test('a pilot still stops when the production project or its own copy changes between worker calls', async t => {
  for (const where of ['parent', 'child']) {
    const f = await reviewedPreparation(t), { child, config } = pilotOf(t, f);
    let first = true;
    const failure = await runPilot(child, config, async call => {
      if (first) { first = false; fs.appendFileSync(where === 'parent' ? safePath(f.root, 'src/text_ops.py') : path.join(child, 'src/text_ops.py'), '\n# edited during the pilot\n'); }
      return fake(call);
    }).then(() => null, e => e);
    assert.ok(failure, where);
    assert.match(failure.message, where === 'parent' ? /Pilot parent preparation or judge changed/ : /Migration inputs changed during worker invocation/, where);
    assert.equal(fs.existsSync(path.join(child, 'ported/math_ops.mjs')), false, `${where}: nothing written after the change`);
  }
});
