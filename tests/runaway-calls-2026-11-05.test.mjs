// SPDX-License-Identifier: Apache-2.0
// 2026-11-05 (Windows, kit 0.46.1, Copilot CLI 1.0.105, gpt-6-luna, continuous
// mode, four workers): phase 04 stood at 117 of 554, and calls that usually
// take 2 to 4 minutes ran for hours. Two reviews of a 59-line file ran 201.8
// and 192.8 minutes and were stopped by hand; after every restart the same
// files filled all four slots again. Each of the long calls had an input over
// maxReviewInputBytes (1 MiB), so the kit listed the files to read instead of
// sending them, and told the worker to read every listed file in full. The
// unit's dependency chain held a 1 MB generated file (Database.designer.cs,
// in 61 units' chains), and CLI 1.0.105's view turns down a file over 20 KB
// unless given a view_range, then returns about 20 KB per call: one model
// turn for each part, over a context that kept growing. The silence check
// cannot see such a call (it keeps writing), and continuous mode has no
// limit on it.
// 0.47.0: a tool-assisted call reads its own files whole (in view_range
// parts) and a dependency only where the unit uses it; a call of the
// translation loop still at work past workerCallMinutes (plus a minute for
// every 8 KiB of the unit's own files) is stopped, tried once more with a
// note on what it did, and then its file is set aside for the run; the next
// run starts with the files no run has tried; status shows each call's
// minutes; status --wait no longer answers for each finished file; and each
// call's record counts what it did (turns, tools, files viewed, context).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, ready, fake, result, scopesOf } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, loadConfig, inputContext, done, statePath, operationalConfigKeys } from '../lib/core.mjs';
import { translate, dispatchOrder, runStage, approve } from '../lib/pipeline.mjs';
import { runProcess, callLimitMessage, workWatch, callLimiter, callIdleMs } from '../lib/process.mjs';
import { callLimitMinutes, defaultWorkerCallMinutes } from '../lib/execution-policy.mjs';
import { createCopilotAdapter, agentPrompt } from '../scripts/copilot_adapter.mjs';
import { isTransientFailure, isSystemicFailure, isLimitedRetry, isCallLimit, isSilentCall, retryCause, stoppedWithRun } from '../lib/failures.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot, runningAttempts } from '../lib/status-snapshot.mjs';
import { callActivity, activitySummary } from '../lib/activity.mjs';
import { progressKey, waitForProgress, doctor } from '../scripts/run_migration.mjs';
import { kitRoot } from '../scripts/install.mjs';

const continuous = async (t, options = {}) => {
  const f = await ready(t, { executionMode: 'continuous', ...options });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  return f;
};
const attempts = (f, runId) => {
  const dir = safePath(f.root, `migration/runs/${runId}`);
  return fs.readdirSync(dir).filter(n => /^[a-f0-9]{24}-\d+-[a-z-]+-[a-f0-9]{8}\.json$/.test(n)).map(n => readJSON(path.join(dir, n)));
};
const did = { turns: 41, tools: { rg: 2, view: 38 }, views: [{ path: 'src/Database.designer.cs', views: 38, refused: 1 }], contextTokens: 360000, contextLimit: 922000, compactions: null };
const overrun = (minutes, activity = did) => Object.assign(new Error(callLimitMessage(minutes * 60000)), { callLimit: true, activity });
const unit = { id: 'a'.repeat(24), source: 'src/BranchSelectImpl.cs', target: 'ported/BranchSelectImpl.java' };

test('a tool-assisted call reads its own files whole, in view_range parts, and a dependency only where the unit uses it', () => {
  const prompts = {
    implementer: agentPrompt({ role: 'implementer', unit, workInput: '{}', frozenInput: '{}', workMode: 'tool-assisted' }),
    fixer: agentPrompt({ role: 'fixer', unit, workInput: '{}', frozenInput: '{}', workMode: 'tool-assisted', extra: { confirmedFindings: [] } }),
    'reviewer-semantics': agentPrompt({ role: 'reviewer-semantics', unit, reviewInput: '{}', reviewMode: 'tool-assisted' }),
    'reviewer-rules': agentPrompt({ role: 'reviewer-rules', unit, reviewInput: '{}', reviewMode: 'tool-assisted' }) };
  for (const [role, p] of Object.entries(prompts)) {
    assert.doesNotMatch(p, /Read every listed file|Read EVERY listed file/i, role);
    assert.match(p, /Read in full (?:only )?the file named by the input's source and the listed files that are not in the input's sources, except migration\/inventory\.tsv/, role);
    assert.match(p, /view returns about 20 KB at most per call and turns down a larger file without view_range, so read a larger one in consecutive view_range parts/, role);
    assert.match(p, /The other files of the input's sources are dependencies/, role);
    assert.match(p, /search a dependency for the names this unit uses with your search tool \(grep or rg; output_mode content with line numbers; paths set to that file: it takes a single file, although its description names directories\), then view only the line ranges you need/, role);
    assert.match(p, /Never view a dependency whole and never use forceReadLargeFiles on one/, role);
    assert.match(p, /never view it whole/, `${role}: the inventory as before`);
    assert.match(p, /This reading rule replaces any other in your agent instructions\./, `${role}: a profile an update left in place says otherwise`);
  }
  assert.match(prompts.fixer, /\(migration\/RULEBOOK\.md, the design inputs and the target\)/);
  assert.match(prompts.implementer, /\(migration\/RULEBOOK\.md and the design inputs\)/);
  for (const role of ['reviewer-semantics', 'reviewer-rules']) {
    assert.match(prompts[role], /check only what the source and target use from them/);
    assert.match(prompts[role], /Base findings on the source and target, and never report that a dependency was not read in full/);
    assert.match(prompts[role], /never open migration\/runs/);
  }
  // A frozen input is read as before: no tools.
  const frozen = agentPrompt({ role: 'implementer', unit, workInput: '{}', frozenInput: '{}', workMode: 'frozen' });
  assert.match(frozen, /No tools are available/); assert.doesNotMatch(frozen, /view_range/);
  assert.doesNotMatch(agentPrompt({ role: 'reviewer-rules', unit, reviewInput: '{}' }), /view_range/);
  // The arbiter reads with its tools, by the same rule (up to 0.46.1: "Read
  // relevant dependencies if needed", and its profile sent it to the manual).
  const arbiter = agentPrompt({ role: 'arbiter', unit, extra: { designInputs: [], references: ['reviewer-rules:F1'] } });
  assert.match(arbiter, /Read migration\/RULEBOOK\.md, source "src\/BranchSelectImpl\.cs", the target "ported\/BranchSelectImpl\.java" if present and every file in extra\.designInputs in full \(a link is not the design body\): view returns about 20 KB at most per call/);
  assert.match(arbiter, /For this unit's rows of migration\/inventory\.tsv, search it for the source \(paths set to that file\); never view it whole\. Where a finding turns on a dependency, search a dependency for the names this unit uses/);
  assert.match(arbiter, /Never view a dependency whole and never use forceReadLargeFiles on one\. This reading rule replaces any other in your agent instructions\./);
  assert.doesNotMatch(arbiter, /Read relevant dependencies if needed/);
  // The read-only reviewer profiles say the same; the two copies of each
  // differ only in the name and the plugin's paragraph on paths.
  for (const name of ['reviewer-rules-read', 'reviewer-semantics-read', 'arbiter']) {
    const copy = fs.readFileSync(path.join(kitRoot, `.github/agents/migration-${name}.agent.md`), 'utf8');
    const plugin = fs.readFileSync(path.join(kitRoot, `com.github.copilot/agents/code-migration-plugin-${name}.agent.md`), 'utf8');
    for (const text of [copy, plugin]) {
      assert.doesNotMatch(text, /Read every listed file/, name);
      assert.doesNotMatch(text, /^Read \[/m, `${name}: the manual is for people`);
      assert.match(text, /^For human setup: /m, name);
      if (name === 'arbiter') { assert.match(text, /^Read only the files the coordinator's task names and the dependencies its findings turn on, as its reading rule says\.$/m); continue; }
      assert.match(text, /consecutive view_range parts/, name);
      assert.match(text, /and paths set to that file: it takes a single file, although its description names directories\)/, name);
      assert.match(text, /never view a dependency whole and never use forceReadLargeFiles on one/, name);
      assert.match(text, /never report that a dependency was not read in full/, name);
      assert.match(text, /Never open migration\/runs/, name);
    }
    const strip = text => text.split('\n').filter(l => !/^name: |^Resolve runner and prompt paths/.test(l)).join('\n').trimEnd();
    assert.equal(strip(plugin), strip(copy), name);
  }
});

test('the retry of a call stopped at its call limit hears what it did, apart from the task data and from a rejected answer', () => {
  const note = 'after 30 minutes, still at work and without a final answer (41 model turns, 40 tool calls). Return your answer as soon as it is complete.';
  for (const p of [agentPrompt({ role: 'implementer', unit, workInput: '{}', frozenInput: '{}', workMode: 'tool-assisted', extra: { previousAttempt: note, designInputs: [] } }),
    agentPrompt({ role: 'reviewer-semantics', unit, reviewInput: '{}', reviewMode: 'tool-assisted', extra: { previousAttempt: note } })]) {
    assert.ok(p.includes(`An earlier attempt at this task was stopped ${note}\nSet target to "${unit.target}".`), p.slice(-400));
    assert.doesNotMatch(p, /Your previous answer was rejected|Correction:/);
    assert.doesNotMatch(p, /"previousAttempt"/, 'not in the task data');
  }
  assert.match(agentPrompt({ role: 'implementer', unit, workInput: '{}', frozenInput: '{}', workMode: 'tool-assisted', extra: { previousAttempt: note, designInputs: [] } }), /Extra task data: \{"designInputs":\[\]\}/);
  assert.doesNotMatch(agentPrompt({ role: 'implementer', unit, workInput: '{}', frozenInput: '{}', workMode: 'tool-assisted', extra: {} }), /earlier attempt/);
});

test('a call may run workerCallMinutes plus a minute for every 8 KiB of the unit\'s own files; 0 turns the limit off; the setting is checked and is a run setting', t => {
  assert.equal(defaultWorkerCallMinutes, 30);
  assert.equal(callLimitMinutes({}), 30);
  assert.equal(callLimitMinutes({}, 59 * 80), 30, 'a 59-line file: 30 minutes');
  assert.equal(callLimitMinutes({}, 1016 * 1024), 157, 'the 1016 KB file of that run: 157 minutes (its implementer took 57)');
  assert.equal(callLimitMinutes({}, 1048576), 158);
  assert.equal(callLimitMinutes({ workerCallMinutes: 60 }, 16384), 62);
  assert.equal(callLimitMinutes({ workerCallMinutes: 0 }, 1040085), 0);
  assert.equal(callLimitMinutes({}, -5), 30); assert.equal(callLimitMinutes({}, 'x'), 30);
  assert.ok(operationalConfigKeys.includes('workerCallMinutes'), 'changing it keeps approvals and finished files');
  const f = prepare(t), file = safePath(f.root, 'migration/state/config.json');
  for (const bad of [5, 9, 1441, 12.5, '30', -1]) {
    writeJSON(file, { ...f.config, workerCallMinutes: bad });
    assert.throws(() => loadConfig(f.root), /workerCallMinutes must be 0 \(off\) or a whole number of minutes from 10 to 1440/, String(bad));
  }
  for (const good of [0, 10, 1440]) { writeJSON(file, { ...f.config, workerCallMinutes: good }); assert.equal(loadConfig(f.root).workerCallMinutes, good); }
});

test('each call of a run gets a minute more for every 8 KiB of the files it reads whole: the source, the current target, the RULEBOOK and the design inputs', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), `# ${'x'.repeat(97)}\n`.repeat(400));
  fs.appendFileSync(safePath(f.root, 'migration/RULEBOOK.md'), `${'r'.repeat(99)}\n`.repeat(300));
  atomicWrite(safePath(f.root, 'docs/design.md'), `${'d'.repeat(99)}\n`.repeat(200));
  f.config.designInputs = ['docs/design.md']; f.config.transientRetryDelayMs = 1;
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  const size = name => fs.existsSync(safePath(f.root, name)) ? fs.statSync(safePath(f.root, name)).size : 0;
  const own = () => ['src/math_ops.py', 'ported/math_ops.mjs', 'migration/RULEBOOK.md', 'docs/design.md'].reduce((sum, name) => sum + size(name), 0);
  const seen = [];
  const report = await translate(f.root, f.config, async args => { seen.push({ role: args.role, ms: args.callLimitMs, expected: (30 + Math.floor(own() / 8192)) * 60000 }); return fake(args); });
  assert.equal(report.done, 1, JSON.stringify(report.errors));
  const implementer = seen.find(c => c.role === 'implementer');
  assert.ok(own() > 90000 && size('ported/math_ops.mjs') > 0);
  assert.equal(implementer.ms, (30 + Math.floor((size('src/math_ops.py') + size('migration/RULEBOOK.md') + size('docs/design.md')) / 8192)) * 60000, 'no target yet');
  assert.ok(implementer.ms >= 41 * 60000, String(implementer.ms));
  for (const call of seen) assert.equal(call.ms, call.expected, call.role);
  assert.ok(seen.some(c => c.role.startsWith('reviewer-')));
  for (const r of attempts(f, report.runId)) assert.equal(r.callLimitMinutes * 60000, seen.find(c => c.role === r.role).ms, r.role);
});

test('a child still at work past its call limit is stopped however much it writes; one that ends in time keeps its answer', async () => {
  const busy = 'setInterval(() => process.stdout.write("working\\n"), 20);';
  const started = Date.now();
  const e = await runProcess(process.execPath, ['-e', busy], { limitMs: 400, silenceMs: 300 }).then(() => null, error => error);
  assert.ok(e, 'the busy child is stopped');
  assert.equal(e.callLimit, true);
  assert.match(e.message, /^Process ran past its call limit \(\d+(?:\.\d)? min, workerCallMinutes\) while still at work; stopped$/);
  assert.equal(callLimitMessage(30 * 60000), 'Process ran past its call limit (30 min, workerCallMinutes) while still at work; stopped');
  assert.match(e.result.stdout, /working/);
  assert.ok(Date.now() - started < 10000);
  const ok = await runProcess(process.execPath, ['-e', 'setTimeout(() => console.log("done"), 50)'], { limitMs: 5000 });
  assert.equal(ok.code, 0); assert.equal(ok.stdout.trim(), 'done');
  assert.throws(() => runProcess(process.execPath, ['-e', ''], { limitMs: -1 }), /call limit/);
  // The bounded mode's deadline stays final and comes first when it is earlier.
  const deadline = await runProcess(process.execPath, ['-e', busy], { timeoutMs: 200, limitMs: 5000 }).then(() => null, error => error);
  assert.match(deadline.message, /explicit bounded deadline/); assert.equal(isTransientFailure(deadline), false); assert.equal(isCallLimit(deadline), false);
  // How the runner reads the stop: a retry of its own, limited, not systemic,
  // named as such; a stop that came with the person's own stop is an interruption.
  assert.equal(isTransientFailure(e), true); assert.equal(isLimitedRetry(e), true); assert.equal(isSystemicFailure(e), false);
  assert.deepEqual(retryCause(e), { callLimit: true });
  assert.deepEqual(retryCause(Object.assign(new Error(callLimitMessage(60000)), { result: { stderr: 'rate_limit 429 ETIMEDOUT' } })), { callLimit: true }, 'what the CLI wrote as it was stopped is not the cause');
  const stopped = new AbortController(); stopped.abort();
  const interrupted = stoppedWithRun(Object.assign(new Error(e.message), { result: e.result }), stopped.signal);
  assert.match(interrupted.message, /^Interrupted; Process ran past its call limit/);
  assert.equal(isTransientFailure(interrupted), false);
  assert.notEqual(failureGuidance(interrupted).id, 'cli-call-limit');
  assert.notEqual(failureGuidance(`Translation stopped: src/a.cs: ${interrupted.message}`).id, 'cli-call-limit', 'nor in a run summary');
  assert.equal(failureGuidance(`Translation stopped: src/a.cs: ${e.message}`).id, 'cli-call-limit');
});

test('while the silence check is on, a call at its limit that has written nothing for a while is stopped at its next output, or by the silence check first', { timeout: 30000 }, async () => {
  assert.equal(callIdleMs, 120000);
  const silent = 'setTimeout(() => {}, 30000);';
  // Silent from the start, under a call limit shorter than its silence wait
  // (as 30 minutes against the third wait of 40): it ends as a silent call,
  // retried and guided as one, not as a call that ran past its limit.
  const quiet = await runProcess(process.execPath, ['-e', silent], { silenceMs: 800, limitMs: 300, idleMs: 100 }).then(() => null, error => error);
  assert.ok(quiet, 'the silent child is stopped');
  assert.equal(quiet.callLimit, undefined); assert.equal(isCallLimit(quiet), false); assert.equal(isSilentCall(quiet), true);
  // One that writes nothing past its limit (a model turn that takes long to
  // start writing), then writes: stopped for its limit at that output, not
  // while it was silent (and however long the child took to start).
  // (It ends by itself after 5 s, so a limiter that no longer hears its
  // output fails the test instead of leaving it waiting.)
  const slow = 'setTimeout(() => setInterval(() => process.stdout.write("y\\n"), 20), 700); setTimeout(() => process.exit(0), 5000);';
  const late = await runProcess(process.execPath, ['-e', slow], { silenceMs: 5000, limitMs: 300, idleMs: 100 }).then(() => null, error => error);
  assert.equal(late?.callLimit, true, late?.message);
  assert.match(late.result.stdout, /y/, 'not stopped before it wrote');
  // Without the silence check, a call is stopped at its limit, silent or not.
  const off = await runProcess(process.execPath, ['-e', silent], { limitMs: 300, idleMs: 100 }).then(() => null, error => error);
  assert.equal(off?.callLimit, true, off?.message);
  assert.throws(() => runProcess(process.execPath, ['-e', ''], { idleMs: 0 }), /call limit/);
});

test('the time at work is counted in steps, a late step as two at most, so a computer that slept does not use up a call\'s limit', () => {
  let now = 0;
  const w = workWatch(1000, () => now);
  assert.equal(w.step, 50);
  now += 50; assert.equal(w.tick(), false);
  now += 3600000; assert.equal(w.tick(), false, 'an hour asleep counts as two steps');
  assert.equal(w.worked, 150);
  for (let i = 0; i < 16; i++) { now += 50; assert.equal(w.tick(), false); }
  now += 50; assert.equal(w.tick(), true);
  assert.equal(workWatch(3600000).step, 30000, 'at most 30 s a step');
});

test('a call\'s time counts while it writes nothing; at its limit after idleMs without output it waits for its next output, and without the silence check it is stopped at once', () => {
  let now = 0;
  const clock = () => now;
  const l = callLimiter(1000, { silence: true, idleMs: 200, clock });
  assert.equal(l.step, 50);
  for (let i = 0; i < 2; i++) { now += 50; l.output(); assert.equal(l.tick(), false); }
  // 900 ms without output (a model turn over a large context that has not
  // started to write): all of it counts.
  for (let i = 0; i < 18; i++) { now += 50; assert.equal(l.tick(), false, `tick ${i}`); }
  assert.equal(l.worked, 1000, 'the silent time counted');
  now += 50; assert.equal(l.tick(), false, 'at its limit, silent for idleMs: not stopped for its limit');
  now += 10; l.output(); now += 40; assert.equal(l.tick(), true, 'stopped at its next output');
  // It wrote a little before its limit, not since the last tick: within
  // idleMs it is at work, and stopped at once.
  now = 0;
  const recent = callLimiter(1000, { silence: true, idleMs: 200, clock });
  for (let i = 0; i < 17; i++) { now += 50; assert.equal(recent.tick(), false); }
  now += 30; recent.output(); now += 20; assert.equal(recent.tick(), false, 'at 900 ms, below its limit');
  now += 50; assert.equal(recent.tick(), false);
  now += 50; assert.equal(recent.tick(), true, 'at its limit 120 ms after its last output');
  // At its limit while it writes: stopped at once, even with a step longer
  // than idleMs (an output since the last tick).
  now = 0;
  const busy = callLimiter(1000, { silence: true, idleMs: 200, clock });
  for (let i = 0; i < 19; i++) { now += 50; busy.output(); assert.equal(busy.tick(), false); }
  now += 50; busy.output(); assert.equal(busy.tick(), true);
  now = 0;
  const longStep = callLimiter(1000, { silence: true, idleMs: 10, clock });
  for (let i = 0; i < 19; i++) { now += 50; assert.equal(longStep.tick(), false); }
  now += 20; longStep.output(); now += 30; assert.equal(longStep.tick(), true, 'an output since the last tick');
  // Without the silence check nothing waits on an output.
  now = 0;
  const off = callLimiter(1000, { clock });
  for (let i = 0; i < 19; i++) { now += 50; assert.equal(off.tick(), false); }
  now += 50; assert.equal(off.tick(), true);
});

test('a call still at work at its call limit is tried once more, told what it did; then its file is set aside for the run, without the last pass, and the other files go on', async t => {
  const f = await continuous(t, { count: 2 });
  const seen = [], stages = [];
  const failure = await translate(f.root, f.config, async args => {
    if (args.unit.target === f.units[0].target && args.role === 'reviewer-semantics') { seen.push({ extra: args.extra, callLimitMs: args.callLimitMs }); throw overrun(30); }
    return fake(args);
  }, { onProgress: e => stages.push(e.stage) }).then(() => null, e => e);
  assert.ok(failure, 'the run reports the file set aside');
  assert.equal(seen.length, 2, 'the call, its one retry, and no last pass');
  assert.deepEqual(seen.map(s => s.callLimitMs), [30 * 60000, 30 * 60000]);
  assert.equal(seen[0].extra.previousAttempt, undefined);
  assert.equal(seen[1].extra.previousAttempt, 'after 30 minutes, still at work and without a final answer (41 model turns, 40 tool calls, src/Database.designer.cs viewed 38 times, context up to 360000 tokens of 922000). Do not read the listed dependencies whole: search a dependency for the names this unit uses and view only those lines. Read what the task needs, then return your answer.');
  assert.ok(stages.includes('reviewer-semantics retry 1 after a call stopped at its call limit (30 min)'), stages.join('\n'));
  assert.ok(!stages.some(s => /one more pass/.test(s)), stages.join('\n'));
  const state = readJSON(statePath(f.root, f.units[0]));
  assert.equal(state.status, 'blocked');
  assert.equal(state.error, 'Copilot reviewer-semantics ran past its call limit of 30 min (workerCallMinutes) on 2 attempts; this file is set aside for this run, and the next run tries it after the other files unless one of them waits on it (last attempt: 41 model turns, 40 tool calls, a file viewed 38 times, context up to 360000 tokens of 922000)');
  assert.equal(readJSON(statePath(f.root, f.units[1])).status, 'done', 'the other file went on');
  assert.equal(failureGuidance(state.error, { language: 'ja' }).id, 'cli-call-limit');
  assert.deepEqual(failureGuidance(state.error).options.map(o => o.id), ['rerun', 'longer-limit', 'check-dependencies', 'pause']);
  const record = attempts(f, failure.report.runId).find(a => a.role === 'reviewer-semantics' && a.unit.target === f.units[0].target);
  assert.equal(record.status, 'failed'); assert.equal(record.callLimitMinutes, 30);
  assert.equal(record.retries.length, 1); assert.equal(record.retries[0].callLimit, true); assert.deepEqual(record.retries[0].activity, did);
  assert.deepEqual(record.activity, did);
  assert.equal(migrationStatus(f.root).units[0].status, 'blocked');
  // In bounded mode with no transient retry left, the first stop sets it aside.
  const g = await ready(t);
  g.config.transientRetries = 0; g.config.transientRetryDelayMs = 1; writeJSON(safePath(g.root, 'migration/state/config.json'), g.config);
  let calls = 0;
  await translate(g.root, g.config, async args => { if (args.role === 'implementer') { calls++; throw overrun(30, null); } return fake(args); }).catch(() => {});
  assert.equal(calls, 1);
  assert.match(readJSON(statePath(g.root, g.units[0])).error, /^Copilot implementer ran past its call limit of 30 min \(workerCallMinutes\) and was stopped; this file is set aside for this run, and the next run tries it after the other files unless one of them waits on it$/);
});

test('the reason a file was set aside names no file, so a file\'s name cannot read as another cause; the call\'s record keeps it', async t => {
  for (const name of ['src/Keys/ApiKey.cs', 'src/ThreadInterruptedException.cs', 'migration/manifest.tsv', 'src/AuthenticationRequired.cs']) {
    const f = await continuous(t);
    const activity = { ...did, views: [{ path: name, views: 38 }] };
    await translate(f.root, f.config, async args => { if (args.role === 'implementer') throw overrun(30, activity); return fake(args); }).catch(() => {});
    const state = readJSON(statePath(f.root, f.units[0]));
    assert.equal(state.status, 'blocked');
    assert.ok(!state.error.includes(name), state.error);
    assert.match(state.error, /a file viewed 38 times/);
    assert.equal(failureGuidance(state.error).id, 'cli-call-limit', name);
    assert.equal(isSystemicFailure(state.error), false, name); assert.equal(isTransientFailure(state.error), true, name);
    const record = attempts(f, state.runId).find(a => a.role === 'implementer');
    assert.equal(record.activity.views[0].path, name);
  }
  // A stop of the run comes first in the message; a name later on does not hide the guidance.
  assert.equal(failureGuidance('Copilot reviewer-rules ran past its call limit of 30 min (workerCallMinutes) on 2 attempts; this file is set aside for this run (last attempt: Interrupted)').id, 'cli-call-limit');
  assert.notEqual(failureGuidance('Interrupted; Copilot reviewer-rules ran past its call limit of 30 min (workerCallMinutes) and was stopped').id, 'cli-call-limit');
});

test('a retry that answers finishes the file, and with workerCallMinutes 0 no call is given a limit', async t => {
  const f = await continuous(t);
  let tries = 0, status;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++tries === 1) throw overrun(30, { turns: 3, tools: {}, views: [], contextTokens: null, contextLimit: null, compactions: null });
    if (args.role === 'implementer') { assert.equal(args.extra.previousAttempt, 'after 30 minutes, still at work and without a final answer (3 model turns, 0 tool calls). Return your answer as soon as it is complete.'); status = migrationStatus(f.root); }
    return fake(args);
  });
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.ok(status.nextActions.some(a => /retried after a transient failure \(a call stopped at its call limit while still at work \(workerCallMinutes\).*never stop the runner for it/.test(a)), status.nextActions.join('\n'));
  assert.equal(status.retrying[0].callLimit, true);
  const g = await continuous(t);
  g.config.workerCallMinutes = 0; writeJSON(safePath(g.root, 'migration/state/config.json'), g.config);
  const limits = [];
  await translate(g.root, g.config, async args => { limits.push(args.callLimitMs); return fake(args); });
  assert.ok(limits.length && limits.every(ms => ms === 0), JSON.stringify(limits));
  const record = attempts(g, readJSON(statePath(g.root, g.units[0])).runId).find(a => a.role === 'implementer');
  assert.equal(Object.hasOwn(record, 'callLimitMinutes'), false);
});

test('a call stopped at its call limit takes none of the retries of a host stall: after one overrun, five host stalls still get theirs', async t => {
  const f = await continuous(t);
  const failed = [];
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && failed.length < 6) {
      const e = failed.length === 0 ? overrun(30) : new Error("Session host did not acknowledge 'session.idle' delivery within 120s");
      failed.push(e); throw e;
    }
    return fake(args);
  });
  assert.equal(failed.length, 6);
  assert.equal(isLimitedRetry(failed[1]), true, 'a host stall is a limited retry');
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  const record = attempts(f, readJSON(statePath(f.root, f.units[0])).runId).find(a => a.role === 'implementer');
  assert.equal(record.retries.length, 6);
  assert.equal(record.retries.filter(r => r.hostStall).length, 5);
  assert.equal(record.retries[0].callLimit, true);
  // And the other way round: after five host stalls, an overrun still gets its retry.
  const g = await continuous(t);
  let tries = 0;
  const after = await translate(g.root, g.config, async args => {
    if (args.role === 'implementer' && ++tries <= 6) throw tries <= 5 ? new Error("Session host did not acknowledge 'session.idle' delivery within 120s") : overrun(30);
    return fake(args);
  });
  assert.equal(tries, 7);
  assert.equal(after.done, 1); assert.deepEqual(after.errors, []);
});

test('end to end: the real adapter stops a CLI that keeps reading, and the error carries what it did', { timeout: 30000 }, async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const file = safePath(f.root, 'reading-cli.mjs');
  atomicWrite(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
let n = 0;
setInterval(() => {
  n++;
  out({ type: 'assistant.turn_start', data: { turnId: String(n) } });
  out({ type: 'tool.execution_start', data: { toolCallId: 'call_' + n, toolName: 'view', arguments: { path: ${JSON.stringify(safePath(f.root, 'src/math_ops.py'))}, view_range: [n * 300, n * 300 + 299] } } });
  out({ type: 'tool.execution_complete', data: { toolCallId: 'call_' + n, success: true, result: { content: 'SECRET FILE TEXT' }, toolTelemetry: { properties: {}, metrics: { context_current_tokens: 1000 * n, context_token_limit: 922000 } } } });
}, 30);
// Never outlives the test, even when the call limit does not stop it.
setTimeout(() => process.exit(0), 20000);
`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [file] });
  const e = await adapter({ root: f.root, config: f.config, role: 'reviewer-semantics', unit: f.units[0], reviewInput: '{"mode":"tool-assisted","files":[]}', reviewMode: 'tool-assisted', extra: {}, callLimitMs: 600 }).then(() => null, error => error);
  assert.ok(e, 'the call is stopped');
  assert.equal(isCallLimit(e), true);
  assert.ok(e.activity.turns >= 3, JSON.stringify(e.activity));
  assert.equal(e.activity.tools.view, e.activity.turns);
  assert.deepEqual(e.activity.views.map(v => v.path), ['src/math_ops.py']);
  assert.equal(e.activity.contextLimit, 922000); assert.ok(e.activity.contextTokens >= 3000);
  assert.doesNotMatch(JSON.stringify(e.activity), /SECRET|view_range/);
});

test('a run starts with the other files and tries the files an earlier run left unfinished last, unless another file waits on one', async t => {
  const order = async f => {
    f.config.concurrency = 1; writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
    const seen = [];
    await translate(f.root, f.config, async args => { if (args.role === 'implementer') seen.push(args.unit.target); return fake(args); });
    return seen;
  };
  const left = (f, u, error) => writeJSON(statePath(f.root, u), { schemaVersion: 1, ...u, status: 'blocked', stage: 'review', error });
  const f = await continuous(t, { count: 3 });
  assert.deepEqual(await order(f), ['ported/math_ops.mjs', 'ported/text_ops.mjs', 'ported/main.mjs'], 'manifest order when no run has tried any');
  // math_ops held the last run up (set aside at its call limit, or stopped by
  // a person): it goes after text_ops, and every file is still done in the run.
  for (const error of ['Copilot implementer ran past its call limit of 30 min (workerCallMinutes) on 2 attempts; this file is set aside for this run', 'Interrupted']) {
    const g = await continuous(t, { count: 2 });
    left(g, g.units[0], error);
    assert.deepEqual(await order(g), ['ported/text_ops.mjs', 'ported/math_ops.mjs'], error);
    assert.ok(g.units.every(u => readJSON(statePath(g.root, u)).status === 'done'));
  }
  // main waits on math_ops: math_ops keeps its place, so main does not wait for the end.
  const h = await continuous(t, { count: 3 });
  left(h, h.units[0], 'Interrupted');
  assert.deepEqual(await order(h), ['ported/math_ops.mjs', 'ported/text_ops.mjs', 'ported/main.mjs']);
  // A file finished before whose record no longer holds keeps its place too.
  const k = await continuous(t, { count: 2 });
  writeJSON(statePath(k.root, k.units[0]), { schemaVersion: 1, ...k.units[0], status: 'done', stage: 'done' });
  assert.deepEqual(await order(k), ['ported/math_ops.mjs', 'ported/text_ops.mjs']);
});

test('dispatchOrder: the units set back go last in their own order, a unit another one waits on keeps its place, and a repair keeps its order', () => {
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
  const pending = [a, b, c, d, e], back = new Set([a, c, d]), setBack = u => back.has(u);
  const none = new Map(pending.map(u => [u, new Set()]));
  assert.deepEqual(dispatchOrder(pending, { setBack, dependencies: none }), [b, e, a, c, d]);
  // e waits on c: c keeps its place; nothing waits on the units set back.
  const waits = new Map([...none, [e, new Set([c])]]);
  assert.deepEqual(dispatchOrder(pending, { setBack, dependencies: waits }), [b, c, e, a, d]);
  // Only what a pending unit waits on keeps its place (c is not pending here).
  assert.deepEqual(dispatchOrder([a, b], { setBack, dependencies: new Map([[a, new Set()], [b, new Set([c])]]) }), [b, a]);
  assert.deepEqual(dispatchOrder(pending, { setBack, dependencies: waits, repairing: true }), pending);
  assert.deepEqual(dispatchOrder(pending, { setBack: () => false, dependencies: none }), pending);
  assert.deepEqual(dispatchOrder(pending, { setBack }), [b, e, a, c, d], 'no dependency map: nothing waits');
  assert.notEqual(dispatchOrder(pending, { setBack, dependencies: none, repairing: true }), pending, 'a copy');
});

test('status shows how long each call at work has run and its call limit, in the full and the fast view', async t => {
  const f = await continuous(t);
  let implementer = 0, full, fast;
  await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer === 1) throw new Error('Copilot implementer failed (exit 1): session.error rate_limit 429: slow down');
    if (args.role === 'implementer') { full = migrationStatus(f.root); fast = statusSnapshot(f.root); }
    return fake(args);
  });
  for (const report of [full, fast]) {
    const [call] = report.units[0].activeRoles;
    assert.equal(call.role, 'implementer', JSON.stringify(report.units[0]));
    assert.equal(call.elapsedMinutes, 0); assert.equal(call.callLimitMinutes, 30);
    assert.ok(Number.isFinite(Date.parse(call.startedAt)));
  }
  const record = readJSON(safePath(f.root, full.units[0].activeRoles[0].path));
  assert.equal(full.units[0].activeRoles[0].startedAt, record.retries[0].at, 'the current try started at its retry');
  assert.equal(fast.units[0].activeRoles[0].startedAt, record.retries[0].at);
  assert.match(statusMarkdown(full), /- ported\/math_ops\.mjs: implement \(implementer 0 min, limit 30 min, retrying after a transient failure, attempt 1\)/);
  assert.match(statusMarkdown(fast, 'ja'), /- ported\/math_ops\.mjs: implement \(implementer 0分・上限30分\)/);
  // An attempt of an older kit has no limit: only its minutes are shown.
  const old = { ...full, units: [{ ...full.units[0], activeRoles: [{ role: 'fixer', elapsedMinutes: 12 }] }] };
  assert.match(statusMarkdown(old), /\(fixer 12 min\)/);
});

test('status --wait answers when the run stops or starts, a file is blocked, the build loop moves on or a survey scope finishes, not for each finished file or AI call', async t => {
  const base = { ok: true, running: true, lock: { runId: 'r' }, done: 3, total: 10, units: [{ status: 'done' }, { status: 'blocked' }, { status: 'review' }],
    buildLoop: { stage: 'build', rounds: 1, agentCalls: 2 }, survey: { runId: 's', done: 1, activeScopes: ['a'], agentCalls: 5, parts: { a: { done: 1, total: 3 } }, state: 'running' } };
  const key = progressKey(base);
  for (const change of [{ done: 4, units: [{ status: 'done' }, { status: 'blocked' }, { status: 'done' }] }, { buildLoop: { ...base.buildLoop, agentCalls: 3 } },
    { survey: { ...base.survey, agentCalls: 6, parts: { a: { done: 2, total: 3 } } } }])
    assert.equal(progressKey({ ...base, ...change }), key, JSON.stringify(change));
  for (const change of [{ running: false }, { lock: { runId: 'other' } }, { total: 11 }, { units: [{ status: 'blocked' }, { status: 'blocked' }, { status: 'review' }] },
    { buildLoop: { ...base.buildLoop, rounds: 2 } }, { buildLoop: { ...base.buildLoop, stage: 'smoke' } }, { survey: { ...base.survey, done: 2 } },
    { survey: { ...base.survey, activeScopes: ['b'] } }, { survey: { ...base.survey, state: 'done' } }, { ok: false }])
    assert.notEqual(progressKey({ ...base, ...change }), key, JSON.stringify(change));
  const f = await ready(t, { count: 2 });
  const lock = safePath(f.root, 'migration/run.lock');
  writeJSON(lock, { pid: process.pid, host: os.hostname(), task: 'translation', runId: 'wait-done', startedAt: new Date().toISOString() });
  t.after(() => fs.rmSync(lock, { force: true }));
  const state = (u, status) => writeJSON(statePath(f.root, u), { schemaVersion: 1, ...u, status, stage: status === 'done' ? 'done' : 'review', runId: 'wait-done' });
  state(f.units[0], 'review');
  const timer = setTimeout(() => state(f.units[0], 'done'), 100);
  t.after(() => clearTimeout(timer));
  const started = Date.now(), quiet = await waitForProgress(f.root, 1, { intervalMs: 20, fast: true });
  assert.ok(Date.now() - started >= 900, 'a finished file does not end the wait');
  assert.equal(quiet.done, 1);
  const blockTimer = setTimeout(() => state(f.units[1], 'blocked'), 100);
  t.after(() => clearTimeout(blockTimer));
  const before = Date.now(), blocked = await waitForProgress(f.root, 30, { intervalMs: 20, fast: true });
  assert.ok(Date.now() - before < 10000, 'a blocked file ends it');
  assert.equal(blocked.units[1].status, 'blocked');
});

test('the markdown status lists the files tried and not finished, with their reasons, and only counts the finished ones and those not tried yet', async t => {
  const f = await ready(t, { count: 3 });
  await translate(f.root, f.config, fake);
  // text_ops: an earlier run left it blocked; main: no run has tried it.
  writeJSON(statePath(f.root, f.units[1]), { schemaVersion: 1, ...f.units[1], status: 'blocked', stage: 'review', error: 'Copilot reviewer-rules ran past its call limit of 30 min (workerCallMinutes) on 2 attempts in a row' });
  fs.rmSync(statePath(f.root, f.units[2]));
  const full = migrationStatus(f.root), fast = statusSnapshot(f.root);
  for (const report of [full, fast]) {
    assert.equal(report.units.length, 3, 'the JSON keeps every unit');
    assert.deepEqual(report.units.map(u => u.recorded), [true, true, false]);
    const md = statusMarkdown(report), ja = statusMarkdown(report, 'ja');
    assert.match(md, /- ported\/text_ops\.mjs: (?:stopped|blocked) — /);
    assert.doesNotMatch(md, /- ported\/math_ops\.mjs:|- ported\/main\.mjs:/);
    assert.match(md, /^Other units: 1 done, 1 not started\.$/m);
    assert.match(ja, /^ほかの単位: 完了 1、未着手 1。$/m);
  }
  assert.match(statusMarkdown(fast), /- ported\/text_ops\.mjs: blocked — Copilot reviewer-rules ran past its call limit/);
  // A unit whose state file says pending or implement is listed; one without a state file is counted.
  writeJSON(statePath(f.root, f.units[2]), { schemaVersion: 1, ...f.units[2], status: 'pending', stage: 'implement' });
  const md = statusMarkdown(statusSnapshot(f.root));
  assert.match(md, /- ported\/main\.mjs: pending/);
  assert.match(md, /^Other units: 1 done\.$/m);
  // A report of an older kit (no recorded) lists every unit as before.
  const old = { ...full, units: full.units.map(({ recorded, ...u }) => u) };
  assert.match(statusMarkdown(old), /- ported\/math_ops\.mjs: done/);
  assert.doesNotMatch(statusMarkdown(old), /Other units/);
});

// Trimmed from a real Copilot CLI 1.0.105 run (gpt-6-luna against a loopback
// provider, 2026-11-05): the events the kit keeps, with the paths moved under
// ROOT and every text left out. The first view was turned down as too large
// (largeOutputAvoided), the second read a range, the third used
// forceReadLargeFiles, then three searches.
const realLines = [
  '{"type":"user.message","data":{"content":"(prompt omitted)"}}',
  '{"type":"assistant.turn_start","data":{"turnId":"0"}}',
  '{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"call_1","name":"view","arguments":{"path":"ROOT/src/Database.designer.cs"}}]}}',
  '{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"view","arguments":{"path":"ROOT/src/Database.designer.cs"}}}',
  '{"type":"tool.execution_complete","data":{"toolCallId":"call_1","success":true,"result":{"content":"(file text omitted)"},"toolTelemetry":{"properties":{"command":"view","largeOutputAvoided":"true"},"metrics":{"context_token_limit":922000,"context_current_tokens":3836,"result_token_count":35}}}}',
  '{"type":"assistant.turn_end","data":{"turnId":"0"}}',
  '{"type":"assistant.turn_start","data":{"turnId":"1"}}',
  '{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"call_2","name":"view","arguments":{"path":"ROOT/src/Database.designer.cs","view_range":[100,140]}}]}}',
  '{"type":"tool.execution_start","data":{"toolCallId":"call_2","toolName":"view","arguments":{"path":"ROOT/src/Database.designer.cs","view_range":[100,140]}}}',
  '{"type":"tool.execution_complete","data":{"toolCallId":"call_2","success":true,"result":{"content":"(file text omitted)"},"toolTelemetry":{"properties":{"command":"view"},"metrics":{"context_token_limit":922000,"context_current_tokens":3884,"result_token_count":669}}}}',
  '{"type":"assistant.turn_end","data":{"turnId":"1"}}',
  '{"type":"assistant.turn_start","data":{"turnId":"2"}}',
  '{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"call_3","name":"view","arguments":{"path":"ROOT/src/Database.designer.cs","forceReadLargeFiles":true}}]}}',
  '{"type":"tool.execution_start","data":{"toolCallId":"call_3","toolName":"view","arguments":{"path":"ROOT/src/Database.designer.cs","forceReadLargeFiles":true}}}',
  '{"type":"tool.execution_complete","data":{"toolCallId":"call_3","success":true,"result":{"content":"(file text omitted)"},"toolTelemetry":{"properties":{"command":"view"},"metrics":{"context_token_limit":922000,"context_current_tokens":4566,"result_token_count_estimate":249103}}}}',
  '{"type":"assistant.turn_end","data":{"turnId":"2"}}',
  '{"type":"assistant.turn_start","data":{"turnId":"3"}}',
  '{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"call_4","name":"rg","arguments":{"pattern":"Table123DataTable","paths":"ROOT/src/Database.designer.cs","output_mode":"content","-n":true}}]}}',
  '{"type":"tool.execution_start","data":{"toolCallId":"call_4","toolName":"rg","arguments":{"pattern":"Table123DataTable","paths":"ROOT/src/Database.designer.cs","output_mode":"content","-n":true}}}',
  '{"type":"tool.execution_complete","data":{"toolCallId":"call_4","success":true,"result":{"content":"(file text omitted)"},"toolTelemetry":{"properties":{"output_mode":"content","search_engine":"ripgrep"},"metrics":{"context_token_limit":922000,"context_current_tokens":251847,"result_token_count":162}}}}',
  '{"type":"assistant.turn_end","data":{"turnId":"3"}}',
  '{"type":"assistant.turn_start","data":{"turnId":"4"}}',
  '{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"call_5","name":"rg","arguments":{"pattern":"Table123DataTable","paths":"ROOT","glob":"src/Database.designer.cs","output_mode":"content","-n":true}}]}}',
  '{"type":"tool.execution_start","data":{"toolCallId":"call_5","toolName":"rg","arguments":{"pattern":"Table123DataTable","paths":"ROOT","glob":"src/Database.designer.cs","output_mode":"content","-n":true}}}',
  '{"type":"tool.execution_complete","data":{"toolCallId":"call_5","success":true,"result":{"content":"(file text omitted)"},"toolTelemetry":{"properties":{"output_mode":"content","search_engine":"ripgrep"},"metrics":{"context_token_limit":922000,"context_current_tokens":252022,"result_token_count":162}}}}',
  '{"type":"assistant.turn_end","data":{"turnId":"4"}}',
  '{"type":"assistant.turn_start","data":{"turnId":"5"}}',
  '{"type":"assistant.message","data":{"content":"","toolRequests":[{"toolCallId":"call_6","name":"rg","arguments":{"pattern":"Table1\\\\d\\\\dDataTable\\\\(\\\\)","paths":"ROOT","glob":"src/Database.designer.cs","output_mode":"content","-n":true}}]}}',
  '{"type":"tool.execution_start","data":{"toolCallId":"call_6","toolName":"rg","arguments":{"pattern":"Table1\\\\d\\\\dDataTable\\\\(\\\\)","paths":"ROOT","glob":"src/Database.designer.cs","output_mode":"content","-n":true}}}',
  '{"type":"tool.execution_complete","data":{"toolCallId":"call_6","success":true,"result":{"content":"(file text omitted)"},"toolTelemetry":{"properties":{"large_output":"true","output_mode":"content","search_engine":"ripgrep"},"metrics":{"context_token_limit":922000,"context_current_tokens":252197,"result_token_count":5354}}}}',
  '{"type":"assistant.turn_end","data":{"turnId":"5"}}',
  '{"type":"assistant.turn_start","data":{"turnId":"6"}}',
  '{"type":"assistant.message","data":{"content":"(answer omitted)","toolRequests":[]}}',
  '{"type":"assistant.turn_end","data":{"turnId":"6"}}',
  '{"type":"result","data":{}}'];
const under = root => line => JSON.stringify(JSON.parse(line, (k, v) => typeof v === 'string' && v.startsWith('ROOT') ? root + v.slice(4) : v));

test('what a call did is counted from the CLI\'s own JSON lines (CLI 1.0.105): turns, tools, the files viewed most, refusals and the context, never content', () => {
  const root = path.join(os.tmpdir(), 'activity-root'), lines = realLines.map(under(root));
  const activity = callActivity(lines, root);
  // context_current_tokens is the context before a result is added; with
  // result_token_count, after it (the last search: 252197 + 5354). The whole
  // 1 MB file read with forceReadLargeFiles carries only an estimate
  // (4566 + 249103), which counts for a call stopped in the turn after it.
  assert.deepEqual(activity, { turns: 7, tools: { rg: 3, view: 3 }, views: [{ path: 'src/Database.designer.cs', views: 3, refused: 1 }], contextTokens: 257551, contextLimit: 922000, compactions: null });
  assert.equal(callActivity(lines.slice(0, 15), root).contextTokens, 253669, 'the estimate of the 1 MB result');
  assert.equal(callActivity(['{"type":"tool.execution_complete","data":{"toolCallId":"c","toolTelemetry":{"metrics":{"context_current_tokens":3836,"result_token_count":"x","result_token_count_estimate":35}}}}'], root).contextTokens, 3871, 'an invalid count falls back to the estimate');
  assert.equal(activitySummary(activity), '7 model turns, 6 tool calls, src/Database.designer.cs viewed 3 times, context up to 257551 tokens of 922000');
  assert.equal(activitySummary(activity, { withPath: false }), '7 model turns, 6 tool calls, a file viewed 3 times, context up to 257551 tokens of 922000');
  assert.doesNotMatch(JSON.stringify(activity), /omitted|Table123|activity-root|view_range|forceReadLargeFiles/);
  // A subagent's events are its own; a file outside the project is counted
  // without its name; more than five files: the rest as a count; a
  // compaction is counted once the CLI writes one (1.0.106).
  const extra = [
    { type: 'assistant.turn_start', agentId: 'sub-1', data: {} },
    { type: 'tool.execution_start', data: { toolCallId: 's1', toolName: 'view', parentToolCallId: 'call_9', arguments: { path: `${root}/src/a.cs` } } },
    { type: 'tool.execution_start', data: { toolCallId: 'o1', toolName: 'view', arguments: { path: path.join(os.tmpdir(), 'elsewhere', 'secret.txt') } } },
    ...['a', 'b', 'c', 'd', 'e'].map((n, i) => ({ type: 'tool.execution_start', data: { toolCallId: `m${i}`, toolName: 'view', arguments: { path: `src/${n}.cs` } } })),
    { type: 'session.compaction_complete', data: {} },
    'not json', '{"type":', 42].map(e => typeof e === 'string' ? e : JSON.stringify(e));
  const more = callActivity([...lines, ...extra], root);
  assert.equal(more.turns, 7); assert.equal(more.tools.view, 9);
  assert.equal(more.outsideViews, 1); assert.doesNotMatch(JSON.stringify(more), /secret|elsewhere/);
  assert.deepEqual(more.views.map(v => v.path), ['src/Database.designer.cs', 'src/a.cs', 'src/b.cs', 'src/c.cs', 'src/d.cs']);
  assert.equal(more.moreViews, 1);
  assert.equal(more.compactions, 1);
  assert.equal(activitySummary(more), '7 model turns, 12 tool calls, src/Database.designer.cs viewed 3 times, context up to 257551 tokens of 922000, 1 compactions');
  assert.equal(activitySummary(undefined), '');
  // A name of the project may start with two dots; the folder above may not.
  const dots = [`${root}/..config.cs`, `${root}/../other/x.cs`].map((p, i) => JSON.stringify({ type: 'tool.execution_start', data: { toolCallId: `d${i}`, toolName: 'view', arguments: { path: p } } }));
  const named = callActivity(dots, root);
  assert.deepEqual(named.views, [{ path: '..config.cs', views: 1 }]); assert.equal(named.outsideViews, 1);
  assert.deepEqual(callActivity([], root), { turns: 0, tools: {}, views: [], contextTokens: null, contextLimit: null, compactions: null });
});

test('each call\'s record keeps what it did and how its input was given, on success too', async t => {
  const f = await continuous(t, { count: 3 });
  f.config.maxReviewInputBytes = 1400; writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  const responses = Object.fromEntries(f.units.flatMap(u => ['implementer', 'reviewer-semantics', 'reviewer-rules', 'arbiter', 'fixer'].map(role => [`${role}:${u.target}`, result(role, u)])));
  const file = safePath(f.root, 'events-cli.mjs');
  atomicWrite(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const role = process.env.MIGRATION_KIT_ROLE.replace(/-read$/, ''), target = prompt.match(/Set target to "([^"]+)"/)?.[1];
const out = e => console.log(JSON.stringify(e));
out({ type: 'assistant.turn_start', data: {} });
out({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'src/math_ops.py' } } });
out({ type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'x' }, toolTelemetry: { metrics: { context_current_tokens: 5000, context_token_limit: 922000 } } } });
out({ type: 'assistant.turn_start', data: {} });
out({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(responses)}[role + ':' + target]), toolRequests: [] } });
out({ type: 'result', exitCode: 0 });
`);
  const report = await translate(f.root, f.config, createCopilotAdapter({ command: process.execPath, prefixArgs: [file] }));
  assert.equal(report.done, 3, JSON.stringify(report.errors));
  const records = attempts(f, report.runId);
  assert.ok(records.length >= 9);
  for (const r of records) {
    assert.equal(r.status, 'success');
    assert.deepEqual(r.activity, { turns: 2, tools: { view: 1 }, views: [{ path: 'src/math_ops.py', views: 1 }], contextTokens: 5000, contextLimit: 922000, compactions: null }, r.role);
    assert.equal(r.callLimitMinutes, 30);
  }
  const implementers = Object.fromEntries(records.filter(r => r.role === 'implementer').map(r => [r.unit.target, r.workInputMode]));
  assert.deepEqual(implementers, { 'ported/math_ops.mjs': 'frozen', 'ported/text_ops.mjs': 'frozen', 'ported/main.mjs': 'tool-assisted' });
  assert.ok(records.filter(r => r.role.startsWith('reviewer-')).every(r => r.workInputMode === undefined && typeof r.reviewInputMode === 'string'));
});

test('updating to 0.47.0 keeps every finished file: the reading rule, the read-only reviewer and arbiter profiles and workerCallMinutes are no input of a finished unit', async t => {
  const f = await ready(t, { count: 2 });
  await translate(f.root, f.config, fake);
  const scopes = scopesOf(f.root, f.config);
  for (const name of ['reviewer-rules-read', 'reviewer-semantics-read', 'arbiter'])
    fs.appendFileSync(safePath(f.root, `.github/agents/migration-${name}.agent.md`), '\nRead a dependency only where the unit uses it.\n');
  writeJSON(safePath(f.root, 'migration/state/config.json'), { ...f.config, workerCallMinutes: 45 });
  const config = loadConfig(f.root), context = inputContext(f.root, config);
  assert.equal(scopesOf(f.root, config), scopes);
  assert.ok(f.units.every(u => done(f.root, u, context)));
  assert.equal((await translate(f.root, config, fake)).agentCalls, 0);
});

test('doctor warns of a worker profile an update left from 0.46.1 or earlier, whose reading rule the prompt replaces', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const clean = await doctor(f.root, f.config);
  assert.ok(!clean.checks.some(c => / reading rule$/.test(c.check)), JSON.stringify(clean.warnings));
  const profile = safePath(f.root, '.github/agents/migration-reviewer-rules-read.agent.md');
  const text = fs.readFileSync(profile, 'utf8'), old = text.replace(/Read in full, before judging,[\s\S]*?Search only inside the listed files\./, 'Read every listed file in full with view before judging; use grep/glob only inside those files.');
  assert.notEqual(old, text);
  fs.writeFileSync(profile, old);
  const arbiter = safePath(f.root, '.github/agents/migration-arbiter.agent.md');
  fs.writeFileSync(arbiter, fs.readFileSync(arbiter, 'utf8').replace('For human setup: [operating manual]', 'Read [the operating manual]'));
  const report = await doctor(f.root, f.config);
  const warned = report.checks.filter(c => / reading rule$/.test(c.check));
  assert.deepEqual(warned.map(c => c.check), ['arbiter: reading rule', 'reviewer-rules-read: reading rule']);
  assert.ok(warned.every(c => c.ok === true && c.status === 'outdated'));
  assert.equal(report.staticValid, clean.staticValid, 'a warning, not a failed check');
  assert.ok(report.warnings.some(w => w.startsWith('reviewer-rules-read: reading rule: .github/agents/migration-reviewer-rules-read.agent.md is from kit 0.46.1 or earlier')), JSON.stringify(report.warnings));
});

test('the fast view reads a running call record whole, but only the head of a finished one, which holds the worker\'s whole answer', t => {
  const f = prepare(t);
  const dir = safePath(f.root, 'migration/runs/run-1'), id = f.units[0].id;
  const name = role => `${id}-1-${role}-${'0'.repeat(8)}.json`;
  writeJSON(path.join(dir, name('reviewer-rules')), { role: 'reviewer-rules', unit: f.units[0], startedAt: '2026-11-05T00:00:00.000Z', status: 'running', callLimitMinutes: 30 });
  // A finished record: its status near the top, then (here) text that is no JSON.
  atomicWrite(path.join(dir, name('implementer')), `{\n  "role": "implementer",\n  "unit": ${JSON.stringify(f.units[0], null, 2).replace(/\n/g, '\n  ')},\n  "startedAt": "2026-11-05T00:00:00.000Z",\n  "status": "success",\n  "result": ${'x'.repeat(40000)}`);
  // A record whose head shows no status is read whole.
  atomicWrite(path.join(dir, name('arbiter')), '{"role":"arbiter","status":"running","unit":' + JSON.stringify(f.units[0]) + '}');
  const errors = [];
  const found = runningAttempts(f.root, 'run-1', { units: new Set([id]), onError: (p, reason) => errors.push(p) });
  assert.deepEqual(found.map(a => a.role).sort(), ['arbiter', 'reviewer-rules']);
  assert.deepEqual(errors, [], 'the finished record was not parsed');
});
