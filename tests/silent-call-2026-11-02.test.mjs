// SPDX-License-Identifier: Apache-2.0
// 2026-11-02 (Windows, kit 0.42.0, Copilot app, company VPN): phase 04 stayed
// at 96 of 554 for 11 h 43 min. One review call never returned and the runner,
// with no time limit in continuous mode, waited for it forever. The computer
// did not sleep, but its connection dropped after the screen was locked, and
// the VPN's posture check (Cisco Secure Client ISE Posture) often gets lost: a
// connection lost that way gives the CLI no error, and Copilot CLI 1.0.105
// waits on a stalled stream without end (checked against a loopback provider).
// Workers now stream (--stream on), a call that writes nothing for
// workerSilenceSeconds (600 s by default) is stopped and retried with a longer
// wait each time, a call that stays silent blocks only its own file, which the
// run tries once more at its end, and the network errors a VPN or a sleeping
// network leaves behind (a name that does not resolve, Windows and Rust
// wordings, an answer cut off in the middle, a token check that could not reach
// GitHub) are retried instead of blocking a file at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, ready, fake, result } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, loadConfig, contextHash, roles } from '../lib/core.mjs';
import { translate } from '../lib/pipeline.mjs';
import { runProcess, silentProcessMessage, silenceWatch, processOutputLines } from '../lib/process.mjs';
import { workerSilenceMs, silenceWait, defaultWorkerSilenceSeconds } from '../lib/execution-policy.mjs';
import { createCopilotAdapter, copilotArgs, isStreamedDelta } from '../scripts/copilot_adapter.mjs';
import { isTransientFailure, isSystemicFailure, isLimitedRetry, isSilentCall, isSignInDoubt, isSignedOut, networkFailurePattern, hostStallRetries, stoppedWithRun, retryCause } from '../lib/failures.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { runSurvey } from '../lib/survey.mjs';
import { initSourceSpec } from '../lib/source-spec.mjs';
import { freezeAudit, runAudit } from '../scripts/audit_inputs.mjs';
import { sessionsStatus } from '../lib/sessions.mjs';

const node = (code, options) => runProcess(process.execPath, ['-e', code], options);
const gone = pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
const silentError = (seconds = 600) => Object.assign(new Error(silentProcessMessage(seconds * 1000)), { silent: true });

test('a child that writes nothing for the silence wait is stopped as a silent call; one that keeps writing never is', async () => {
  const quiet = await node('process.stdout.write("started\\n"); setInterval(() => {}, 1000);', { silenceMs: 300 }).then(() => null, e => e);
  assert.ok(quiet, 'the silent child is stopped');
  assert.equal(quiet.silent, true);
  assert.match(quiet.message, /^Process showed no sign of progress for 0s \(nothing on stdout or stderr\); stopped as a silent call$/);
  assert.equal(quiet.spawned, true);
  assert.equal(quiet.result.code, null, 'a stopped child has no exit status of its own');
  assert.match(quiet.result.stdout, /started/, 'what it wrote before going silent is kept');
  assert.equal(isSilentCall(quiet), true);
  // Slow but alive: output every 100 ms (stdout or stderr) for over twice the wait.
  for (const stream of ['stdout', 'stderr']) {
    const alive = await node(`let n = 0; const t = setInterval(() => { process.${stream}.write('.'); if (++n === 25) { clearInterval(t); } }, 100);`, { silenceMs: 1000 });
    assert.equal(alive.code, 0, stream);
    assert.equal(alive[stream], '.'.repeat(25), stream);
  }
  // Off by default and with 0: a quiet child is waited on as before.
  for (const options of [{}, { silenceMs: 0 }]) {
    const waited = await node('setTimeout(() => process.stdout.write("late"), 500);', options);
    assert.equal(waited.code, 0); assert.equal(waited.stdout, 'late');
  }
  for (const silenceMs of [-1, NaN, Infinity]) assert.throws(() => runProcess(process.execPath, ['-e', ''], { silenceMs }), /silence wait/);
});

test('a stopped silent child is gone, its process group too', async t => {
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'silent-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pids = path.join(dir, 'pids.json');
  const failure = await node(`const { spawn } = require('node:child_process');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, kid.pid]));
setInterval(() => {}, 1000);`, { silenceMs: 1500 }).then(() => null, e => e);
  assert.ok(failure?.silent, 'stopped for silence');
  const [parent, kid] = JSON.parse(fs.readFileSync(pids, 'utf8'));
  for (let i = 0; i < 50 && !(gone(parent) && gone(kid)); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(gone(parent), true, 'the silent child is gone');
  assert.equal(gone(kid), true, 'and so is the process it started');
});

test('a late timer (the computer slept, or the runner was paused) does not count the whole gap as silence', async t => {
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'silent-pause-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = async block => {
    const flag = path.join(dir, `ready-${block}`);
    // The child says it started, waits 2.3 s without a word, then answers.
    const child = node(`process.stdout.write('started\\n'); require('node:fs').writeFileSync(${JSON.stringify(flag)}, '');
setTimeout(() => process.stdout.write('answer\\n'), 2300);`, { silenceMs: 1000 });
    if (block) {
      while (!fs.existsSync(flag)) await new Promise(r => setTimeout(r, 5));
      // The runner's own event loop stops for 2 s, as while the computer sleeps.
      const until = Date.now() + 2000; while (Date.now() < until) {}
    }
    return child.then(r => r, e => e);
  };
  const paused = await run(true);
  assert.equal(paused.code, 0, 'the pause counted as two steps, not 2 s');
  assert.match(paused.stdout, /answer/);
  // The same child without the pause is silent for longer than the wait.
  const control = await run(false);
  assert.equal(control.silent, true, 'without the pause, 2.3 s of silence passes the 1 s wait');
});

test('output that waited in a pipe while the runner was busy still counts, even when the wait ran out meanwhile', async t => {
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'silent-pipe-'));
  // The watch reads its clock from performance.now: driven by hand here, so
  // the wait runs out at the first step after the runner's pause, whatever the
  // timers' own timing (setTimeout and Date.now are not touched).
  const real = performance.now;
  let now = 0;
  performance.now = () => now;
  t.after(() => { performance.now = real; fs.rmSync(dir, { recursive: true, force: true }); });
  const run = async answer => {
    const flag = path.join(dir, `ready-${answer}`), go = path.join(dir, `go-${answer}`);
    // The child says it started and answers as soon as the go file is there.
    const child = node(`const fs = require('node:fs'); process.stdout.write('started\\n'); fs.writeFileSync(${JSON.stringify(flag)}, '');
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(t); process.stdout.write('answer\\n'); setTimeout(() => {}, 100); } }, 5);`, { silenceMs: 1000 }).then(r => r, e => e);
    while (!fs.existsSync(flag)) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 60));
    // Nine steps of 100 ms (a step is 50 ms; a late one counts twice at most).
    for (let i = 0; i < 9; i++) { now += 100; await new Promise(r => setTimeout(r, 120)); }
    // The wait runs out at the next step, while the runner is busy for 400 ms
    // and the child answers. Busy outside the timers (as after a worker call
    // or a read), so the next turn of the event loop starts with the step.
    now += 1000;
    if (answer) fs.writeFileSync(go, '');
    await new Promise(r => setImmediate(() => { const until = Date.now() + 400; while (Date.now() < until) {} r(); }));
    const settled = await Promise.race([child, new Promise(r => setTimeout(() => r('still waiting'), 1500))]);
    if (settled === 'still waiting') fs.writeFileSync(go, '');
    return settled === 'still waiting' ? child : settled;
  };
  const answered = await run(true);
  assert.equal(answered.code, 0, 'the answer that waited in the pipe kept the call');
  assert.match(answered.stdout, /answer/);
  // Without the answer, the same wait stops the call.
  const silent = await run(false);
  assert.equal(silent.silent, true, 'a child that stayed silent is stopped');
});

test('silence counts from the last output, and a late step counts as two steps at most', () => {
  let now = 0;
  const watch = silenceWatch(1000, () => now);
  assert.equal(watch.step, 50);
  // Output just before a step: the step counts only the time since that output.
  for (let i = 0; i < 19; i++) { now += 50; watch.tick(); }
  now += 49; watch.activity();
  now += 1; assert.equal(watch.tick(), false);
  for (let i = 0; i < 19; i++) { now += 50; assert.equal(watch.tick(), false, `step ${i}`); }
  now += 48; assert.equal(watch.tick(), false, '999 ms after the output');
  now += 1; assert.equal(watch.tick(), true, '1000 ms after the output');
  assert.equal(watch.silent, true);
  watch.activity(); assert.equal(watch.silent, false);
  // A step an hour late (the computer slept) adds two steps, not the hour.
  now += 3600000; assert.equal(watch.tick(), false);
  for (let i = 0; i < 17; i++) { now += 50; assert.equal(watch.tick(), false, `after the sleep, step ${i}`); }
  now += 50; assert.equal(watch.tick(), true);
  // Steps of a twentieth of the wait, from 20 ms to 30 s.
  assert.deepEqual([100, 1000, 600000, 2400000].map(ms => silenceWatch(ms, () => 0).step), [20, 50, 30000, 30000]);
});

test('dropped stdout lines show the child at work but are not kept, spilled or hashed; other lines are kept whole', async t => {
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'silent-drop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 300 pieces, a line split over two writes, a long line kept as it comes, a last line without a newline.
  const r = await node(`const out = s => process.stdout.write(s);
out('{"type":"assistant.turn_start"}\\n');
for (let i = 0; i < 300; i++) out(JSON.stringify({ type: i % 2 ? 'assistant.message_delta' : 'assistant.reasoning_delta', data: { deltaContent: 'x'.repeat(200) } }) + '\\n');
out('{"type":"assistant.mess'); setTimeout(() => { out('age","data":{"content":"' + 'y'.repeat(200000) + '"}}\\n{"type":"result","exitCode":0}'); process.stderr.write('note\\n'); }, 50);`,
    { dropLine: isStreamedDelta, maxBytes: 100000, outputDir: dir });
  assert.equal(r.code, 0);
  assert.equal(r.droppedLines, 300);
  assert.equal(r.outputSpooled, true, 'the long line still spills');
  const lines = [...processOutputLines(r)].filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.type), ['assistant.turn_start', 'assistant.message', 'result']);
  assert.equal(lines[1].data.content, 'y'.repeat(200000));
  assert.equal(fs.readFileSync(r.stdoutFile, 'utf8').includes('_delta'), false, 'the spilled log holds no piece');
  assert.equal(r.stderr, 'note\n', 'stderr is never filtered');
  // A last piece without a newline is dropped too; a predicate that throws keeps the line.
  const last = await node(`process.stdout.write('{"type":"assistant.message_delta","data":{}}')`, { dropLine: isStreamedDelta });
  assert.deepEqual([last.stdout, last.droppedLines], ['', 1]);
  const kept = await node(`process.stdout.write('a\\nb\\n')`, { dropLine: () => { throw new Error('x'); } });
  assert.deepEqual([kept.stdout, kept.droppedLines], ['a\nb\n', undefined]);
  // However the predicate answers, a line over 64 KiB is never dropped, in one write or in two.
  for (const code of [`process.stdout.write('x'.repeat(100000) + '\\n')`, `process.stdout.write('x'.repeat(60000)); setTimeout(() => process.stdout.write('x'.repeat(40000) + '\\n'), 50)`, `process.stdout.write('x'.repeat(100000))`]) {
    const long = await node(code, { dropLine: () => true });
    assert.deepEqual([long.stdout.replace(/\n$/, '').length, long.droppedLines], [100000, undefined], code);
  }
  // Only the two delta types, and only short lines that are JSON.
  for (const line of ['{"type":"assistant.message","data":{"content":"see assistant.message_delta"}}', 'not json _delta"', `{"type":"assistant.message_delta","pad":"${'z'.repeat(70000)}"}`])
    assert.equal(isStreamedDelta(Buffer.from(line)), false, line.slice(0, 60));
  // Pieces keep a silent watch at bay, though none is kept.
  const busy = await node(`let n = 0; const t = setInterval(() => { process.stdout.write('{"type":"assistant.reasoning_delta","data":{}}\\n'); if (++n === 25) clearInterval(t); }, 100);`, { silenceMs: 1000, dropLine: isStreamedDelta });
  assert.deepEqual([busy.code, busy.stdout, busy.droppedLines], [0, '', 25]);
});

test('a stopped call ends even while a process outside its tree holds its pipes open', { skip: process.platform === 'win32' && 'a POSIX session of its own' }, async t => {
  // The child starts a grandchild in a session of its own, outside the process
  // group the runner kills, that keeps stdout and stderr open for a minute.
  let grandchild;
  t.after(() => { if (grandchild) try { process.kill(grandchild, 'SIGKILL'); } catch {} });
  const started = performance.now();
  const run = node(`const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
process.stderr.write('grandchild ' + g.pid + '\\n'); g.unref(); setInterval(() => {}, 1000);`, { silenceMs: 1000 }).then(() => null, e => e);
  const failure = await Promise.race([run, new Promise(resolve => setTimeout(() => resolve('never settled'), 30000))]);
  assert.notEqual(failure, 'never settled');
  grandchild = Number(failure.result.stderr.match(/grandchild (\d+)/)?.[1]) || undefined;
  assert.ok(grandchild && !gone(grandchild), 'the grandchild was outside the tree and still runs');
  assert.equal(failure.silent, true);
  assert.match(failure.message, /no sign of progress/);
  // About 1 s of silence, 1.5 s from SIGTERM to SIGKILL, then 5 s for the pipes.
  assert.ok(performance.now() - started < 20000, `${Math.round(performance.now() - started)} ms`);
});

test('on Windows a silent child is stopped with taskkill, and still stopped if taskkill cannot run', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let failure;
  try { failure = await node('setInterval(() => {}, 1000);', { silenceMs: 1000 }).then(() => null, e => e); }
  finally { Object.defineProperty(process, 'platform', platform); }
  assert.ok(failure, 'stopped');
  assert.equal(failure.silent, true);
  // Here taskkill does not exist: the child itself is killed, and the failure stays a silent call.
  if (process.platform !== 'win32') assert.match(failure.message, /stopped as a silent call; taskkill failed/);
  assert.equal(isSilentCall(failure), true); assert.equal(isTransientFailure(failure), true);
  assert.equal(failure.result.code, null);
});

test('a child that exits while a process outside its tree holds its pipes still ends the call, with its own output and exit code', { skip: process.platform === 'win32' && 'a POSIX session of its own' }, async t => {
  // Without the silence check: before 0.44.0 this waited as long as the grandchild ran.
  let grandchild;
  t.after(() => { if (grandchild) try { process.kill(grandchild, 'SIGKILL'); } catch {} });
  const started = performance.now();
  const run = node(`const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
process.stderr.write('grandchild ' + g.pid + '\\n'); g.unref(); process.stdout.write('done\\n');`);
  const outcome = await Promise.race([run, new Promise(resolve => setTimeout(() => resolve('never settled'), 30000))]);
  assert.notEqual(outcome, 'never settled');
  grandchild = Number(outcome.stderr.match(/grandchild (\d+)/)?.[1]) || undefined;
  assert.ok(grandchild && !gone(grandchild), 'the grandchild was outside the tree and still runs');
  assert.equal(outcome.code, 0); assert.equal(outcome.stdout, 'done\n');
  // 5 s for the pipes after the child is gone.
  assert.ok(performance.now() - started < 20000, `${Math.round(performance.now() - started)} ms`);
  // A child whose pipes close with it ends at once.
  const quick = performance.now();
  assert.equal((await node('process.stdout.write("ok")')).stdout, 'ok');
  assert.ok(performance.now() - quick < 4000, `${Math.round(performance.now() - quick)} ms`);
  // A child that was quiet before it exited is neither a silent call nor one
  // past its deadline while its pipes wait (here the wait outlasts both).
  const others = [];
  t.after(() => { for (const pid of others) try { process.kill(pid, 'SIGKILL'); } catch {} });
  for (const options of [{ silenceMs: 1500 }, { timeoutMs: 1500 }]) {
    const quiet = await node(`const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
process.stderr.write('grandchild ' + g.pid + '\\n'); g.unref(); setTimeout(() => process.exit(0), 300);`, options).then(r => r, e => e);
    const pid = Number(String(quiet.stderr ?? quiet.result?.stderr).match(/grandchild (\d+)/)?.[1]);
    if (pid) others.push(pid);
    assert.ok(!(quiet instanceof Error), `the exited child was stopped (${JSON.stringify(options)}): ${quiet.message}`);
    assert.equal(quiet.code, 0);
  }
});

test('what a child that ended by itself left running in its own process group, holding its pipes, is stopped as the runner lets them go', { skip: process.platform === 'win32' && 'a POSIX process group' }, async t => {
  // A stage command such as ["sh", "-c", "./app --port 8080 & sleep 2; curl ..."]:
  // the app stays in the command's group and holds its stdout and stderr. Left
  // running, it could answer the next run's checks in place of the new build.
  const pids = [];
  t.after(() => { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} });
  for (const [what, keeps] of [['one that stops on SIGTERM', 'setTimeout(() => {}, 60000)'], ['one that ignores SIGTERM', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"]]) {
    const started = performance.now();
    const run = node(`const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', ${JSON.stringify(keeps)}], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stderr.write('left ' + g.pid + '\\n'); g.unref(); process.stdout.write('done\\n'); setTimeout(() => process.exit(3), 300);`).then(r => r, e => e);
    const outcome = await Promise.race([run, new Promise(resolve => setTimeout(() => resolve('never settled'), 30000))]);
    assert.notEqual(outcome, 'never settled', what);
    const pid = Number(String(outcome.stderr ?? outcome.result?.stderr).match(/left (\d+)/)?.[1]);
    assert.ok(pid, what);
    pids.push(pid);
    assert.ok(!(outcome instanceof Error), `${what}: ${outcome.message}`);
    // The command's own exit code and output, as if nothing had been left.
    assert.deepEqual([outcome.code, outcome.stdout], [3, 'done\n'], what);
    for (let i = 0; i < 50 && !gone(pid); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(gone(pid), true, `${what} is stopped`);
    // 5 s for the pipes, and 1.5 s more for one that ignores SIGTERM.
    assert.ok(performance.now() - started < 20000, `${what}: ${Math.round(performance.now() - started)} ms`);
  }
  // A call the runner stopped keeps the stop it had: the group is killed once.
  const stopped = await node(`const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stderr.write('left ' + g.pid + '\\n'); g.unref(); setInterval(() => {}, 1000);`, { silenceMs: 1000 }).then(() => null, e => e);
  const left = Number(String(stopped?.result?.stderr).match(/left (\d+)/)?.[1]);
  if (left) pids.push(left);
  assert.equal(stopped?.silent, true);
  for (let i = 0; i < 50 && !gone(left); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(gone(left), true);
});

test('on Windows a taskkill that never finishes does not hold the call: the child is stopped and the call ends', { skip: process.platform === 'win32' && 'a stand-in taskkill on PATH' }, async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'taskkill-'));
  const pidFile = path.join(dir, 'pid');
  fs.writeFileSync(path.join(dir, 'taskkill'), `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 12\nexit 1\n`, { mode: 0o755 });
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'), PATH = process.env.PATH;
  Object.defineProperty(process, 'platform', { value: 'win32' }); process.env.PATH = `${dir}${path.delimiter}${PATH}`;
  const started = performance.now();
  let failure;
  try { failure = await Promise.race([node('setInterval(() => {}, 1000);', { silenceMs: 1000 }).then(() => null, e => e), new Promise(resolve => setTimeout(() => resolve('never settled'), 40000))]); }
  finally { Object.defineProperty(process, 'platform', platform); process.env.PATH = PATH; }
  assert.notEqual(failure, 'never settled');
  assert.ok(fs.existsSync(pidFile), 'the stand-in taskkill ran');
  assert.equal(failure.silent, true);
  assert.match(failure.message, /taskkill did not finish within 10 s/);
  assert.equal(isSilentCall(failure), true);
  // About 1 s of silence, then 10 s for taskkill.
  assert.ok(performance.now() - started < 25000, `${Math.round(performance.now() - started)} ms`);
  // The stand-in taskkill ends later, with an error: the settled call is left as it was.
  const settledMessage = failure.message, pid = Number(fs.readFileSync(pidFile, 'utf8'));
  while (!gone(pid)) await new Promise(resolve => setTimeout(resolve, 200));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(failure.message, settledMessage);
});

test('each silent retry of the same call waits twice as long, up to four times the setting; 0 turns the check off', () => {
  assert.equal(defaultWorkerSilenceSeconds, 600);
  assert.deepEqual([0, 1, 2, 3, 5, 99].map(n => workerSilenceMs({}, n)), [600000, 1200000, 2400000, 2400000, 2400000, 2400000]);
  assert.deepEqual([0, 1, 2].map(n => workerSilenceMs({ workerSilenceSeconds: 300 }, n)), [300000, 600000, 1200000]);
  assert.equal(workerSilenceMs({ workerSilenceSeconds: 0 }, 3), 0);
  assert.equal(silenceWait(100, -1), 100); assert.equal(silenceWait(100, NaN), 100); assert.equal(silenceWait(0, 2), 0);
  // Retries in continuous mode: 10 + 20 + 40 x 4 minutes before the file is left for the last pass.
  const total = Array.from({ length: hostStallRetries + 1 }, (_, n) => workerSilenceMs({}, n)).reduce((a, b) => a + b, 0);
  assert.equal(total / 60000, 190);
});

test('workerSilenceSeconds is 0 or 300 to 86400 seconds, and a run setting that keeps approvals', t => {
  const f = prepare(t);
  // Below 300 s a rate limit's Retry-After, which the CLI waits out without a word, could stop a call.
  for (const value of [0, 300, 600, 86400]) assert.doesNotThrow(() => loadConfig(f.root, { config: { ...f.config, workerSilenceSeconds: value } }), String(value));
  for (const value of [299, 180, 60, 1, -1, 86401, 1.5, '600', null]) assert.throws(() => loadConfig(f.root, { config: { ...f.config, workerSilenceSeconds: value } }), /workerSilenceSeconds must be 0 \(off\) or a whole number of seconds from 300 to 86400/, String(value));
  const config = loadConfig(f.root), before = contextHash(f.root, config);
  for (const value of [0, 1200]) {
    writeJSON(safePath(f.root, 'migration/config.json'), { ...config, workerSilenceSeconds: value });
    assert.equal(contextHash(f.root, loadConfig(f.root)), before, String(value));
  }
});

test('a silent call is a limited transient retry, never a stop; a cancellation or the kit\'s own deadline stays final', () => {
  const e = silentError();
  assert.equal(isSilentCall(e), true);
  assert.equal(isTransientFailure(e), true);
  assert.equal(isLimitedRetry(e), true);
  assert.equal(isSystemicFailure(e), false);
  // What the CLI prints when the runner stops it (CLI 1.0.105 on SIGTERM).
  const stopped = Object.assign(silentError(), { result: { stderr: 'Error executing prompt: Error: Cannot invoke native session after disposal has started\n' } });
  assert.equal(isTransientFailure(stopped), true);
  assert.equal(isSystemicFailure(stopped), false);
  // A CLI that says it was interrupted as the runner stops it was not cancelled.
  assert.equal(isTransientFailure(Object.assign(silentError(), { result: { stderr: 'Interrupted\n' } })), true);
  assert.equal(isTransientFailure(Object.assign(new Error('Copilot reviewer-rules failed (exit 1): x'), { result: { stderr: 'Interrupted\n' } })), false, 'other failures with it stay final');
  assert.equal(isTransientFailure(new Error(`Interrupted; ${e.message}`)), false);
  assert.equal(isTransientFailure(new Error(`Process timed out after 600000ms (explicit bounded deadline); ${e.message}`)), false);
  for (const language of ['ja', 'en']) {
    const g = failureGuidance(e, { language });
    assert.equal(g.id, 'cli-silent', language);
    assert.deepEqual(g.options.map(o => o.id), ['rerun', 'check-network', 'longer-wait', 'pause'], language);
  }
  assert.match(failureGuidance(e, { language: 'ja' }).cause, /ISE Posture/);
  // A network error the CLI printed before the silence is a hint, not the failure.
  assert.equal(failureGuidance(`${e.message}\nconnect ETIMEDOUT 140.82.112.21:443`).id, 'cli-silent');
  assert.notEqual(failureGuidance(`Interrupted; ${e.message}`).id, 'cli-silent');
});

test('a name that does not resolve, an unreachable network and the CLI\'s Windows and Rust wordings are retried network errors', () => {
  const messages = [
    'Copilot implementer failed (exit 1): Error: getaddrinfo ENOTFOUND api.githubcopilot.com',
    'Copilot reviewer-rules failed (exit 1): session.error query: error sending request for url (https://api.githubcopilot.com/chat/completions): client error (Connect): dns error: failed to lookup address information: No such host is known. (os error 11001)',
    'Copilot reviewer-semantics failed (exit 1): An existing connection was forcibly closed by the remote host. (os error 10054)',
    'Copilot implementer failed (exit 1): A connection attempt failed because the connected party did not properly respond after a period of time (os error 10060)',
    'Copilot implementer failed (exit 1): No connection could be made because the target machine actively refused it. (os error 10061)',
    'Copilot implementer failed (exit 1): An established connection was aborted by the software in your host machine. (os error 10053)',
    'Copilot arbiter failed (exit 1): connection closed before message completed',
    'Copilot implementer failed (exit 1): write ECONNABORTED',
    'Copilot implementer failed (exit 1): connect ENETUNREACH 140.82.112.21:443',
    'Copilot implementer failed (exit 1): connect EHOSTUNREACH 140.82.112.21:443',
    'Copilot implementer failed (exit 1): Network is unreachable (os error 101)',
    'Copilot implementer failed (exit 1): Connection refused (os error 111)',
    'Copilot implementer failed (exit 1): Connection reset by peer (os error 104)',
    'Copilot implementer failed (exit 1): TypeError: fetch failed (cause: UND_ERR_SOCKET other side closed)',
    'Copilot implementer failed (exit 1): Body Timeout Error (UND_ERR_BODY_TIMEOUT)',
    'Copilot implementer failed (exit 1): Headers Timeout Error',
    // CLI 1.0.105's native HTTP code.
    'Copilot implementer failed (exit 1): Failed native model HTTP request: Native model HTTP connect-stage timed out: 30s',
    'Copilot implementer failed (exit 1): error sending request for url (https://api.githubcopilot.com/chat/completions): client error (Connect): tcp connect error: deadline has elapsed',
    'Copilot implementer failed (exit 1): error decoding response body: peer closed connection without sending TLS close_notify: https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof',
    'Copilot implementer failed (exit 1): error sending request for url (https://api.githubcopilot.com/chat/completions): client error (Connect): tls handshake eof',
    'Copilot implementer failed (exit 1): proxy CONNECT I/O error: unexpected end of file',
    'Copilot implementer failed (exit 1): tunnel I/O error: unexpected end of file',
    'Copilot implementer failed (exit 1): proxy CONNECT did not complete within 30s',
    // GitHub's refusal for an organization's IP allow list: off the company network.
    'Copilot implementer failed (exit 1): 403 Forbidden: Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.'];
  for (const message of messages) {
    const e = new Error(message);
    assert.equal(networkFailurePattern.test(message), true, message);
    assert.equal(isTransientFailure(e), true, message);
    assert.equal(isLimitedRetry(e), false, `${message}: retried like the other network errors`);
    assert.equal(isSystemicFailure(e), false, message);
    assert.equal(failureGuidance(message, { language: 'en' }).id, 'cli-network', message);
  }
  // Next to the CLI's sign-in help: a doubt, retried a few times, not a stop.
  const withHelp = new Error(`${messages[0]}\nTo authenticate, you can use any of the following methods`);
  assert.equal(isSignInDoubt(withHelp), true); assert.equal(isSystemicFailure(withHelp), false); assert.equal(isLimitedRetry(withHelp), true);
  assert.equal(isSignedOut(withHelp), false, 'a network error is no reason to move workers to the person\'s home');
  // Other Windows socket codes and lookalikes are not network errors, and
  // neither is the Rust client's wrapper alone: a certificate, a proxy that
  // refuses the tunnel or a wrong address comes in it too.
  // tokio's generic "deadline has elapsed" counts only after a connect step.
  for (const message of ['Copilot implementer failed (exit 1): Too many levels of symbolic links (os error 10062)', 'Copilot implementer failed (exit 1): os error 100543', 'File name too long (os error 10063)',
    'Copilot implementer failed (exit 1): error sending request for url (https://api.githubcopilot.com/chat/completions): client error (Connect): unsuccessful tunnel',
    'Copilot implementer failed (exit 1): Error: plugin hook: deadline has elapsed'])
    assert.equal(networkFailurePattern.test(message), false, message);
  assert.equal(isTransientFailure(new Error('Copilot implementer failed (exit 1): error sending request for url (https://proxy.example/): client error (Connect): unsuccessful tunnel')), false);
  // An explicit rejection still stops the run.
  assert.equal(isSystemicFailure(new Error(`${messages[0]}; Bad credentials`)), true);
});

const helpText = '\n\nTo authenticate, you can use any of the following methods:\n  • Run the \'/login\' command';
const gaveUp = last => `Copilot implementer failed (exit 1): Failed to get response from the AI model; retried 5 times (total retry wait time: 23.00 seconds) Last error: ${last}`;
test('a model request the CLI gave up on is retried: as long as it lasts when its last error is a network error, a rate limit or a 5xx, a few times otherwise', () => {
  const kind = message => { const e = new Error(message); return { transient: isTransientFailure(e), limited: isLimitedRetry(e), systemic: isSystemicFailure(e), guidance: failureGuidance(message, { language: 'en' }).id }; };
  // An answer cut off in the middle (CLI 1.0.105's own wording) is a network error.
  assert.deepEqual(kind(gaveUp('Failed native model HTTP request: error decoding response body: error reading a body from connection: unexpected EOF during chunk size line')),
    { transient: true, limited: false, systemic: false, guidance: 'cli-network' });
  assert.deepEqual(kind(gaveUp('429 Too Many Requests')), { transient: true, limited: false, systemic: false, guidance: 'rate-limit' });
  assert.deepEqual(kind(gaveUp('503 Service Unavailable')).limited, false);
  for (const message of [gaveUp('Failed to finalize chat-completions stream: missing finish_reason for choice 0'), gaveUp('non-streaming response body was not valid JSON'),
    'Copilot implementer failed (exit 1): Failed to get response from the AI model; stopped after 4 attempts (900 seconds elapsed) because the slow-stream retry limit was reached. Last error: stream stalled'])
    assert.deepEqual(kind(message), { transient: true, limited: true, systemic: false, guidance: 'cli-gave-up' }, message);
  // What stops the run still does, and a cancellation stays final.
  assert.equal(kind(gaveUp('session.error quota_exceeded: AI Credits budget exceeded')).systemic, true);
  assert.equal(kind(gaveUp('401 Unauthorized')).systemic, true);
  assert.equal(isTransientFailure(new Error(`Interrupted; ${gaveUp('error reading a body from connection')}`)), false);
  // Without the CLI's wrapper, the same last error is what it was before 0.44.0.
  assert.equal(isTransientFailure(new Error('Copilot implementer failed (exit 1): Failed to finalize chat-completions stream: missing finish_reason for choice 0')), false);
});

test('a connection taken over (a certificate the computer does not trust, an answer not from GitHub) is retried a few times only, never as long as it lasts', () => {
  for (const message of [
    'Copilot implementer failed (exit 1): error sending request for url (https://api.githubcopilot.com/chat/completions): client error (Connect): invalid peer certificate: UnknownIssuer',
    gaveUp('error sending request for url (https://api.githubcopilot.com/chat/completions): error trying to connect: certificate verify failed: self-signed certificate in certificate chain'),
    'Copilot implementer failed (exit 1): TypeError: fetch failed (cause: unable to get local issuer certificate)',
    'Copilot implementer failed (exit 1): connect ECONNRESET; invalid peer certificate: NotValidForName',
    'Copilot implementer failed (exit 1): The response does not appear to originate from GitHub. Is a proxy or firewall intercepting this request?',
    // A proxy that asks for its own sign-in inside the tunnel (CLI 1.0.105, on a model call): `copilot login` cannot help.
    'Copilot implementer failed (exit 1): session.error query 407: 407 Proxy Authentication Required']) {
    const e = new Error(message);
    assert.equal(isTransientFailure(e), true, message);
    assert.equal(isLimitedRetry(e), true, `${message}: a few times only`);
    assert.equal(isSystemicFailure(e), false, message);
    assert.equal(isSignedOut(e), false, `${message}: no reason to move workers to the person's home`);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(message, { language }).id, 'cli-intercepted', `${message} (${language})`);
  }
  // The same words without the proxy are a sign-in problem, as before.
  for (const message of ['Copilot implementer failed (exit 1): Error: authentication required', 'Copilot implementer failed (exit 1): session.error authentication 401: Authentication failed'])
    assert.deepEqual([isSystemicFailure(new Error(message)), failureGuidance(message, { language: 'en' }).id], [true, 'copilot-auth'], message);
  assert.match(failureGuidance('invalid peer certificate: UnknownIssuer', { language: 'en' }).options.find(o => o.id === 'company-certificate').reason, /NODE_EXTRA_CA_CERTS/);
  // Node's certificate codes, each by name; a name that only starts like one is not.
  for (const code of ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])
    assert.equal(isLimitedRetry(new Error(`Copilot implementer failed (exit 1): TypeError: fetch failed (cause: ${code})`)), true, code);
  for (const message of ["Copilot implementer failed (exit 1): src/a.ts(3,1): error TS2304: Cannot find name 'cert_utils' in src/cert_manager.ts", 'Copilot implementer failed (exit 1): CERT_STORE_PATH is not set'])
    assert.equal(isTransientFailure(new Error(message)), false, message);
});

test('a token check the CLI could not make for the network is the network: retried as long as it lasts, never a stop, never a move to the person\'s home', () => {
  const check = errors => new Error(`Copilot implementer failed (exit 1): Error: Authentication token found but could not be validated.\n\n  ${errors}\n\nYour token may still be valid. Check your network connection and try again.${helpText}`);
  // CLI 1.0.105 prints the same for a refused or unknown proxy, a reset and an untrusted certificate.
  const lost = check('Failed to fetch PAT user login: network fetch failed: request failed: error sending request for url (https://api.github.com/copilot_internal/user)\n  Failed to fetch GitHub CLI user login: network fetch failed: request failed: error sending request for url (https://api.github.com/copilot_internal/user)');
  assert.equal(isTransientFailure(lost), true);
  assert.equal(isLimitedRetry(lost), false, 'not a sign-in in doubt: no retry limit in continuous mode');
  assert.equal(isSignInDoubt(lost), false);
  assert.equal(isSystemicFailure(lost), false);
  assert.equal(isSignedOut(lost), false);
  assert.equal(failureGuidance(lost, { language: 'en' }).id, 'cli-network');
  // With an error it does not know as a network error: a few times only, still no stop
  // (not a CLI 1.0.105 wording: its page with a 200, "Invalid Copilot user response", is a connection taken over).
  const unknown = check('Failed to fetch PAT user login: response validation failed: missing login');
  assert.deepEqual([isTransientFailure(unknown), isLimitedRetry(unknown), isSystemicFailure(unknown), isSignedOut(unknown)], [true, true, false, false]);
  assert.equal(failureGuidance(unknown, { language: 'en' }).id, 'cli-network');
  // The generic sign-in help next to a network error stays a doubt, a few times only.
  const doubt = new Error(`Copilot implementer failed (exit 1): connect ETIMEDOUT 140.82.112.21:443${helpText}`);
  assert.deepEqual([isTransientFailure(doubt), isLimitedRetry(doubt), isSignInDoubt(doubt), isSystemicFailure(doubt)], [true, true, true, false]);
  // A token GitHub refused stops the run, as before.
  assert.equal(isSystemicFailure(new Error(`${lost.message}\n401 Unauthorized`)), true);
  assert.equal(isSystemicFailure(new Error(`Copilot implementer failed (exit 1): Error: No authentication information found.${helpText}`)), true);
});

const tokenCheck = errors => new Error(`Copilot implementer failed (exit 1): Error: Authentication token found but could not be validated.\n\n  ${errors}\n\nYour token may still be valid. Check your network connection and try again.${helpText}`);
test('a token check GitHub answered with a refusal stops the run as before; a rate limit or a 5xx in it is retried, an IP allow list is the network, and a page not from GitHub is a connection taken over', async t => {
  // CLI 1.0.105 when GitHub answers the check with its own error body (JSON
  // with a message): "GitHub returned: <message>" (checked through an
  // inspecting proxy with a test CA).
  const both = (status, rest) => `Failed to fetch PAT user login (${status}): ${rest}\n  Failed to fetch GitHub CLI user login (${status}): ${rest}`;
  for (const [status, body] of [[401, 'Bad credentials'], [403, 'Resource not accessible by integration'], [403, 'This GitHub API path is not available: sessions are bound to their configured repositories.'], [404, 'Not Found']]) {
    const refused = tokenCheck(both(status, `GitHub returned: ${body}`));
    assert.deepEqual([isSystemicFailure(refused), isTransientFailure(refused)], [true, false], `${status} ${body}`);
    assert.equal(isSignedOut(refused), true, `${status}: another CLI home may hold a token GitHub accepts`);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(refused, { language }).id, 'copilot-auth', `${status} ${language}`);
  }
  // GitHub sends a rate limit as a 429 or as a 403 that says so; any other
  // body comes as "Failed to fetch Copilot user info: <status line>: <body>".
  for (const [status, rest] of [[429, 'GitHub returned: API rate limit exceeded'],
    [403, 'GitHub returned: API rate limit exceeded for user ID 1. If you reach out to GitHub Support for help, please include the request ID ABCD:1234:5678:9ABC:0000.'],
    [403, 'GitHub returned: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'],
    [429, 'Failed to fetch Copilot user info: 429 Too Many Requests: slow down'],
    [502, 'Failed to fetch Copilot user info: 502 Bad Gateway: <html><body>Bad gateway</body></html>'],
    [502, 'GitHub returned: Bad Gateway'],
    // A 5xx GitHub answered in its own form, and a page with one (CLI 1.0.105, exact text).
    [500, 'GitHub returned: Server Error'],
    [503, 'Failed to fetch Copilot user info: 503 Service Unavailable: <html>busy</html>']]) {
    const passing = tokenCheck(both(status, rest));
    assert.deepEqual([isTransientFailure(passing), isLimitedRetry(passing), isSystemicFailure(passing), isSignedOut(passing)], [true, false, false, false], `${status} ${rest}`);
  }
  // A 4xx page that is not GitHub's error body: a proxy in between (CLI 1.0.105, exact text),
  // also a proxy that asks for its own sign-in inside the tunnel.
  const page = tokenCheck(both(403, 'Failed to fetch Copilot user info: 403 Forbidden: <html><body>Access denied by policy</body></html>'));
  // A page that came with a 200 reads "Invalid Copilot user response" (CLI 1.0.105, exact text): a portal.
  const portal = tokenCheck('Failed to fetch PAT user login: response validation failed: Invalid Copilot user response: expected value at line 1 column 1\n  Failed to fetch GitHub CLI user login: response validation failed: Invalid Copilot user response: expected value at line 1 column 1');
  for (const answer of [page, portal, tokenCheck(both(407, 'Failed to fetch Copilot user info: 407 Proxy Authentication Required: <html>Zscaler</html>'))]) {
    assert.deepEqual([isTransientFailure(answer), isLimitedRetry(answer), isSystemicFailure(answer), isSignedOut(answer), isSignInDoubt(answer)], [true, true, false, false, false], answer.message);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(answer, { language }).id, 'cli-intercepted', `a proxy's page (${language})`);
  }
  // A proxy's page that mentions a rate limit is still a connection taken over, and is recorded as one.
  const ratePage = tokenCheck(both(403, 'Failed to fetch Copilot user info: 403 Forbidden: <html><body>Blocked by the rate limit policy</body></html>'));
  assert.deepEqual([isTransientFailure(ratePage), isLimitedRetry(ratePage), isSystemicFailure(ratePage)], [true, true, false]);
  assert.deepEqual(retryCause(ratePage), { intercepted: true });
  assert.deepEqual(retryCause(tokenCheck(both(429, 'GitHub returned: API rate limit exceeded'))), { rateLimit: true });
  const allowList = tokenCheck('Failed to fetch PAT user login (403): GitHub returned: Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.');
  assert.deepEqual([isTransientFailure(allowList), isLimitedRetry(allowList), isSystemicFailure(allowList), isSignedOut(allowList)], [true, false, false, false]);
  for (const language of ['ja', 'en']) assert.equal(failureGuidance(allowList, { language }).id, 'cli-network', `the CLI's sentence is no credential finding (${language})`);
  // In a run: the first refusal stops it, with no retry and no last pass.
  const f = await continuous(t);
  let count = 0;
  const failure = await translate(f.root, f.config, async () => { count++; throw tokenCheck('Failed to fetch PAT user login (403): GitHub returned: Resource not accessible by integration'); }).then(() => null, e => e);
  assert.ok(failure);
  assert.equal(count, 1);
  assert.equal(failure.report.selfRepairs?.repass, undefined);
  assert.equal(failureGuidance(failure, { language: 'en' }).id, 'copilot-auth');
  // A proxy's page: a few retries, the last pass, then the file is unfinished; the run is not stopped as a sign-in.
  const g = await continuous(t);
  let pages = 0;
  const blocked = await translate(g.root, g.config, async () => { pages++; throw page; }).then(() => null, e => e);
  assert.ok(blocked);
  assert.equal(pages, 2 * (hostStallRetries + 1), 'two passes of the few retries');
  assert.deepEqual(blocked.report.selfRepairs?.repass, { units: 1, done: 0 });
  assert.equal(failureGuidance(blocked, { language: 'en' }).id, 'cli-intercepted');
});

// CLI 1.0.105 as it starts, when it cannot load the list of models (exact
// text, checked through an inspecting proxy with a test CA; the CLI had its
// user info cached, so no token check came first).
const modelsHelp = "\n\nCopilot could not retrieve the list of available models.\n\nTo resolve this, try the following:\n  • If you set COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN, verify it is a user token with Copilot access, or unset it to use your Copilot CLI login\n  • Start 'copilot' and run the '/login' command to re-authenticate\n  • Run 'gh auth status' to check your current authentication status\n  • If the problem persists, retry later or contact support with the Request ID above\n";
const modelsLoad = (error, requestId = true) => {
  const stderr = `Error: Failed to load models${requestId ? ' (Request ID: ABCD:1234:5678:9ABC:0000)' : ''}\n\nError: ${error}${modelsHelp}`;
  return Object.assign(new Error(`Copilot implementer failed (exit 1): ${stderr}`), { result: { stderr, stdout: '' } });
};
const proxyUnreachable = () => modelsLoad('error sending request for url (https://api.githubcopilot.com/models): client error (Connect): tunnel error: failed to create underlying connection: tcp connect error: Connection refused (os error 111) [ECONNREFUSED]', false);
test('a list of models the CLI could not load as it started is retried, never a stop: as long as it lasts with a network error, a rate limit or a 5xx, a few times otherwise; GitHub\'s refusal there keeps its rule', async t => {
  const kind = e => [isTransientFailure(e), isLimitedRetry(e), isSystemicFailure(e), isSignedOut(e), isSignInDoubt(e)];
  // A passing error on GitHub's side, a rate limit, and a company proxy the computer no longer reaches (the VPN dropped).
  for (const passing of [modelsLoad('503 "upstream unavailable"'), modelsLoad('500 "oops"'), modelsLoad('502 " [HTML error page omitted]'), modelsLoad('429 Too Many Requests'), proxyUnreachable()]) {
    assert.deepEqual(kind(passing), [true, false, false, false, false], passing.message);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(passing, { language }).id, 'cli-network', `${passing.message} (${language})`);
  }
  // A tunnel the proxy refused or closed, a proxy's own sign-in, a page or an answer not in the form the CLI reads, a 404: a few times only.
  for (const limited of [modelsLoad('error sending request for url (https://api.githubcopilot.com/models): client error (Connect): tunnel error: unsuccessful', false),
    modelsLoad('error sending request for url (https://api.githubcopilot.com/models): client error (Connect): tunnel error: unexpected end of file', false),
    modelsLoad('missing field `data` at line 1 column 2', false), modelsLoad('404 Not Found')]) {
    assert.deepEqual(kind(limited), [true, true, false, false, false], limited.message);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(limited, { language }).id, 'cli-network', `${limited.message} (${language})`);
  }
  // A proxy's own sign-in, a page that came with a 200 (a portal), and a proxy's 403 page: it has no GitHub request ID (exact text, any body). A connection taken over.
  const proxyPage = new Error('Copilot implementer failed (exit 1): Error: Access denied by policy settings\n\nYour Copilot CLI policy setting may be preventing access. This can happen when:\n  • Your organization has restricted Copilot access\n  • Your Copilot subscription does not include this feature\n  • Required policies have not been enabled by your administrator\n\nTo resolve this, visit your Copilot settings: https://github.com/settings/copilot\n');
  for (const taken of [modelsLoad('407 " [HTML error page omitted]'), modelsLoad('407 " [HTML error page omitted]', false), modelsLoad('expected value at line 1 column 1', false), proxyPage]) {
    assert.deepEqual(kind(taken), [true, true, false, false, false], taken.message);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(taken, { language }).id, 'cli-intercepted', `${taken.message} (${language})`);
  }
  // GitHub's refusals there come in other words (exact text): a 401 stops the run as a sign-in, as before.
  const refused = new Error("Copilot implementer failed (exit 1): Error: Authentication failed (Request ID: ABCD:1234:5678:9ABC:0000)\n\nYour GitHub token may be invalid, expired, or lacking the required permissions.\n\nTo resolve this, try the following:\n  • Start 'copilot' and run the '/login' command to re-authenticate\n  • If using a Fine-Grained PAT, ensure it has the 'Copilot Requests' permission enabled\n  • If using COPILOT_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN environment variable, verify the token is valid and not expired\n  • Run 'gh auth status' to check your current authentication status\n");
  assert.deepEqual(kind(refused).slice(0, 4), [false, false, true, true]);
  for (const language of ['ja', 'en']) assert.equal(failureGuidance(refused, { language }).id, 'copilot-auth');
  // GitHub's 403 there (an organization's policy) reads "Access denied by policy settings (Request ID: ...)" and blocks the file, as up to 0.43.1.
  const policy = new Error('Copilot implementer failed (exit 1): Error: Access denied by policy settings (Request ID: ABCD:1234:5678:9ABC:0000)\n\nYour Copilot CLI policy setting may be preventing access. This can happen when:\n  • Your organization has restricted Copilot access\n  • Your Copilot subscription does not include this feature\n  • Required policies have not been enabled by your administrator\n\nTo resolve this, visit your Copilot settings: https://github.com/settings/copilot\n');
  assert.deepEqual(kind(policy).slice(0, 3), [false, false, false]);
  // Only the CLI's own line is a proxy's page: the same words elsewhere, without
  // "Error: " before them or in a worker's answer, keep the rule they had up to 0.43.1.
  for (const elsewhere of [new Error('Copilot implementer failed (exit 1): session.error query 403: Access denied by policy settings'),
    new Error('Invalid review result: the original prints "Access denied by policy settings" when the role is missing')]) {
    assert.deepEqual(kind(elsewhere).slice(0, 3), [false, false, false], elsewhere.message);
    assert.notEqual(failureGuidance(elsewhere, { language: 'en' }).id, 'cli-intercepted', elsewhere.message);
  }
  // GitHub's 402 there (exact text, with and without the request ID): no model can be
  // used until the credits, the budget or the plan allow it. The run stops, as up to
  // 0.43.1, with the guidance on credits, not on signing in (the CLI adds its sign-in help).
  for (const payment of [modelsLoad('402 Payment Required'), modelsLoad('402 Payment Required', false)]) {
    assert.deepEqual(kind(payment), [true, true, true, false, false], payment.message);
    for (const language of ['ja', 'en']) {
      const guidance = failureGuidance(payment, { language });
      assert.equal(guidance.id, 'credits', `${payment.message} (${language})`);
      assert.deepEqual(guidance.options.map(o => o.id), ['check-billing', 'pause'], 'no cheaper model: none can be used');
    }
  }
  assert.deepEqual(failureGuidance(new Error('Copilot implementer failed (exit 1): Your AI Credits budget has been exhausted'), { language: 'en' }).options.map(o => o.id), ['check-billing', 'cheaper-model', 'pause']);
  // A 402 later in the text than the CLI's start, or in a worker's answer, is not this.
  assert.equal(isSystemicFailure(new Error('Invalid review result: the handler returns "402 Payment Required" when the card is declined')), false);
  // The same words from a worker's own answer are not the CLI's start: a 500 needs the CLI's "Failed to load models" before it.
  const bare = 'Error: 500 "oops"\n\nTo resolve this, try the following:';
  assert.equal(isTransientFailure(Object.assign(new Error(`Copilot implementer failed (exit 1): ${bare}`), { result: { stderr: bare, stdout: '' } })), false);
  // Nor are the words in a worker's answer about the code under review.
  assert.equal(isTransientFailure(new Error('Invalid review result: the original logs "Could not retrieve the list of available models" and "failed to load models"')), false);
  // In a run: the VPN came back after more failed starts than a limited failure gets; the file completes, no stop.
  const f = await continuous(t);
  let implementer = 0, seen;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer <= hostStallRetries + 2) throw proxyUnreachable();
    if (args.role === 'implementer') seen = migrationStatus(f.root);
    return fake(args);
  });
  assert.equal(report.done, 1);
  assert.equal(implementer, hostStallRetries + 3);
  assert.equal(report.selfRepairs?.repass, undefined, 'no last pass was needed');
  assert.match(seen.nextActions.find(a => /being retried after a transient failure/.test(a)) ?? '', /\(network error\); the runner waits[\s\S]*never stop it for this/);
  // status names a list of models that did not load as such, with the same advice.
  const g = await continuous(t);
  let second = 0, during;
  await translate(g.root, g.config, async args => {
    if (args.role === 'implementer' && ++second === 1) throw modelsLoad('503 "upstream unavailable"');
    if (args.role === 'implementer') during = migrationStatus(g.root);
    return fake(args);
  });
  const action = during.nextActions.find(a => /being retried after a transient failure/.test(a)) ?? '';
  assert.match(action, /\(the Copilot CLI could not load the list of models as it started: /);
  assert.match(action, /never stop it for this/);
  assert.doesNotMatch(action, /lowering concurrency/);
  assert.equal(during.retrying[0].modelsLoad, true);
  // GitHub's 402 there stops the run at the first call: no retry, no last pass.
  const p = await continuous(t);
  let paid = 0;
  const stopped = await translate(p.root, p.config, async () => { paid++; throw modelsLoad('402 Payment Required'); }).then(() => null, e => e);
  assert.ok(stopped);
  assert.equal(paid, 1);
  assert.equal(stopped.report.selfRepairs?.repass, undefined);
  for (const language of ['ja', 'en']) assert.equal(failureGuidance(stopped, { language }).id, 'credits');
});

// CLI 1.0.105 when a proxy asks for its own sign-in and the CLI cannot give
// it (exact text, checked through an inspecting proxy that answered the
// tunnel with a 407): with Negotiate offered, the CLI tries Kerberos and
// reports that; with only Basic or NTLM offered, it reports the tunnel's
// refusal. A captive portal's 511 reads the same way.
const negotiateFailed = 'proxy Negotiate authentication failed: failed to acquire proxy credentials: gss_init_sec_context failed: No credentials were supplied, or the credentials were unavailable or inaccessible; SPNEGO cannot find mechanisms to negotiate ';
test('a proxy or a network that asks for its own sign-in (Negotiate, Basic, a captive portal) is a connection taken over: a few retries, never a stop or a move to the person\'s home', async t => {
  const kind = e => [isTransientFailure(e), isLimitedRetry(e), isSystemicFailure(e), isSignedOut(e), isSignInDoubt(e)];
  const both = rest => `Failed to fetch PAT user login${rest}\n  Failed to fetch GitHub CLI user login${rest}`;
  const portalPage = '<html><a href="https://portal.example/">Sign in to the network</a></html>';
  for (const taken of [
    modelsLoad(negotiateFailed, false),
    // Where the CLI checks its token, the cause shows after "network fetch failed".
    tokenCheck(both(`: network fetch failed: ${negotiateFailed}`)),
    modelsLoad('error sending request for url (https://api.githubcopilot.com/models): client error (Connect): tunnel error: proxy authorization required', false),
    modelsLoad('511 " [HTML error page omitted]', false),
    tokenCheck(both(` (511): Failed to fetch Copilot user info: 511 Network Authentication Required: ${portalPage}`)),
    // On a model call, after the CLI's own retries (the stream's error, as the adapter writes it).
    new Error(`Copilot implementer failed (exit 1): session.error query: Failed to get response from the AI model; retried 5 times (total retry wait time: 5.00 seconds) Last error: Failed native model HTTP request: ${negotiateFailed.trimEnd()}\u0000`),
    new Error('Copilot implementer failed (exit 1): session.error query: Failed to get response from the AI model; retried 5 times (total retry wait time: 23.00 seconds) Last error: Failed native model HTTP request: error sending request for url (https://api.githubcopilot.com/v1/chat/completions): client error (Connect): tunnel error: proxy authorization required')]) {
    assert.deepEqual(kind(taken), [true, true, false, false, false], taken.message);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(taken, { language }).id, 'cli-intercepted', `${taken.message} (${language})`);
  }
  // The CLI's other phrases for it (from its own code; the text around them was not seen), where it loads the models and on a model call.
  for (const phrase of ['proxy authentication failed with status 407', 'failed to advance proxy authentication: no more legs', 'proxy Negotiate tunnel timed out', 'proxy required authentication that this request cannot provide'])
    for (const taken of [modelsLoad(phrase, false), new Error(gaveUp(phrase))]) {
      assert.deepEqual(kind(taken), [true, true, false, false, false], taken.message);
      assert.equal(failureGuidance(taken, { language: 'en' }).id, 'cli-intercepted', taken.message);
    }
  // A captive portal's 511 on a model call, as the 407 there reads: no reason to move workers to the person's home.
  const portalCall = new Error('Copilot implementer failed (exit 1): session.error query 511: 511 Network Authentication Required');
  assert.deepEqual(kind(portalCall), [true, true, false, false, false]);
  assert.equal(failureGuidance(portalCall, { language: 'en' }).id, 'cli-intercepted');
  // The advice: unlock the computer and check the VPN, then the proxy settings; not copilot login.
  const advice = failureGuidance(modelsLoad(negotiateFailed, false), { language: 'en' });
  assert.match(advice.cause, /asked for its own sign-in/);
  assert.match(advice.cause, /copilot login does not fix it/);
  assert.match(advice.options.find(o => o.id === 'rerun').reason, /unlock the computer and check that the VPN is connected/);
  assert.ok(advice.options.some(o => o.id === 'proxy-sign-in'));
  assert.match(failureGuidance(modelsLoad(negotiateFailed, false), { language: 'ja' }).cause, /copilot login でも直りません/);
  // GitHub's and the CLI's own words for a sign-in still stop the run.
  for (const message of ['Copilot implementer failed (exit 1): Error: Authentication failed (Request ID: ABCD:1234:5678:9ABC:0000)', 'Copilot implementer failed (exit 1): Error: authentication required', 'Copilot implementer failed (exit 1): session.error authentication 401: Authentication failed'])
    assert.deepEqual([isSystemicFailure(new Error(message)), failureGuidance(message, { language: 'en' }).id], [true, 'copilot-auth'], message);
  assert.equal(isSignedOut(new Error('Copilot implementer failed (exit 1): Error: authentication required')), true);
  // In a run: a proxy whose sign-in lapsed while the screen was locked; once it is back, the file completes.
  const f = await continuous(t);
  let implementer = 0;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer <= 2) throw modelsLoad(negotiateFailed, false);
    return fake(args);
  });
  assert.equal(report.done, 1);
  assert.equal(implementer, 3);
});

const continuous = async t => {
  const f = await ready(t, { executionMode: 'continuous' });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  return f;
};
const attempts = (f, report) => {
  const dir = safePath(f.root, `migration/runs/${report.runId}`);
  return fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'summary.json').map(n => readJSON(path.join(dir, n)));
};

test('a silent call is retried with a longer wait each time, the file completes, and status says why', async t => {
  const f = await continuous(t);
  const seen = [];
  let status;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer') {
      seen.push(args.silentAttempts);
      if (seen.length <= 2) throw silentError();
      status = migrationStatus(f.root);
    } else assert.equal(args.silentAttempts, 0, 'every other call starts with the first wait');
    return fake(args);
  });
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(seen, [0, 1, 2], 'the adapter is told how many earlier attempts were silent');
  const implementer = attempts(f, report).find(a => a.role === 'implementer');
  assert.equal(implementer.retries.length, 2);
  assert.ok(implementer.retries.every(r => r.silent === true && !r.hostStall && !r.cliLock), JSON.stringify(implementer.retries));
  assert.equal(status.retrying?.[0]?.silent, true);
  assert.ok(status.nextActions.some(a => /retried after a transient failure \(a call that showed no sign of progress, most likely a connection lost without an error\).*stays connected.*never stop the runner/.test(a)), status.nextActions.join('\n'));
});

for (const [mode, calls] of [['continuous', hostStallRetries + 1], ['bounded', 3]]) test(`a call that stays silent blocks its file after ${calls} calls in ${mode} mode, and the run tries it once more at its end`, async t => {
  const f = mode === 'continuous' ? await continuous(t) : await ready(t);
  if (mode === 'bounded') { f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config); }
  let count = 0;
  const stages = [];
  const failure = await translate(f.root, f.config, async () => { count++; throw silentError(); }, { onProgress: e => stages.push(e.stage) }).then(() => null, e => e);
  assert.ok(failure, 'the run reports the blocked file');
  assert.match(failure.message, /Process showed no sign of progress/);
  assert.equal(count, calls * 2, 'its retries, then the same again in the last pass');
  assert.ok(stages.includes('one more pass for 1 unit(s) blocked by a call that showed no sign of progress'), stages.join('\n'));
  assert.ok(stages.some(s => /^implementer retry 1 after a call that showed no sign of progress$/.test(s)), stages.join('\n'));
  assert.equal(failureGuidance(failure, { language: 'ja' }).id, 'cli-silent');
});

test('status names a network error being retried, a company certificate among the checks, and after half an hour how long it has lasted', async t => {
  const f = await continuous(t);
  let implementer = 0, fresh, late;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer === 1) throw new Error('Copilot implementer failed (exit 1): connect ETIMEDOUT 140.82.112.21:443');
    if (args.role === 'implementer') {
      fresh = migrationStatus(f.root);
      // As if the first retry came 45 minutes ago.
      const dir = safePath(f.root, `migration/runs/${args.runId}`);
      for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'summary.json')) {
        const file = path.join(dir, name), attempt = readJSON(file);
        if (attempt.role === 'implementer' && attempt.retries?.length) { attempt.retries[0].at = new Date(Date.now() - 45 * 60000).toISOString(); writeJSON(file, attempt); }
      }
      late = migrationStatus(f.root);
    }
    return fake(args);
  });
  assert.equal(report.done, 1);
  const action = s => s.nextActions.find(a => /being retried after a transient failure/.test(a)) ?? '';
  assert.match(action(fresh), /\(network error\); the runner waits/);
  assert.match(action(fresh), /NODE_EXTRA_CA_CERTS/);
  assert.match(action(fresh), /never stop it for this/);
  assert.match(action(late), /\(network error\), the longest for about 4[45] minutes; /);
});

test('status names a connection taken over as such, also when its cause comes after a long give-up wrapper', async t => {
  const f = await continuous(t);
  let implementer = 0, seen;
  const intercepted = gaveUp('Failed native model HTTP request: error sending request for url (https://api.githubcopilot.com/chat/completions): client error (Connect): invalid peer certificate: UnknownIssuer');
  assert.ok(intercepted.indexOf('UnknownIssuer') > 300, 'the cause is past what status keeps of the message');
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer === 1) throw new Error(intercepted);
    if (args.role === 'implementer') seen = migrationStatus(f.root);
    return fake(args);
  });
  assert.equal(report.done, 1);
  const action = seen.nextActions.find(a => /being retried after a transient failure/.test(a)) ?? '';
  assert.match(action, /\(a connection taken over on the way: a certificate this computer does not trust/);
  assert.match(action, /NODE_EXTRA_CA_CERTS/);
  assert.match(action, /one more pass at the end of the run, so never stop the runner/);
  assert.doesNotMatch(action, /lowering concurrency/);
  assert.equal(seen.retrying[0].intercepted, true);
});

test('status names a rate limit being retried, also when it comes after a long give-up wrapper', async t => {
  const f = await continuous(t);
  let implementer = 0, seen;
  const limited = gaveUp(`Failed native model HTTP request: the answer for https://api.githubcopilot.com/chat/completions?${'a'.repeat(200)} was 429 Too Many Requests`);
  assert.ok(limited.indexOf('429') > 300, 'the cause is past what status keeps of the message');
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer === 1) throw new Error(limited);
    if (args.role === 'implementer') seen = migrationStatus(f.root);
    return fake(args);
  });
  assert.equal(report.done, 1);
  assert.match(seen.nextActions.find(a => /being retried after a transient failure/.test(a)) ?? '', /\(rate limit\); the runner waits/);
  assert.equal(seen.retrying[0].rateLimit, true);
});

test('status names the kind of failure recorded with the retry, also past the 500 characters the record keeps; a record without it is read from its text', async t => {
  const records = root => { const dir = safePath(root, 'migration/runs'); return fs.readdirSync(dir).flatMap(run => fs.statSync(path.join(dir, run)).isDirectory() ? fs.readdirSync(path.join(dir, run)).filter(n => n.endsWith('.json') && n !== 'summary.json').map(n => path.join(dir, run, n)) : []).filter(file => readJSON(file).retries?.length); };
  const strip = root => { for (const file of records(root)) { const attempt = readJSON(file); for (const r of attempt.retries) for (const k of ['rateLimit', 'intercepted', 'networkError', 'modelsLoad']) delete r[k]; writeJSON(file, attempt); } };
  const action = s => s.nextActions.find(a => /being retried after a transient failure/.test(a)) ?? '';
  // The CLI's cause past the 500 characters: only the recorded kind names it.
  const f = await continuous(t);
  let implementer = 0, recorded, stripped, record;
  const signIn = gaveUp(`Failed native model HTTP request: error sending request for url (https://api.githubcopilot.com/chat/completions?${'a'.repeat(450)}): client error (Connect): tunnel error: proxy authorization required`);
  assert.ok(signIn.indexOf('proxy authorization') > 500, 'the cause is past what the record keeps of the message');
  await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer === 1) throw new Error(signIn);
    if (args.role === 'implementer') { record = readJSON(records(f.root)[0]); recorded = migrationStatus(f.root); strip(f.root); stripped = migrationStatus(f.root); }
    return fake(args);
  });
  assert.equal(record.retries[0].intercepted, true);
  assert.equal(record.retries[0].error.length, 500);
  assert.match(action(recorded), /\(a connection taken over on the way: [^)]*a proxy or network asking for its own sign-in/);
  assert.match(action(recorded), /that the computer is unlocked \(copilot login cannot fix that\)/);
  assert.equal(recorded.retrying[0].intercepted, true);
  assert.match(action(stripped), /\(service or network error\)/, 'without the recorded kind, the text kept does not say');
  // A record without the kind, with the cause in its text: read from the text, as before.
  const g = await continuous(t);
  let second = 0, earlier;
  await translate(g.root, g.config, async args => {
    if (args.role === 'implementer' && ++second === 1) throw new Error('Copilot implementer failed (exit 1): connect ETIMEDOUT 140.82.112.21:443');
    if (args.role === 'implementer') { strip(g.root); earlier = migrationStatus(g.root); }
    return fake(args);
  });
  assert.match(action(earlier), /\(network error\); the runner waits/);
  assert.equal(earlier.retrying[0].networkError, true);
});

test('a network that came back late: the last pass finishes the file that stayed silent', async t => {
  const f = await continuous(t);
  let implementer = 0;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && ++implementer <= hostStallRetries + 1) throw silentError();
    return fake(args);
  });
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(report.selfRepairs?.repass, { units: 1, done: 1 });
});

const lockError = 'Copilot implementer failed (exit 1): Error: Request session.send failed with message: The shared writer lock timed out.';
test('silences share the few retries of the CLI\'s event stall and lock wait; a file either of them blocked gets the last pass', async t => {
  const f = await continuous(t);
  let count = 0, passAt;
  const stages = [];
  const failure = await translate(f.root, f.config, async () => { throw count++ % 2 ? silentError() : new Error(lockError); },
    { onProgress: e => { stages.push(e.stage); if (/^one more pass/.test(e.stage)) passAt = count; } }).then(() => null, e => e);
  assert.ok(failure);
  assert.equal(passAt, hostStallRetries + 1, 'one cap for both, whichever failure it was');
  assert.equal(count, 2 * (hostStallRetries + 1), 'the last silence left the file for the last pass');
  // Blocked by the lock wait (since 0.44.0 it gets the last pass too).
  const g = await continuous(t);
  let other = 0;
  const gStages = [];
  await translate(g.root, g.config, async () => { throw other++ % 2 ? new Error(lockError) : silentError(); }, { onProgress: e => gStages.push(e.stage) }).then(() => null, e => e);
  assert.equal(other, 2 * (hostStallRetries + 1));
  assert.ok(gStages.includes('one more pass for 1 unit(s) blocked by a temporary failure'), gStages.join('\n'));
});

for (const [name, error, mode] of [
  ['the CLI\'s lock wait', lockError, 'continuous'],
  ['a model request the CLI gave up on', gaveUp('Failed to finalize chat-completions stream: missing finish_reason for choice 0'), 'continuous'],
  ['a network error next to the sign-in help', `Copilot implementer failed (exit 1): connect ETIMEDOUT 140.82.112.21:443${helpText}`, 'continuous'],
  ['a certificate the computer does not trust', 'Copilot implementer failed (exit 1): error sending request for url (https://api.githubcopilot.com/): invalid peer certificate: UnknownIssuer', 'continuous'],
  ['a network error in bounded mode', 'Copilot implementer failed (exit 1): connect ETIMEDOUT 140.82.112.21:443', 'bounded']])
  test(`a file blocked by ${name} gets the last pass, which finishes it once the failure is gone`, async t => {
    const f = mode === 'continuous' ? await continuous(t) : await ready(t);
    if (mode === 'bounded') { f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config); }
    const calls = mode === 'continuous' ? hostStallRetries + 1 : 3;
    let implementer = 0;
    const stages = [];
    const report = await translate(f.root, f.config, async args => {
      if (args.role === 'implementer' && ++implementer <= calls) throw new Error(error);
      return fake(args);
    }, { onProgress: e => stages.push(e.stage) });
    assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
    assert.deepEqual(report.selfRepairs?.repass, { units: 1, done: 1 });
    assert.equal(implementer, calls + 1);
    assert.ok(stages.includes('one more pass for 1 unit(s) blocked by a temporary failure'), stages.join('\n'));
  });

for (const mode of ['continuous', 'bounded']) test(`a retry with no call left in the budget ends the run there, with no last pass (${mode})`, async t => {
  const f = mode === 'continuous' ? await continuous(t) : await ready(t);
  if (mode === 'bounded') { f.config.transientRetryDelayMs = 1; f.config.maxAgentCalls = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config); }
  let count = 0;
  const stages = [];
  const failure = await translate(f.root, f.config, async () => { count++; throw new Error(lockError); },
    { onProgress: e => stages.push(e.stage), ...(mode === 'continuous' ? { maxCalls: 1 } : {}) }).then(() => null, e => e);
  assert.ok(failure);
  assert.equal(count, 1);
  assert.equal(failure.budgetStop, true);
  assert.equal(failure.report.selfRepairs?.repass, undefined);
  assert.ok(!stages.some(s => /one more pass/.test(s)), stages.join('\n'));
  assert.match(failure.message, /The shared writer lock timed out/, 'the unit keeps its own error');
});

test('a file blocked by a failure that is not temporary gets no last pass', async t => {
  const f = await continuous(t);
  let count = 0;
  const failure = await translate(f.root, f.config, async () => { count++; throw new Error('Copilot implementer failed (exit 1): Error: unexpected argument'); }).then(() => null, e => e);
  assert.ok(failure);
  assert.equal(count, 1);
});

test('a call stopped for silence just as the person stops the run ends as interrupted: no retry, no last pass, no network advice', async t => {
  const f = await continuous(t);
  const controller = new AbortController();
  let count = 0;
  const stages = [];
  const failure = await translate(f.root, f.config, async () => { count++; controller.abort(); throw silentError(); },
    { signal: controller.signal, onProgress: e => stages.push(e.stage) }).then(() => null, e => e);
  assert.ok(failure);
  assert.equal(count, 1);
  assert.ok(!stages.some(s => /retry|one more pass/.test(s)), stages.join('\n'));
  const state = fs.readdirSync(safePath(f.root, 'migration/state/units')).map(n => readJSON(safePath(f.root, `migration/state/units/${n}`)))[0];
  assert.match(state.error, /^Interrupted; Process showed no sign of progress/);
  assert.notEqual(failureGuidance(state.error, { language: 'en' }).id, 'cli-silent');
  assert.equal(failureGuidance(state.error, { language: 'en' }).id, failureGuidance('Interrupted', { language: 'en' }).id, 'the same guidance as any interruption');
  // Only with the run stopped, and only a silent call.
  const e = silentError();
  assert.equal(stoppedWithRun(e, new AbortController().signal).message, silentError().message);
  const other = new Error('connect ETIMEDOUT');
  const stopped = new AbortController(); stopped.abort();
  assert.equal(stoppedWithRun(other, stopped.signal).message, 'connect ETIMEDOUT');
  assert.equal(stoppedWithRun(stoppedWithRun(silentError(), stopped.signal), stopped.signal).message, `Interrupted; ${silentError().message}`);
});

test('a preparation audit retries a silent call with a longer wait, each attempt in a fresh session; other failures stay as they were', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const files = ['migration/RULEBOOK.md', 'migration/inventory.tsv'];
  const answer = args => {
    const request = JSON.parse(args.reviewInput);
    return { result: { schemaVersion: 1, kind: 'preparation-audit', task: request.task, inputHash: request.inputHash, target: args.unit.target, verdict: 'pass', findings: [] },
      observedModel: 'm', cliVersion: '1.0.105', cliSessionId: args.sessionId };
  };
  const seen = [];
  const frozen = freezeAudit(f.root, f.config, { type: 'inventory', files });
  const record = await runAudit(f.root, f.config, async args => {
    seen.push({ silentAttempts: args.silentAttempts, sessionId: args.sessionId });
    if (seen.length === 1) throw silentError();
    if (seen.length === 2) throw new Error('connect ENETUNREACH 140.82.112.21:443');
    if (seen.length === 3) throw silentError();
    return answer(args);
  }, { directory: frozen.directory });
  assert.equal(record.result.verdict, 'pass');
  assert.deepEqual(seen.map(s => s.silentAttempts), [0, 1, 1, 2], 'each silent attempt lengthens the next wait; a network error does not');
  assert.equal(new Set(seen.map(s => s.sessionId)).size, 4, 'a fresh session per attempt');
  assert.equal(record.execution.cliSessionId, seen.at(-1).sessionId);
  assert.ok(sessionsStatus(f.root).recorded >= 4, 'every attempt is in the session journal');
  // A failure that is not transient, or one that stops the run, is not retried.
  for (const error of [new Error('Invalid preparation audit response or task/input binding'), new Error('session.error quota_exceeded: AI Credits budget exceeded')]) {
    const next = freezeAudit(f.root, f.config, { type: 'inventory', files });
    let calls = 0;
    await assert.rejects(runAudit(f.root, f.config, async () => { calls++; throw error; }, { directory: next.directory }), e => e === error);
    assert.equal(calls, 1, error.message);
  }
  // A call that stays silent is retried a few times only (shared with the
  // CLI's event stall and lock wait), also in continuous mode.
  const stuck = freezeAudit(f.root, f.config, { type: 'inventory', files });
  let silentCalls = 0;
  await assert.rejects(runAudit(f.root, f.config, async () => { silentCalls++; throw silentError(); }, { directory: stuck.directory }), isSilentCall);
  assert.equal(silentCalls, hostStallRetries + 1);
  // Bounded mode: transientRetries caps the retries.
  f.config.executionMode = 'bounded'; f.config.transientRetries = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const bounded = freezeAudit(f.root, f.config, { type: 'inventory', files });
  let boundedCalls = 0;
  await assert.rejects(runAudit(f.root, f.config, async () => { boundedCalls++; throw silentError(); }, { directory: bounded.directory }), isSilentCall);
  assert.equal(boundedCalls, 2);
});

test('a preparation audit whose inputs changed while it waited to retry stops instead of auditing the old text', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const frozen = freezeAudit(f.root, f.config, { type: 'inventory', files: ['migration/RULEBOOK.md', 'migration/inventory.tsv'] });
  let calls = 0;
  await assert.rejects(runAudit(f.root, f.config, async () => {
    calls++;
    fs.appendFileSync(safePath(f.root, 'migration/inventory.tsv'), 'src/extra.py\tnew row\tkept\n');
    throw silentError();
  }, { directory: frozen.directory }), /Preparation audit inputs changed/);
  assert.equal(calls, 1);
});

test('a survey retries a silent call with a longer wait and names it in its progress line', async t => {
  const f = prepare(t, { count: 1, executionMode: 'continuous' });
  initSourceSpec(f.root, f.config, { apply: true });
  const config = { ...loadConfig(f.root), transientRetryDelayMs: 1 };
  const seen = [], stages = [];
  await runSurvey(f.root, config, 'contracts', async args => {
    seen.push(args.silentAttempts);
    if (seen.length <= 2) throw silentError();
    return { result: { schemaVersion: 1, kind: 'survey', survey: 'contracts', target: args.unit.target,
      items: JSON.parse(args.reviewInput).files.map(x => ({ file: x.path, publicInterface: 'functions', inputsOutputsErrors: 'ints', edgeCases: 'none', evidence: `${x.path}:1`, unknowns: 'none' })) } };
  }, { onProgress: event => stages.push(event.stage) });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.ok(stages.some(s => /surveyor waiting after a call that showed no sign of progress \(retry 1\)/.test(s)), stages.join('\n'));
});

// A Copilot CLI double launched by path, as the real one: it answers --version
// (or hangs there without a word), reads the prompt, records each call, and
// goes silent on the first calls of one role (after one event, so silence
// counts from the last output) or streams its answer slowly in small pieces.
// Waits in the end-to-end tests are 1.5 s or more: a CLI double on a busy
// machine can take a while just to start.
function cliDouble(f, { hangs = 0, hangRole = 'implementer', stream = false, pieces = 16, every = 60, fail = false, versionHangs = false } = {}) {
  const responses = Object.fromEntries(f.units.flatMap(unit => roles.map(role => [`${role}:${unit.target}`, result(role, unit)])));
  const file = safePath(f.root, 'silent-cli.mjs'), log = safePath(f.root, 'silent-cli.jsonl'), versions = safePath(f.root, 'silent-cli-version.jsonl');
  atomicWrite(file, `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv.includes('--version')) {
  fs.appendFileSync(${JSON.stringify(versions)}, JSON.stringify({ pid: process.pid }) + '\\n');
  if (${versionHangs}) setInterval(() => {}, 1000);
  else { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
} else {
let prompt = ''; for await (const c of process.stdin) prompt += c;
const role = process.env.MIGRATION_KIT_ROLE, target = prompt.match(/Set target to "([^"]+)"/)?.[1];
const log = ${JSON.stringify(log)};
const earlier = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(l => JSON.parse(l)).filter(c => c.role === role).length : 0;
fs.appendFileSync(log, JSON.stringify({ role, target, pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'assistant.turn_start', data: {} });
if (role === ${JSON.stringify(hangRole)} && earlier < ${hangs}) setInterval(() => {}, 1000);
else {
  const content = JSON.stringify(${JSON.stringify(responses)}[role + ':' + target]);
  const finish = () => {
    if (${fail}) { process.stderr.write('boom\\n'); process.exit(1); }
    out({ type: 'assistant.message', data: { content, toolRequests: [] } }); out({ type: 'result', exitCode: 0 });
  };
  if (${stream}) {
    const parts = content.match(/[\\s\\S]{1,40}/g);
    let i = 0;
    const t = setInterval(() => { out({ type: i % 2 ? 'assistant.message_delta' : 'assistant.reasoning_delta', data: { deltaContent: parts[i % parts.length] }, ephemeral: true }); if (++i === ${pieces}) { clearInterval(t); finish(); } }, ${every});
  } else finish();
}
}
`);
  fs.chmodSync(file, 0o755);
  const lines = name => fs.existsSync(name) ? fs.readFileSync(name, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { command: process.execPath, prefixArgs: [file], file, calls: () => lines(log), versions: () => lines(versions) };
}

test('end to end: the real adapter stops a CLI that went silent, the retry gets a longer wait, and the file completes', async t => {
  const f = await continuous(t);
  const cli = cliDouble(f, { hangs: 1 });
  const report = await translate(f.root, f.config, createCopilotAdapter({ ...cli, silenceMs: 1500 }));
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  const calls = cli.calls(), implementers = calls.filter(c => c.role === 'implementer');
  assert.equal(implementers.length, 2, 'the silent call, then its retry');
  assert.ok(calls.every(c => c.argv[c.argv.indexOf('--stream') + 1] === 'on'), 'workers stream');
  for (let i = 0; i < 50 && !gone(implementers[0].pid); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(gone(implementers[0].pid), true, 'the silent CLI was stopped');
  const attempt = attempts(f, report).find(a => a.role === 'implementer');
  assert.equal(attempt.retries.length, 1); assert.equal(attempt.retries[0].silent, true);
  assert.match(attempt.retries[0].error, /^Process showed no sign of progress for 2s/);
});

test('a version check that hangs without a word is stopped too: the call goes on with a warning', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const cli = cliDouble(f, { versionHangs: true });
  const response = await createCopilotAdapter({ ...cli, silenceMs: 1500 })({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} });
  assert.equal(response.result.kind, 'implementation');
  assert.equal(response.cliVersion, null);
  assert.match(response.cliVersionWarning, /^Copilot CLI version unknown before this call: Process showed no sign of progress/);
  const [check] = cli.versions();
  for (let i = 0; i < 50 && !gone(check.pid); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(gone(check.pid), true, 'the hanging version check was stopped');
  // With the check off, the version check is waited on as before (here: it answers).
  const off = cliDouble(f);
  const quiet = await createCopilotAdapter(off)({ root: f.root, config: { ...f.config, workerSilenceSeconds: 0 }, role: 'implementer', unit: f.units[0], extra: {} });
  assert.equal(quiet.cliVersion, '1.0.105');
});

test('a CLI that streams its answer slowly is never stopped; with the check off, workers do not stream', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const cli = cliDouble(f, { stream: true, pieces: 40, every: 100 });
  // 40 pieces 100 ms apart: about 4 s of streaming, over twice the wait.
  const response = await createCopilotAdapter({ ...cli, silenceMs: 1500 })({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} });
  assert.equal(response.result.kind, 'implementation');
  assert.equal(response.streamedDeltas, 40, 'the pieces are counted, not kept');
  const off = cliDouble(f);
  await createCopilotAdapter(off)({ root: f.root, config: { ...f.config, workerSilenceSeconds: 0 }, role: 'implementer', unit: f.units[0], extra: {} });
  const argv = off.calls().at(-1).argv;
  assert.equal(argv[argv.indexOf('--stream') + 1], 'off');
  assert.deepEqual(copilotArgs('implementer', 'm').slice(copilotArgs('implementer', 'm').indexOf('--stream'), copilotArgs('implementer', 'm').indexOf('--stream') + 2), ['--stream', 'on']);
  const quiet = copilotArgs('implementer', 'm', undefined, undefined, undefined, { stream: false });
  assert.equal(quiet[quiet.indexOf('--stream') + 1], 'off');
});

test('a failed call\'s record keeps its events and how many pieces streamed, not every piece', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const cli = cliDouble(f, { stream: true, fail: true });
  const failure = await createCopilotAdapter({ ...cli, silenceMs: 1500 })({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], extra: {} }).then(() => null, e => e);
  assert.ok(failure);
  assert.match(failure.message, /Copilot implementer failed \(exit 1\)/);
  assert.equal(failure.result.streamedDeltas, 16);
  assert.equal(failure.result.droppedLines, undefined, 'recorded under its own name');
  assert.doesNotMatch(failure.result.stdout, /_delta/);
  assert.match(failure.result.stdout, /assistant\.turn_start/);
  // With the check off nothing is dropped: a stream that comes anyway is kept as it is.
  const off = cliDouble(f, { stream: true, fail: true });
  const kept = await createCopilotAdapter(off)({ root: f.root, config: { ...f.config, workerSilenceSeconds: 0 }, role: 'implementer', unit: f.units[0], extra: {} }).then(() => null, e => e);
  assert.equal(kept.result.streamedDeltas, undefined);
  assert.equal((kept.result.stdout.match(/_delta"/g) ?? []).length, 16);
});

test('Ctrl+C on a preparation audit stops its worker CLI with it', { skip: process.platform === 'win32' && 'a POSIX signal to a child process' }, async t => {
  const f = await ready(t, { executionMode: 'continuous' });
  const frozen = freezeAudit(f.root, f.config, { type: 'inventory', files: ['migration/RULEBOOK.md', 'migration/inventory.tsv'] });
  const cli = cliDouble(f, { hangs: 1, hangRole: 'preparation-auditor' });
  const { spawn } = await import('node:child_process');
  const audit = spawn(process.execPath, [path.resolve('scripts/audit_inputs.mjs'), 'run', '--root', f.root, '--directory', frozen.directory, '--copilot', cli.file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  audit.stderr.on('data', d => { stderr += d; });
  const exit = new Promise(r => audit.once('close', code => r(code)));
  for (let i = 0; i < 200 && !cli.calls().length; i++) await new Promise(r => setTimeout(r, 50));
  const [call] = cli.calls();
  assert.ok(call, 'the audit worker started');
  audit.kill('SIGINT');
  assert.equal(await exit, 1);
  assert.match(stderr, /ERROR: Interrupted/);
  for (let i = 0; i < 50 && !gone(call.pid); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(gone(call.pid), true, 'the worker CLI was stopped with the audit');
});
