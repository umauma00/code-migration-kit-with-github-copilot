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
import { isTransientFailure, isSystemicFailure, isLimitedRetry, isSilentCall, isSignInDoubt, isSignedOut, networkFailurePattern, hostStallRetries, stoppedWithRun } from '../lib/failures.mjs';
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
  // Only the two delta types, and only short lines that are JSON.
  for (const line of ['{"type":"assistant.message","data":{"content":"see assistant.message_delta"}}', 'not json _delta"', `{"type":"assistant.message_delta","pad":"${'z'.repeat(70000)}"}`])
    assert.equal(isStreamedDelta(Buffer.from(line)), false, line.slice(0, 60));
  // Pieces keep a silent watch at bay, though none is kept.
  const busy = await node(`let n = 0; const t = setInterval(() => { process.stdout.write('{"type":"assistant.reasoning_delta","data":{}}\\n'); if (++n === 25) clearInterval(t); }, 100);`, { silenceMs: 1000, dropLine: isStreamedDelta });
  assert.deepEqual([busy.code, busy.stdout, busy.droppedLines], [0, '', 25]);
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
    'Copilot implementer failed (exit 1): Headers Timeout Error'];
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
  for (const message of ['Copilot implementer failed (exit 1): Too many levels of symbolic links (os error 10062)', 'Copilot implementer failed (exit 1): os error 100543', 'File name too long (os error 10063)',
    'Copilot implementer failed (exit 1): error sending request for url (https://api.githubcopilot.com/chat/completions): client error (Connect): unsuccessful tunnel'])
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
    'Copilot implementer failed (exit 1): The response does not appear to originate from GitHub. Is a proxy or firewall intercepting this request?']) {
    const e = new Error(message);
    assert.equal(isTransientFailure(e), true, message);
    assert.equal(isLimitedRetry(e), true, `${message}: a few times only`);
    assert.equal(isSystemicFailure(e), false, message);
    for (const language of ['ja', 'en']) assert.equal(failureGuidance(message, { language }).id, 'cli-intercepted', `${message} (${language})`);
  }
  assert.match(failureGuidance('invalid peer certificate: UnknownIssuer', { language: 'en' }).options.find(o => o.id === 'company-certificate').reason, /NODE_EXTRA_CA_CERTS/);
});

test('a token check the CLI could not make for the network is the network: retried as long as it lasts, never a stop, never a move to the person\'s home', () => {
  const check = errors => new Error(`Copilot implementer failed (exit 1): Error: Authentication token found but could not be validated.\n\n  ${errors}\n\nYour token may still be valid. Check your network connection and try again.${helpText}`);
  const lost = check('network fetch failed: error sending request for url (https://api.github.com/copilot_internal/user): client error (Connect): dns error: failed to lookup address information: No such host is known. (os error 11001)');
  assert.equal(isTransientFailure(lost), true);
  assert.equal(isLimitedRetry(lost), false, 'not a sign-in in doubt: no retry limit in continuous mode');
  assert.equal(isSignInDoubt(lost), false);
  assert.equal(isSystemicFailure(lost), false);
  assert.equal(isSignedOut(lost), false);
  assert.equal(failureGuidance(lost, { language: 'en' }).id, 'cli-network');
  // With an error it does not know as a network error: a few times only, still no stop.
  const refused = check('error sending request for url (https://api.github.com/copilot_internal/user): client error (Connect): unsuccessful tunnel');
  assert.deepEqual([isTransientFailure(refused), isLimitedRetry(refused), isSystemicFailure(refused), isSignedOut(refused)], [true, true, false, false]);
  assert.equal(failureGuidance(refused, { language: 'en' }).id, 'cli-network');
  // The generic sign-in help next to a network error stays a doubt, a few times only.
  const doubt = new Error(`Copilot implementer failed (exit 1): connect ETIMEDOUT 140.82.112.21:443${helpText}`);
  assert.deepEqual([isTransientFailure(doubt), isLimitedRetry(doubt), isSignInDoubt(doubt), isSystemicFailure(doubt)], [true, true, true, false]);
  // A token GitHub refused stops the run, as before.
  assert.equal(isSystemicFailure(new Error(`${lost.message}\n401 Unauthorized`)), true);
  assert.equal(isSystemicFailure(new Error(`Copilot implementer failed (exit 1): Error: No authentication information found.${helpText}`)), true);
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
