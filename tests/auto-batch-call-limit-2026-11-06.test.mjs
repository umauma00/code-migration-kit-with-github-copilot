// SPDX-License-Identifier: Apache-2.0
// 2026-11-05 and 2026-11-06 (Windows, kit 0.47.0, four workers, phase 04 at
// 117 and then 375 of 554 files):
// - four calls at work looked like one file at a time, since status showed
//   only finished files;
// - auto mode under Copilot CLI autopilot stopped at the end of each approved
//   batch (about 4 of 18 hours lost) and when translate found no approval:
//   the batch end and the approval guidance waited for the person, and
//   autopilot refuses that question by itself;
// - a call stopped at its call limit was tried again with the same limit, so
//   a call that only needed more time was stopped again, also while it was
//   writing its answer.
// 0.48.0: status shows the calls at work (of concurrency) and the files
// waiting on a dependency; in auto mode translate records the translation
// approval itself, with the checks of approve translation, and never stops at
// the end of a batch auto mode approved; the approval guidance asks nothing
// in auto mode and says outside it that autopilot refuses the question; a
// retry gets twice the limit, and a call writing its answer at its limit may
// finish, up to twice the limit. workerCallMinutes is now
// workerCallBaseMinutes (tests/settings.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepare, fake, result } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, statePath, loadConfig } from '../lib/core.mjs';
import { translate, approve, runStage, translationApprovalOnly, autoBatchNotice, stopAtEndRefusal } from '../lib/pipeline.mjs';
import { runProcess, callLimitMessage, callLimiter, finishWaitMs } from '../lib/process.mjs';
import { currentPhase } from '../lib/phases.mjs';
import { createCopilotAdapter, answerWatch, isStreamedDelta } from '../scripts/copilot_adapter.mjs';
import { failureGuidance, failureGuidanceList, guidanceMarkdown } from '../lib/guidance.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot, runProgress } from '../lib/status-snapshot.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { preparePilot } from '../lib/pilot.mjs';
import { autoPhases } from '../lib/phases.mjs';
import { interactiveDecision } from '../lib/guardrails.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { progressKey } from '../scripts/run_migration.mjs';
import { parseCommandLine, specs } from '../lib/cli.mjs';

const gateFile = f => safePath(f.root, 'migration/gates/translation.json');
const gate = f => readJSON(gateFile(f));
const allDone = f => f.units.every(u => fs.existsSync(statePath(f.root, u)) && readJSON(statePath(f.root, u)).status === 'done');
// A strict project with phases 00 to 03 recorded by the person, the judge run
// and the guardrails installed: ready for phase 04 except its approval.
async function phase04(t, { count = 2, mode, setup } = {}) {
  const f = prepare(t, { count });
  setup?.(f);
  f.config.phasePolicy = 'strict';
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, name), 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  phaseCommand(f.root, f.config, 'init');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await runStage(f.root, f.config, 'judge');
  phaseCommand(f.root, f.config, 'complete', '03', { note: 'Synthetic stress fixture only' });
  fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(f.root, 'migration/guardrails.json'));
  if (mode) setPreferences(f.root, { phaseMode: mode });
  return f;
}
const kit = 'node migration-kit/scripts/run_migration.mjs';
// What status says at the end of a batch the person chose, in auto mode.
const waitWord = /^The batch of 1 file\(s\) the person chose is done: tell the person and wait for their word \(auto mode stops at a batch only when the person chose it: approved outside auto mode, or with --stop-at-end\); when they say to go on, run translate/;
// An approval that went out of date (here: its content hash).
const staleGate = f => writeJSON(gateFile(f), { ...gate(f), contextHash: 'f'.repeat(64) });

test('a call writing its answer at its limit may finish, up to twice the limit; one that turns to a tool is stopped then (callLimiter)', () => {
  let now = 0, writing = true;
  const clock = () => now;
  const ticks = (limiter, n) => { const out = []; for (let i = 0; i < n; i++) { now += 50; out.push(limiter.tick()); } return out; };
  // limit 1000 ms: a step of 50 ms
  const answering = callLimiter(1000, { writing: () => writing, clock });
  assert.deepEqual(ticks(answering, 20), Array(20).fill(false), 'at its limit while writing: not stopped');
  assert.deepEqual(ticks(answering, 19), Array(19).fill(false));
  assert.deepEqual(ticks(answering, 1), [true], 'stopped at twice the limit');
  assert.equal(answering.writingAtStop, true);
  // Past its limit, a call that turns to a tool is stopped at the next step.
  now = 0; writing = true;
  const turning = callLimiter(1000, { writing: () => writing, clock });
  assert.ok(ticks(turning, 24).every(due => !due));
  writing = false;
  assert.deepEqual(ticks(turning, 1), [true]);
  assert.equal(turning.writingAtStop, false);
  // Not writing (or a check that throws): stopped at the limit, as in 0.47.0.
  for (const check of [() => false, () => { throw new Error('unreadable'); }, () => 'yes', undefined]) {
    now = 0;
    const plain = callLimiter(1000, { ...(check ? { writing: check, finished: check } : {}), clock });
    assert.deepEqual(ticks(plain, 20), [...Array(19).fill(false), true]);
    assert.equal(plain.writingAtStop, false);
  }
});

test('a call that finished its answer has a minute (or its limit, when shorter) to exit before its limit stops it; one that hangs once finished is stopped then (callLimiter)', () => {
  let now = 0, writing = true, finished = false;
  const clock = () => now;
  const ticks = (limiter, n, step = 50) => { const out = []; for (let i = 0; i < n; i++) { now += step; out.push(limiter.tick()); } return out; };
  // Writing past its limit, then finished: it has finishMs (here the limit,
  // 1000 ms, shorter than a minute) from the tick that saw it finished, even
  // past twice the limit.
  const exiting = callLimiter(1000, { writing: () => writing, finished: () => finished, clock });
  assert.ok(ticks(exiting, 30).every(due => !due), 'past its limit while writing');
  writing = false; finished = true;
  assert.deepEqual(ticks(exiting, 21), [...Array(20).fill(false), true], 'stopped 1000 ms after the tick that saw it finished');
  assert.equal(exiting.writingAtStop, false);
  assert.equal(exiting.finishedAtStop, true, 'it had finished, but not exited');
  assert.equal(exiting.finishMs, 1000);
  // Finished long before its limit and still running (a CLI that hangs once
  // its answer is done): stopped at its limit, as before 0.48.0.
  now = 0;
  const hung = callLimiter(1000, { finished: () => true, finishMs: 200, clock });
  assert.deepEqual(ticks(hung, 20), [...Array(19).fill(false), true]);
  assert.equal(hung.finishedAtStop, true);
  // Finished, then at work again (a new turn): the wait counts from the time
  // it finished again.
  now = 0; writing = false; finished = true;
  const again = callLimiter(1000, { writing: () => writing, finished: () => finished, finishMs: 200, clock });
  assert.ok(ticks(again, 5).every(due => !due));
  finished = false; writing = true;
  assert.ok(ticks(again, 20).every(due => !due), 'writing at its limit');
  writing = false; finished = true;
  assert.deepEqual(ticks(again, 5), [false, false, false, false, true]);
  // A limit of ten minutes (a step of 30 s): a minute.
  now = 0; writing = true; finished = false;
  const minute = callLimiter(600000, { writing: () => writing, finished: () => finished, clock });
  assert.ok(ticks(minute, 24, 30000).every(due => !due), 'writing past its limit');
  writing = false; finished = true;
  assert.deepEqual(ticks(minute, 3, 30000), [false, false, true]);
  assert.equal(finishWaitMs, 60000);
  // With the silence check on, a call that finished its answer and then
  // wrote nothing is stopped at its limit all the same: silence after an
  // answer is no lost connection. A silent call at work waits for its next
  // output, as before.
  now = 0;
  const quiet = callLimiter(1000, { silence: true, idleMs: 100, finished: () => true, finishMs: 200, clock });
  assert.deepEqual(ticks(quiet, 20), [...Array(19).fill(false), true], 'silent since its answer: stopped at its limit');
  assert.equal(quiet.finishedAtStop, true);
  now = 0;
  const silentAtWork = callLimiter(1000, { silence: true, idleMs: 100, finished: () => false, clock });
  assert.ok(ticks(silentAtWork, 30).every(due => !due), 'a silent call at work is not stopped at its limit');
  silentAtWork.output();
  assert.deepEqual(ticks(silentAtWork, 1), [true], 'but at its next output');
  assert.equal(silentAtWork.finishedAtStop, false);
  // Not finished when stopped: the plain words of a call at work.
  now = 0;
  const plain = callLimiter(1000, { finished: () => false, clock });
  assert.deepEqual(ticks(plain, 20), [...Array(19).fill(false), true]);
  assert.equal(plain.finishedAtStop, false);
  assert.equal(callLimitMessage(30 * 60000, { finishMs: 60000 }), 'Process ran past its call limit (30 min, from workerCallBaseMinutes and the files the call reads) and had not exited 60s after it finished its answer; stopped');
});

test('with the silence check on, a CLI silent after its answer is stopped at its limit as one that did not exit, not as a silent call (runProcess)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-silent-after-answer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'answer-then-hang.mjs');
  fs.writeFileSync(script, `const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'assistant.turn_start', data: { turnId: '0' } });
out({ type: 'assistant.message', data: { content: 'done', toolRequests: [] } });
out({ type: 'result', exitCode: 0 });
setInterval(() => {}, 1000);
`);
  const watch = answerWatch(), started = performance.now();
  const e = await runProcess(process.execPath, [script], { silenceMs: 20000, limitMs: 1500, idleMs: 200, watchLine: watch.line, writing: watch.writing, finished: watch.finished }).then(() => null, x => x);
  assert.ok(e, 'stopped');
  assert.equal(e.silent, undefined, e.message);
  assert.equal(e.finishedAtLimit, true, e.message);
  assert.equal(e.message, callLimitMessage(1500, { finishMs: 1500 }));
  assert.ok(performance.now() - started < 15000, 'stopped well before the silence check would have');
});

test('answerWatch reads from the CLI\'s events whether the main agent is writing its answer or has finished it', () => {
  const w = answerWatch(), ev = e => w.line(JSON.stringify(e)), state = () => [w.writing(), w.finished()];
  const writing = [true, false], finished = [false, true], neither = [false, false];
  assert.deepEqual(state(), neither);
  ev({ type: 'assistant.turn_start', data: { turnId: '1' } }); assert.deepEqual(state(), neither);
  ev({ type: 'assistant.reasoning_delta', data: { deltaContent: 'thinking' } }); assert.deepEqual(state(), neither, 'reasoning is not its answer');
  ev({ type: 'assistant.message_delta', data: { deltaContent: '' } }); assert.deepEqual(state(), neither, 'an empty piece');
  ev({ type: 'assistant.message_delta', data: { deltaContent: '{"schemaVersion"' } }); assert.deepEqual(state(), writing);
  ev({ type: 'tool.execution_start', data: { toolName: 'view' } }); assert.deepEqual(state(), neither, 'a tool call ends it');
  ev({ type: 'assistant.message_delta', data: { deltaContent: 'x' } }); assert.deepEqual(state(), writing);
  ev({ type: 'assistant.turn_start', data: { turnId: '2' } }); assert.deepEqual(state(), neither, 'a new turn ends it');
  ev({ type: 'assistant.message_delta', agentId: 'sub', data: { deltaContent: 'x' } }); assert.deepEqual(state(), neither, 'a subagent\'s text is not its answer');
  ev({ type: 'assistant.message_delta', data: { deltaContent: 'x', parentToolCallId: 'call_1' } }); assert.deepEqual(state(), neither);
  ev({ type: 'assistant.message', data: { content: 'Let me read it', toolRequests: [{ name: 'view' }] } }); assert.deepEqual(state(), neither, 'a reply that asks for tools');
  ev({ type: 'assistant.message', data: { content: '{"kind":"review"}', toolRequests: [] } }); assert.deepEqual(state(), finished, 'the final reply: the CLI has only to exit');
  for (const line of ['not json', '{"type":"assistant.message_delta"', '"assistant.turn_start"', JSON.stringify({ type: 'session.info', data: {} })]) w.line(line);
  assert.deepEqual(state(), finished, 'a broken or other line changes nothing');
  ev({ type: 'tool.execution_start', agentId: 'sub', data: { toolName: 'grep' } }); assert.deepEqual(state(), neither, 'any agent\'s tool call');
  ev({ type: 'assistant.message_delta', data: { deltaContent: 'Let me read it.' } }); assert.deepEqual(state(), writing);
  ev({ type: 'assistant.tool_call_delta', data: { toolCallId: 'call_2', toolName: 'view', inputDelta: '{"path"' } }); assert.deepEqual(state(), neither, 'the turn streams a tool call');
  ev({ type: 'assistant.message', data: { content: '{}', toolRequests: [] } }); assert.deepEqual(state(), finished);
  ev({ type: 'assistant.idle', data: {} }); assert.deepEqual(state(), finished, 'still finished once idle');
  ev({ type: 'assistant.message_delta', data: { deltaContent: 'more' } }); assert.deepEqual(state(), writing, 'new text: writing again');
  ev({ type: 'assistant.message', data: { content: ' ', toolRequests: [] } }); assert.deepEqual(state(), neither, 'an empty reply is no answer');
  ev({ type: 'result', exitCode: 0, usage: {} }); assert.deepEqual(state(), finished, 'the CLI wrote its result: it has only to exit');
  ev({ type: 'assistant.turn_start', data: { turnId: '3' } }); assert.deepEqual(state(), neither, 'a new turn: it went on');
  ev({ type: 'result', agentId: 'sub', exitCode: 0 }); assert.deepEqual(state(), neither, 'a subagent\'s result is not the CLI\'s');
  ev({ type: 'assistant.message_delta', data: { deltaContent: 'x' } });
  ev({ type: 'result', agentId: 'sub', exitCode: 0 }); assert.deepEqual(state(), writing, 'nor does it end the main agent\'s writing');
  // The pieces the watch reads are the ones the runner drops from its logs.
  assert.equal(isStreamedDelta(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'x' } })), true);
});

// Built from a real Copilot CLI 1.0.105 run (Linux x64, 2026-11-06): -p with
// --output-format json --stream on and the workers' tool flags, against a
// loopback OpenAI-compatible provider (COPILOT_PROVIDER_BASE_URL,
// COPILOT_OFFLINE true) that streamed a turn writing a sentence and calling
// view, then the final answer in three pieces. Its 29 lines, in order, each
// line's data cut to the fields answerWatch reads (the raw output, with its
// ids, times, paths and tool list, is not kept here). With the state of
// writing and finished after each line.
const realStream = [
  ['{"type":"session.skills_loaded","data":{}}', false, false],
  ['{"type":"session.info","data":{}}', false, false],
  ['{"type":"session.mcp_servers_loaded","data":{}}', false, false],
  ['{"type":"session.tools_updated","data":{}}', false, false],
  ['{"type":"user.message","data":{"content":"Read a.txt then answer.","turnId":"0"}}', false, false],
  ['{"type":"assistant.turn_start","data":{"turnId":"0"}}', false, false],
  ['{"type":"model.call_start","data":{"turnId":"0"}}', false, false],
  ['{"type":"assistant.message_start","data":{}}', false, false],
  ['{"type":"assistant.message_delta","data":{"deltaContent":"Let me "}}', true, false],
  ['{"type":"assistant.message_delta","data":{"deltaContent":"read it."}}', true, false],
  ['{"type":"assistant.tool_call_delta","data":{"toolCallId":"call_1","toolName":"view"}}', false, false],
  ['{"type":"model.call_finished","data":{"turnId":"0"}}', false, false],
  ['{"type":"assistant.message","data":{"content":"Let me read it.","toolRequests":[{"toolCallId":"call_1","name":"view"}],"turnId":"0"}}', false, false],
  ['{"type":"tool.execution_start","data":{"toolCallId":"call_1","toolName":"view","turnId":"0"}}', false, false],
  ['{"type":"model.call_final_result","data":{}}', false, false],
  ['{"type":"tool.execution_complete","data":{"toolCallId":"call_1","turnId":"0"}}', false, false],
  ['{"type":"assistant.turn_end","data":{"turnId":"0"}}', false, false],
  ['{"type":"assistant.turn_start","data":{"turnId":"1"}}', false, false],
  ['{"type":"model.call_start","data":{"turnId":"1"}}', false, false],
  ['{"type":"assistant.message_start","data":{}}', false, false],
  ['{"type":"assistant.message_delta","data":{"deltaContent":"{\\"schema"}}', true, false],
  ['{"type":"assistant.message_delta","data":{"deltaContent":"Version\\": 1, "}}', true, false],
  ['{"type":"assistant.message_delta","data":{"deltaContent":"\\"answer\\": \\"done\\"}"}}', true, false],
  ['{"type":"model.call_finished","data":{"turnId":"1"}}', true, false],
  // Its answer is done: from here the CLI has a minute to exit.
  ['{"type":"assistant.message","data":{"content":"{\\"schemaVersion\\": 1, \\"answer\\": \\"done\\"}","toolRequests":[],"turnId":"1"}}', false, true],
  ['{"type":"model.call_final_result","data":{}}', false, true],
  ['{"type":"assistant.turn_end","data":{"turnId":"1"}}', false, true],
  ['{"type":"assistant.idle","data":{}}', false, true],
  ['{"type":"result","exitCode":0}', false, true]];
test('answerWatch follows the lines of a real CLI 1.0.105 run, their data cut down', () => {
  assert.equal(realStream.length, 29, 'the 29 lines of that run');
  const w = answerWatch();
  for (const [line, writing, finished] of realStream) {
    w.line(line);
    assert.deepEqual([w.writing(), w.finished()], [writing, finished], line);
  }
  // A final reply on a line too long to read whole (its head is no JSON):
  // the end of the turn that was writing it finishes the answer.
  const long = answerWatch();
  for (const line of ['{"type":"assistant.message_delta","data":{"deltaContent":"x"}}', `{"type":"assistant.message","data":{"content":"${'x'.repeat(1000)}`]) long.line(line);
  assert.deepEqual([long.writing(), long.finished()], [true, false]);
  long.line('{"type":"assistant.turn_end","data":{"turnId":"2"}}');
  assert.deepEqual([long.writing(), long.finished()], [false, true]);
  // A subagent's turn ending is not the main agent's.
  const sub = answerWatch();
  for (const line of ['{"type":"assistant.message_delta","data":{"deltaContent":"x"}}', '{"type":"assistant.turn_end","agentId":"sub","data":{"turnId":"9"}}']) sub.line(line);
  assert.deepEqual([sub.writing(), sub.finished()], [true, false]);
  // A turn that ends without writing (a tool turn) finishes nothing.
  const tools = answerWatch();
  for (const line of ['{"type":"tool.execution_complete","data":{}}', '{"type":"assistant.turn_end","data":{"turnId":"0"}}', '{"type":"assistant.idle","data":{}}']) tools.line(line);
  assert.deepEqual([tools.writing(), tools.finished()], [false, false]);
});

// A stand-in for the Copilot CLI that streams its answer slowly (--stream on).
// started: when the adapter checked its version, right before the call, so
// a slow start of the call itself (Windows) does not move what it times.
function streamingCli(f, name, body) {
  const file = safePath(f.root, name), stamp = safePath(f.root, `${name}.t0`);
  atomicWrite(file, `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv.includes('--version')) { fs.writeFileSync(${JSON.stringify(stamp)}, String(Date.now())); console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
const started = Number(fs.readFileSync(${JSON.stringify(stamp)}, 'utf8'));
// Never outlives the test, whatever the limit does.
setTimeout(() => process.exit(0), 30000);
${body}
`);
  return createCopilotAdapter({ command: process.execPath, prefixArgs: [file] });
}
const call = (f, adapter, callLimitMs) => adapter({ root: f.root, config: f.config, role: 'reviewer-semantics', unit: f.units[0], reviewInput: '{"mode":"frozen"}', extra: {}, callLimitMs });

test('end to end: the real adapter lets a CLI still writing its answer at its limit finish and exit, stops one writing past twice the limit, one that hangs once its answer is done, and one at work with tools at the limit', { timeout: 90000 }, async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const answer = JSON.stringify(result('reviewer-semantics', f.units[0]));
  // The stand-in counts from its version check, right before the call: it
  // finishes past the limit while the steps between the two take less than
  // 0.4 times the limit, and a slow start of the call has the whole limit.
  const limit = 3000;
  // Still writing at its limit; done at about 1.4 times the limit, then its
  // turn ends, it goes idle, writes its result and exits 300 ms later (two
  // steps of the limit's watch: a CLI saves its session before it exits).
  const finishing = streamingCli(f, 'finishing-cli.mjs', `const answer = ${JSON.stringify(answer)};
out({ type: 'assistant.turn_start', data: { turnId: '1' } });
const timer = setInterval(() => {
  out({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'x' } });
  if (Date.now() - started > ${1.4 * limit}) {
    clearInterval(timer);
    out({ type: 'assistant.message', data: { content: answer, toolRequests: [] } });
    out({ type: 'assistant.turn_end', data: { turnId: '1' } }); out({ type: 'assistant.idle', data: {} }); out({ type: 'result', exitCode: 0 });
    setTimeout(() => process.exit(0), 300);
  }
}, 25);`);
  const done = await call(f, finishing, limit);
  assert.equal(done.result.verdict, 'pass', 'its answer is used');
  // Its answer done and its result written, then it never exits: stopped at
  // its limit as one at work, as before 0.48.0 (its minute to exit is the
  // limit here, shorter), and well before twice the limit.
  const hanging = streamingCli(f, 'hanging-cli.mjs', `out({ type: 'assistant.turn_start', data: { turnId: '1' } });
out({ type: 'assistant.message', data: { content: ${JSON.stringify(answer)}, toolRequests: [] } });
out({ type: 'assistant.turn_end', data: { turnId: '1' } }); out({ type: 'assistant.idle', data: {} }); out({ type: 'result', exitCode: 0 });`);
  const hung = await call(f, hanging, limit).then(() => null, e => e);
  assert.ok(hung, 'stopped');
  assert.equal(hung.callLimit, true); assert.equal(hung.writingAtLimit, undefined); assert.equal(hung.finishedAtLimit, true);
  assert.equal(hung.message, callLimitMessage(limit, { finishMs: limit }));
  assert.match(hung.message, /and had not exited 3s after it finished its answer; stopped$/);
  assert.ok(hung.workedMs >= limit && hung.workedMs < 2 * limit, String(hung.workedMs));
  // Writes forever: stopped at twice its limit, and says so.
  const forever = streamingCli(f, 'forever-cli.mjs', `out({ type: 'assistant.turn_start', data: { turnId: '1' } });
setInterval(() => out({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'x' } }), 25);`);
  const at = Date.now();
  const stopped = await call(f, forever, limit).then(() => null, e => e);
  assert.ok(stopped, 'stopped');
  assert.equal(stopped.callLimit, true); assert.equal(stopped.writingAtLimit, true);
  assert.equal(stopped.message, callLimitMessage(limit, { writing: true }));
  assert.ok(Date.now() - at >= 2 * limit, `not before twice the limit (${Date.now() - at} ms)`);
  assert.ok(stopped.workedMs >= 2 * limit, `the minutes it was at work go with it (${stopped.workedMs} ms)`);
  // At work with tools: stopped at its limit, as in 0.47.0.
  const reading = streamingCli(f, 'reading-cli.mjs', `let n = 0;
setInterval(() => { n++; out({ type: 'assistant.turn_start', data: { turnId: String(n) } }); out({ type: 'tool.execution_start', data: { toolCallId: 'call_' + n, toolName: 'view', arguments: {} } }); }, 25);`);
  const tools = await call(f, reading, limit).then(() => null, e => e);
  assert.ok(tools, 'stopped');
  assert.equal(tools.callLimit, true); assert.equal(tools.writingAtLimit, undefined); assert.equal(tools.finishedAtLimit, undefined);
  assert.equal(tools.message, callLimitMessage(limit));
  assert.ok(tools.workedMs >= limit && tools.workedMs < 2 * limit, String(tools.workedMs));
  // A tool call on a line too long to read whole (70 KB of arguments), after
  // text and with no streamed tool call before it: still stopped at the limit.
  const bigTool = streamingCli(f, 'big-tool-cli.mjs', `out({ type: 'assistant.turn_start', data: { turnId: '1' } });
out({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Let me read it.' } });
out({ type: 'tool.execution_start', data: { toolCallId: 'call_1', toolName: 'view', arguments: { path: 'x'.repeat(70000) } } });
setInterval(() => out({ type: 'session.info', data: { message: 'at work' } }), 25);`);
  const big = await call(f, bigTool, limit).then(() => null, e => e);
  assert.ok(big, 'stopped');
  assert.equal(big.writingAtLimit, undefined, 'the tool call on its long line ended the answer');
  assert.equal(big.message, callLimitMessage(limit));
  // Without the stream (workerSilenceSeconds 0) the kit cannot tell, so the limit stays the limit.
  f.config.workerSilenceSeconds = 0;
  const unseen = await call(f, forever, limit).then(() => null, e => e);
  assert.ok(unseen, 'stopped');
  assert.equal(unseen.writingAtLimit, undefined);
  assert.equal(unseen.message, callLimitMessage(limit));
});

test('a call stopped while still writing at twice its limit is retried with twice the limit and told it was writing; a file set aside so says why', async t => {
  const f = prepare(t, { executionMode: 'continuous', count: 2 });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  const writingStop = minutes => Object.assign(new Error(callLimitMessage(minutes * 60000, { writing: true })), { callLimit: true, writingAtLimit: true, activity: { turns: 2, tools: {}, views: [], contextTokens: null, contextLimit: null, compactions: null } });
  const seen = [];
  const failure = await translate(f.root, f.config, async args => {
    if (args.unit.target === f.units[0].target && args.role === 'implementer') { seen.push({ ms: args.callLimitMs, note: args.extra.previousAttempt }); throw writingStop(args.callLimitMs / 60000); }
    return fake(args);
  }).then(() => null, e => e);
  assert.ok(failure);
  assert.deepEqual(seen.map(s => s.ms), [30 * 60000, 60 * 60000]);
  assert.equal(seen[1].note, 'after 60 minutes, still writing its answer (2 model turns, 0 tool calls). Return your answer as soon as it is complete.');
  const state = readJSON(statePath(f.root, f.units[0]));
  assert.equal(state.status, 'blocked');
  assert.match(state.error, /^Copilot implementer ran past its call limit on 2 attempts \(30 min, then 60 min on the retry; from workerCallBaseMinutes and the files the call reads\), the last time while still writing its answer at twice its limit; this file is set aside for this run/);
  assert.equal(failureGuidance(state.error).id, 'cli-call-limit');
  assert.equal(readJSON(statePath(f.root, f.units[1])).status, 'done', 'the other file went on');
});

test('the retry hears how long the stopped call was at work; a file set aside after its only try says so without "the last time"', async t => {
  // A call writing at its limit that turned to a tool was stopped past its
  // limit: its retry hears those minutes, not the limit's.
  const f = prepare(t, { executionMode: 'continuous', count: 2 });
  f.config.transientRetryDelayMs = 1; writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  const activity = { turns: 3, tools: { view: 2 }, views: [], contextTokens: null, contextLimit: null, compactions: null };
  const notes = [];
  await translate(f.root, f.config, async args => {
    if (args.unit.target === f.units[0].target && args.role === 'implementer') {
      notes.push(args.extra.previousAttempt);
      if (notes.length === 1) throw Object.assign(new Error(callLimitMessage(30 * 60000)), { callLimit: true, workedMs: 45 * 60000, activity });
    }
    return fake(args);
  });
  assert.equal(notes.length, 2);
  assert.match(notes[1], /^after 45 minutes, still at work and without a final answer \(3 model turns, 2 tool calls/);
  assert.ok(allDone(f));
  // Bounded mode without retries: one try, set aside.
  const b = prepare(t, { executionMode: 'bounded', count: 2 });
  b.config.transientRetries = 0; writeJSON(safePath(b.root, 'migration/state/config.json'), b.config);
  await runStage(b.root, b.config, 'judge');
  approve(b.root, b.config, 'translation', 'Automated fixture approval for tests only');
  await translate(b.root, b.config, async args => {
    if (args.unit.target === b.units[0].target && args.role === 'implementer') throw Object.assign(new Error(callLimitMessage(30 * 60000, { writing: true })), { callLimit: true, writingAtLimit: true, workedMs: 60 * 60000 });
    return fake(args);
  }).catch(() => null);
  const state = readJSON(statePath(b.root, b.units[0]));
  assert.match(state.error, /^Copilot implementer ran past its call limit of 30 min \(from workerCallBaseMinutes and the files the call reads\) and was stopped, while still writing its answer at twice its limit; this file is set aside for this run/);
  // A call that finished its answer, but whose CLI did not exit: its retry
  // is told the answer was lost (nothing to do faster), and the reason says so.
  const h = prepare(t, { executionMode: 'continuous', count: 2 });
  h.config.transientRetryDelayMs = 1; writeJSON(safePath(h.root, 'migration/state/config.json'), h.config);
  await runStage(h.root, h.config, 'judge');
  approve(h.root, h.config, 'translation', 'Automated fixture approval for tests only');
  const heard = [];
  let retried;
  await translate(h.root, h.config, async args => {
    if (args.unit.target === h.units[0].target && args.role === 'implementer') {
      heard.push(args.extra.previousAttempt);
      if (heard.length === 2) retried = migrationStatus(h.root);
      throw Object.assign(new Error(callLimitMessage(args.callLimitMs, { finishMs: 60000 })), { callLimit: true, finishedAtLimit: true, workedMs: args.callLimitMs + 60000 });
    }
    return fake(args);
  }).catch(() => null);
  assert.equal(heard[1], 'after 31 minutes: it had finished its answer, but the Copilot CLI did not exit after it, so the answer was lost. Return your answer again.');
  // Status's retry line says the CLI did not exit, not that the call was still at work.
  assert.ok(retried.nextActions.some(a => /retried after a transient failure \(a call stopped at its call limit because its CLI did not exit after it had finished its answer \(its limit grows from workerCallBaseMinutes with the files the call reads\): it is tried once more with twice the limit, told that its answer was lost, and a file whose second try runs past that too is set aside/.test(a)), retried.nextActions.join('\n'));
  assert.equal(retried.retrying[0].finishedAtLimit, true);
  const hstate = readJSON(statePath(h.root, h.units[0]));
  assert.match(hstate.error, /^Copilot implementer ran past its call limit on 2 attempts \(30 min, then 60 min on the retry; from workerCallBaseMinutes and the files the call reads\), the last time with its answer finished but its CLI not exiting; this file is set aside for this run/);
  const runs = safePath(h.root, 'migration/runs');
  const attempts = fs.readdirSync(runs, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => fs.readdirSync(path.join(runs, d.name)).filter(n => /-implementer-.*\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(runs, d.name, n), 'utf8'))));
  assert.ok(attempts.some(a => (a.retries ?? []).some(r => r.finishedAtLimit === true)), 'the attempt record says so');
  // Its guidance names the CLI not exiting and offers to check why, not a
  // longer limit or the dependency chain; so does the runner's own error. A
  // call stopped at work keeps its choices, and a summary with both gives
  // each its own; a stop of the run is not a call limit.
  for (const message of [hstate.error, callLimitMessage(30 * 60000, { finishMs: 60000 })]) {
    const en = failureGuidance(message), ja = failureGuidance(message, { language: 'ja' });
    assert.equal(en.id, 'cli-call-limit', message);
    assert.deepEqual(en.options.map(o => o.id), ['rerun', 'check-cli-exit', 'pause'], message);
    assert.match(en.cause, /finished its answer, but the Copilot CLI did not exit after it/);
    assert.doesNotMatch(en.cause, /kept writing|dependency chain/);
    assert.match(en.impact, /telling it the answer was lost/);
    assert.match(ja.cause, /答えを書き終えたのに、Copilot CLI が終わりませんでした/);
    assert.match(ja.options[1].label, /答えの後に Copilot CLI が終わらない理由/);
  }
  const atWork = 'Copilot implementer ran past its call limit on 2 attempts (30 min, then 60 min on the retry; from workerCallBaseMinutes and the files the call reads); this file is set aside for this run, and the next run tries it after the other files unless one of them waits on it (last attempt: 41 model turns, 40 tool calls)';
  assert.deepEqual(failureGuidance(atWork).options.map(o => o.id), ['rerun', 'longer-limit', 'check-dependencies', 'pause']);
  const groups = failureGuidanceList(`Translation stopped: ported/a.mjs: ${hstate.error}; ported/b.mjs: ${atWork}; ported/c.mjs: ${hstate.error}`);
  assert.deepEqual(groups.map(g => [g.guidance.id, g.targets, g.guidance.options.map(o => o.id)]), [
    ['cli-call-limit', ['ported/a.mjs', 'ported/c.mjs'], ['rerun', 'check-cli-exit', 'pause']],
    ['cli-call-limit', ['ported/b.mjs'], ['rerun', 'longer-limit', 'check-dependencies', 'pause']]]);
  assert.notEqual(failureGuidance(`Interrupted; ${callLimitMessage(30 * 60000, { finishMs: 60000 })}`).id, 'cli-call-limit');
  // guidance --message with such a summary gives each cause its own
  // guidance, as the run does (the JSON keeps its fields and adds groups);
  // a single message is explained as before.
  const script = safePath(h.root, 'migration-kit/scripts/run_migration.mjs');
  const summary = `Translation stopped: ported/a.mjs: ${hstate.error}; ported/b.mjs: ${atWork}`;
  const json = await runProcess(process.execPath, [script, 'guidance', '--message', summary, '--format', 'json'], { cwd: h.root });
  assert.equal(json.code, 0, json.stderr);
  const explained = JSON.parse(json.stdout);
  assert.equal(explained.explained, true);
  assert.deepEqual(explained.groups.map(g => [g.targets, g.guidance.options.map(o => o.id)]), [
    [['ported/a.mjs'], ['rerun', 'check-cli-exit', 'pause']], [['ported/b.mjs'], ['rerun', 'longer-limit', 'check-dependencies', 'pause']]]);
  const markdown = await runProcess(process.execPath, [script, 'guidance', '--message', summary], { cwd: h.root });
  assert.equal(markdown.code, 0, markdown.stderr);
  assert.match(markdown.stdout, /^# What to do, per cause \(2\)\n/);
  assert.match(markdown.stdout, /Affected: ported\/a\.mjs\n## 1\. What to do about this message[\s\S]*did not exit after it[\s\S]*Affected: ported\/b\.mjs\n## 2\. What to do about this message[\s\S]*raise the limit/);
  const single = await runProcess(process.execPath, [script, 'guidance', '--message', hstate.error, '--format', 'json'], { cwd: h.root });
  assert.equal(single.code, 0, single.stderr);
  assert.equal(Object.hasOwn(JSON.parse(single.stdout), 'groups'), false);
  assert.deepEqual(JSON.parse(single.stdout).options.map(o => o.id), ['rerun', 'check-cli-exit', 'pause']);
  // Two calls retried at once, one stopped at work and one whose CLI did not
  // exit: status's retry line names both.
  const m = prepare(t, { executionMode: 'continuous', count: 2 });
  m.config.transientRetryDelayMs = 1; writeJSON(safePath(m.root, 'migration/state/config.json'), m.config);
  await runStage(m.root, m.config, 'judge');
  approve(m.root, m.config, 'translation', 'Automated fixture approval for tests only');
  const tries = new Map();
  let started = 0, both, mixed;
  const ready = new Promise(resolve => { both = resolve; });
  await translate(m.root, m.config, async args => {
    if (args.role !== 'implementer') return fake(args);
    const n = (tries.get(args.unit.target) ?? 0) + 1;
    tries.set(args.unit.target, n);
    if (n === 1) throw args.unit.target === m.units[0].target
      ? Object.assign(new Error(callLimitMessage(args.callLimitMs, { finishMs: 60000 })), { callLimit: true, finishedAtLimit: true })
      : Object.assign(new Error(callLimitMessage(args.callLimitMs)), { callLimit: true });
    if (++started === 2) { mixed = migrationStatus(m.root); both(); }
    await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 10000))]);
    return fake(args);
  });
  assert.ok(mixed, 'both retries ran at once');
  assert.ok(mixed.nextActions.some(a => /\(a call stopped at its call limit while still at work, or because its CLI did not exit after it had finished its answer \(its limit grows from workerCallBaseMinutes with the files the call reads\): it is tried once more with twice the limit, told what the stopped call did, and a file/.test(a)), mixed.nextActions.join('\n'));
  assert.ok(allDone(m));
});

test('status shows the AI calls at work of concurrency and the files waiting on a dependency, from the run\'s progress record', async t => {
  const f = prepare(t, { count: 3 });
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  let full, fast, record, arrived = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  await translate(f.root, f.config, async args => {
    // Both implementers of math_ops and text_ops hold their slot until the
    // second one has read status; main waits on both meanwhile.
    if (args.role === 'implementer' && args.unit.target !== 'ported/main.mjs') {
      if (++arrived === 2) {
        await new Promise(resolve => setTimeout(resolve, 20));
        full = migrationStatus(f.root); fast = statusSnapshot(f.root);
        record = readJSON(safePath(f.root, `migration/runs/${full.lock.runId}/progress.json`));
        release();
      }
      await both;
    }
    return fake(args);
  });
  assert.equal(record.schemaVersion, 1); assert.equal(record.runId, full.lock.runId); assert.ok(record.updatedAt);
  for (const report of [full, fast]) {
    const p = report.runProgress;
    assert.ok(p, 'shown while the run holds its lock');
    assert.equal(p.concurrency, 2);
    assert.equal(p.callsActive, 2, JSON.stringify(p)); assert.equal(p.callsWaiting, 0);
    assert.equal(p.unitsAtWork, 2); assert.equal(p.unitsWaitingOnDependencies, 1); assert.equal(p.unitsReady, 0);
  }
  assert.match(statusMarkdown(full, 'ja'), /AI の呼び出し：2本が実行中（同時2本まで）。ファイル：作業中2件・依存待ち1件・開始待ち0件。/);
  assert.match(statusMarkdown(fast, 'en'), /AI calls: 2 running \(up to 2 at once\)\. Files: 2 at work, 1 waiting on dependencies, 0 ready to start\./);
  assert.match(statusMarkdown({ ...full, runProgress: { ...full.runProgress, callsWaiting: 3 } }, 'ja'), /2本が実行中（同時2本まで）・3本が空き待ち。/);
  // Fewer files at work than the limit because the rest wait: said so.
  assert.match(statusMarkdown({ ...full, runProgress: { ...full.runProgress, concurrency: 4, callsActive: 2 } }, 'ja'), /依存待ち1件・開始待ち0件（残りのファイルは依存先の完了を待っているため、作業中のファイルが同時の上限より少なくなっています）。/);
  // A change of these counts does not end a status --wait (each call that
  // starts or ends would be a model turn of the parent agent).
  assert.equal(progressKey({ ...fast, runProgress: { ...fast.runProgress, callsActive: 1, unitsAtWork: 1, unitsReady: 1 } }), progressKey(fast));
  // The run's last write: nothing at work any more.
  const last = readJSON(safePath(f.root, `migration/runs/${record.runId}/progress.json`));
  assert.deepEqual([last.callsActive, last.callsWaiting, last.unitsAtWork, last.unitsWaitingOnDependencies, last.unitsReady], [0, 0, 0, 0, 0]);
  // Not after the run, and never from a record of another run or a broken one.
  const after = migrationStatus(f.root);
  assert.equal(after.runProgress, undefined);
  assert.doesNotMatch(statusMarkdown(after, 'en'), /AI calls:/);
  // A record that does not belong to the run holding the lock, or is broken, is not shown.
  const running = { task: 'translation', runId: record.runId };
  const progressFile = safePath(f.root, `migration/runs/${record.runId}/progress.json`);
  assert.ok(runProgress(f.root, running));
  for (const bad of [{ ...record, runId: 'other' }, { ...record, schemaVersion: 2 }, { ...record, callsActive: -1 }, { ...record, unitsReady: '3' }, null]) {
    writeJSON(progressFile, bad);
    assert.equal(runProgress(f.root, running), null, JSON.stringify(bad));
  }
  assert.equal(runProgress(f.root, { task: 'build', runId: record.runId }), null);
  assert.equal(runProgress(f.root, { task: 'translation', runId: '../x' }), null);
});

test('auto mode: translate without an approval makes the checks of approve translation, records the approval of every file left itself, and goes on', async t => {
  const f = await phase04(t, { mode: 'auto' });
  // status: no blocker, and the next step is translate.
  const before = migrationStatus(f.root);
  assert.ok(!before.blockers.some(b => b.path === 'migration/gates/translation.json'), JSON.stringify(before.blockers));
  assert.ok(before.nextActions.some(a => /^Run translate \(the translation approval is missing or out of date\): in auto mode it records the translation approval of every file left itself/.test(a)), before.nextActions.join('\n'));
  assert.equal(before.workflow.next, '04'); assert.equal(before.currentState, 'ready');
  assert.equal(before.autoRecordsApproval, true);
  assert.match(statusMarkdown(before, 'ja'), /実装の開始: translate が承認を自分で記録して開始（自動モード）/);
  const stages = [];
  const report = await translate(f.root, f.config, fake, { onProgress: e => stages.push(e.stage) });
  assert.equal(report.autoApproval, 'there was no translation approval');
  assert.ok(stages.some(s => /^auto mode recorded the translation approval of every file left \(there was no translation approval\)$/.test(s)), stages.join('\n'));
  assert.ok(allDone(f));
  const g = gate(f);
  assert.equal(g.auto, true); assert.equal(g.recordedBy, 'translate'); assert.equal(g.targets, undefined);
  assert.match(g.note, /^Auto mode: translate recorded the approval of every file left itself, with the checks of approve translation/);
  const after = migrationStatus(f.root);
  assert.ok(after.autoMode.records.includes('approve translation'), 'listed among the records made without the person');
  assert.equal(after.autoRecordsApproval, undefined);
});

test('auto mode never stops at the end of a batch it approved; a stale approval is recorded again; a current approval of every file the person made is kept', async t => {
  // A batch auto mode approved: the run covers every file left.
  const f = await phase04(t, { mode: 'auto' });
  approve(f.root, f.config, 'translation', 'Autopilot batch', { batch: 1 });
  assert.deepEqual(gate(f).targets, ['ported/math_ops.mjs']); assert.equal(gate(f).auto, true);
  const report = await translate(f.root, f.config, fake);
  assert.equal(report.autoApproval, 'auto mode had approved a batch of 1 file(s)');
  assert.ok(allDone(f)); assert.equal(gate(f).targets, undefined);
  // An approval that went stale (here: its content hash).
  const s = await phase04(t, { mode: 'auto' });
  approve(s.root, s.config, 'translation', 'Autopilot');
  staleGate(s);
  const stale = await translate(s.root, s.config, fake);
  assert.match(stale.autoApproval, /^the translation approval was not current: translation approval is stale/);
  assert.ok(allDone(s));
  // The person's approval of every file, current: kept as it is.
  const p = await phase04(t, { mode: 'normal' });
  approve(p.root, p.config, 'translation', 'Reviewed by the person');
  const kept = gate(p);
  setPreferences(p.root, { phaseMode: 'auto' });
  const run = await translate(p.root, p.config, fake);
  assert.equal(run.autoApproval, undefined);
  assert.deepEqual(gate(p), kept);
  assert.ok(allDone(p));
  // An approval file that cannot be read: no blocker in auto mode, approve
  // replaces it (until 0.47.0 it failed reading it), and so does translate.
  const u = await phase04(t, { mode: 'auto' });
  atomicWrite(gateFile(u), '{ not json');
  const shown = migrationStatus(u.root);
  assert.ok(!shown.blockers.some(b => b.path === 'migration/gates/translation.json'), JSON.stringify(shown.blockers));
  assert.equal(shown.autoRecordsApproval, true);
  assert.equal(approve(u.root, u.config, 'translation', 'Autopilot').auto, true);
  atomicWrite(gateFile(u), '{ not json');
  const replaced = await translate(u.root, u.config, fake);
  assert.match(replaced.autoApproval, /^the translation approval file could not be read \(/);
  assert.equal(gate(u).recordedBy, 'translate');
  assert.ok(allDone(u));
});

test('auto mode stops at the end of a batch the person chose (approved outside auto mode, or with --stop-at-end); status says to wait for the person, and the next translate records the rest', async t => {
  const f = await phase04(t, { mode: 'normal' });
  approve(f.root, f.config, 'translation', 'The person reviews one file first', { batch: 1 });
  const theirs = gate(f);
  assert.equal(theirs.auto, undefined);
  setPreferences(f.root, { phaseMode: 'auto' });
  const first = await translate(f.root, f.config, fake);
  assert.equal(first.autoApproval, undefined, 'their batch is kept');
  assert.deepEqual(first.scopeTargets, ['ported/math_ops.mjs']);
  assert.deepEqual(gate(f), theirs);
  assert.equal(fs.existsSync(statePath(f.root, f.units[1])), false, 'the run stopped at its end');
  const status = migrationStatus(f.root);
  assert.ok(status.nextActions.some(a => waitWord.test(a)), status.nextActions.join('\n'));
  assert.ok(!status.nextActions.some(a => /obtain approval for the next explicit translation batch/.test(a)));
  const second = await translate(f.root, f.config, fake);
  assert.equal(second.autoApproval, 'every file of the batch of 1 the person chose was done');
  assert.ok(allDone(f));
  assert.equal(gate(f).recordedBy, 'translate');
  // In auto mode, a batch the person asked for is approved with --stop-at-end
  // (the command line's own spelling): it stops at its end the same way.
  const a = await phase04(t, { mode: 'auto' });
  const chosen = approve(a.root, a.config, 'translation', 'The person asked for one file first', { batch: 1, stopAtEnd: true });
  assert.equal(chosen.auto, true); assert.equal(chosen.stopAtEnd, true);
  const run = await translate(a.root, a.config, fake);
  assert.equal(run.autoApproval, undefined, 'kept');
  assert.deepEqual(run.scopeTargets, ['ported/math_ops.mjs']);
  assert.equal(fs.existsSync(statePath(a.root, a.units[1])), false, 'the run stopped at its end');
  assert.ok(migrationStatus(a.root).nextActions.some(a => waitWord.test(a)));
  assert.equal((await translate(a.root, a.config, fake)).autoApproval, 'every file of the batch of 1 the person chose was done');
  assert.ok(allDone(a));
  // Without a batch it has no end to stop at: refused, nothing recorded.
  const n = await phase04(t, { mode: 'auto' });
  assert.throws(() => approve(n.root, n.config, 'translation', 'Autopilot', { stopAtEnd: true }), /^Error: Option --stop-at-end does not apply to approve translation without --batch N or --targets PATH,PATH: write the batch the person chose in the same command/);
  assert.equal(fs.existsSync(gateFile(n)), false);
  // The command line passes it on.
  assert.deepEqual(parseCommandLine(['approve', 'translation', '--batch', '5', '--stop-at-end', '--note', 'x'], specs.run_migration)['stop-at-end'], true);
});

test('approve says when auto mode will go on past a batch it records, refuses --stop-at-end without a batch before phase 03 is recorded, and never replaces an approval it cannot read for a reason other than its JSON', async t => {
  const f = await phase04(t, { mode: 'auto' });
  const script = safePath(f.root, 'migration-kit/scripts/run_migration.mjs');
  const cli = (...args) => runProcess(process.execPath, [script, ...args], { cwd: f.root });
  const goesOn = /NOTE: auto mode does not stop at the end of this batch of 1 file\(s\): translate goes on with every file left\. If the person asked for this batch first, approve it again with --stop-at-end/;
  const plain = await cli('approve', 'translation', '--batch', '1', '--note', 'Autopilot batch');
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stderr, goesOn);
  const chosen = await cli('approve', 'translation', '--batch', '1', '--stop-at-end', '--note', 'The person asked for one file first');
  assert.equal(chosen.code, 0, chosen.stderr);
  assert.doesNotMatch(chosen.stderr, /NOTE: auto mode does not stop/);
  for (const g of [{ auto: true }, { targets: ['a'] }, { targets: ['a'], auto: true, stopAtEnd: true }, { targets: ['a'], auto: true, recordedBy: 'translate' }, null]) assert.equal(autoBatchNotice(g), null, JSON.stringify(g));
  // --complete-phase 03 with --stop-at-end and no batch: nothing is recorded.
  const p = prepare(t);
  p.config.phasePolicy = 'strict'; writeJSON(safePath(p.root, 'migration/state/config.json'), p.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(p.root, name), 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  phaseCommand(p.root, p.config, 'init');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(p.root, p.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await runStage(p.root, p.config, 'judge');
  fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(p.root, 'migration/guardrails.json'));
  const refused = await runProcess(process.execPath, [safePath(p.root, 'migration-kit/scripts/run_migration.mjs'), 'approve', 'translation', '--complete-phase', '03', '--stop-at-end', '--note', 'Reviewed'], { cwd: p.root });
  assert.equal(refused.code, 1); assert.match(refused.stderr, /Option --stop-at-end does not apply to approve translation without --batch N/);
  assert.equal(currentPhase(p.root, p.config, '03'), false, 'phase 03 not recorded');
  assert.equal(fs.existsSync(gateFile(p)), false);
  // Its words are a command line's error, never an approval's: in auto mode
  // the approval guidance would run translate, which approves every file
  // left instead of the person's batch. The same for --complete-phase.
  const wrongPhase = await cli('approve', 'build', '--complete-phase', '03', '--note', 'Reviewed');
  assert.equal(wrongPhase.code, 1);
  const phaseRefusal = 'Option --complete-phase does not apply to approve build --complete-phase 03: it applies only as approve translation --complete-phase 03. Add --help for usage.';
  assert.match(wrongPhase.stderr, new RegExp(phaseRefusal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const message of [stopAtEndRefusal('translation'), stopAtEndRefusal('build'), phaseRefusal]) {
    const g = failureGuidance(new Error(message), { root: f.root });
    assert.equal(g.id, 'command-line', message);
    assert.ok(g.options.some(o => o.id === 'fix-command'));
  }
  // approve build --stop-at-end is refused before anything else, and
  // writes nothing (the build approval retires phase 04's waiver once every
  // file is reviewed): here every file is done.
  const b = await phase04(t, { mode: 'auto' });
  // Before any file is done (the build approval's own checks would refuse).
  assert.throws(() => approve(b.root, b.config, 'build', 'Reviewed', { stopAtEnd: true }), e => e.message === stopAtEndRefusal('build'));
  await translate(b.root, b.config, fake);
  assert.ok(allDone(b));
  const tree = root => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8'); } }; walk(safePath(root, 'migration')); return out; };
  const before = tree(b.root);
  assert.throws(() => approve(b.root, b.config, 'build', 'Reviewed', { stopAtEnd: true }), e => e.message === stopAtEndRefusal('build'));
  assert.deepEqual(tree(b.root), before, 'nothing written');
  const buildCli = await runProcess(process.execPath, [safePath(b.root, 'migration-kit/scripts/run_migration.mjs'), 'approve', 'build', '--stop-at-end', '--note', 'Reviewed'], { cwd: b.root });
  assert.equal(buildCli.code, 1); assert.match(buildCli.stderr, /Option --stop-at-end does not apply to approve build: it marks a batch of the translation approval/);
  // (The command's start brings the settings file and its records up to
  // date, as any command that may change something does.)
  const startup = ['migration/settings.json', 'migration/state/settings-applied.json', 'migration/state/context-upgrade.json'];
  const without = t => Object.fromEntries(Object.entries(t).filter(([k]) => !startup.includes(k.split(path.sep).join('/'))));
  assert.deepEqual(without(tree(b.root)), without(before), 'nothing written by the command either');
  // An approval file approve cannot read for another reason than its JSON
  // (EBUSY or EACCES on Windows; a folder in its place here) stops approve
  // where it reads it, before it writes anything in its place.
  const u = await phase04(t, { mode: 'auto' });
  fs.mkdirSync(gateFile(u), { recursive: true });
  assert.throws(() => approve(u.root, u.config, 'translation', 'Autopilot'), e => e.code === 'EISDIR' && e.syscall === 'read');
  assert.ok(fs.statSync(gateFile(u)).isDirectory(), 'left in place');
});

test('auto mode approves nothing when a check of approve translation fails; normal mode, repairs and the batch end outside auto mode are as before', async t => {
  // The stress report is gone: phase 03 is out of date. That failure of the
  // gate is not about the approval: it stops translate as before.
  const f = await phase04(t, { mode: 'auto' });
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  const failed = await translate(f.root, f.config, fake).then(() => null, e => e);
  assert.ok(failed);
  assert.match(failed.message, /^Phase 03's record is out of date/);
  assert.equal(fs.existsSync(gateFile(f)), false, 'no approval written');
  assert.ok(!f.units.some(u => fs.existsSync(statePath(f.root, u))), 'nothing translated');
  assert.notEqual(failureGuidance(failed, { root: f.root }).id, 'unknown', 'it keeps its own guidance');
  assert.ok(migrationStatus(f.root).blockers.some(b => b.path === 'migration/gates/translation.json' && /^Phase 03's record is out of date/.test(b.reason)));
  // Phase 03 waived and a report gone: the gate only lacks its approval, and
  // a check of approve translation refuses; status says the same first.
  const w = await phase04(t, { mode: 'auto' });
  fs.rmSync(safePath(w.root, 'migration/feasibility.md'));
  phaseCommand(w.root, w.config, 'waive', '03', { note: 'Auto mode: the stress test could not run (test fixture)' });
  const shown = migrationStatus(w.root);
  assert.ok(shown.blockers.some(b => /^Auto mode could not record the translation approval itself: Review artifact required: migration\/feasibility\.md/.test(b.reason)), JSON.stringify(shown.blockers));
  assert.equal(shown.autoRecordsApproval, undefined);
  assert.ok(!shown.nextActions.some(a => /^Run translate/.test(a)), shown.nextActions.join('\n'));
  const refused = await translate(w.root, w.config, fake).then(() => null, e => e);
  assert.match(refused?.message ?? '', /^Auto mode could not record the translation approval itself: Review artifact required: migration\/feasibility\.md/);
  assert.equal(failureGuidance(refused, { root: w.root }).id, 'artifact', 'the check keeps its own guidance');
  assert.equal(fs.existsSync(gateFile(w)), false, 'no approval written');
  // A file another program holds (or any other error of the gate) is never
  // taken for a missing approval.
  const held = Object.assign(new Error('EBUSY: resource busy or locked, open \'migration/gates/translation.json\''), { code: 'EBUSY' });
  assert.equal(translationApprovalOnly(w.root, held), false);
  assert.equal(translationApprovalOnly(w.root, new SyntaxError('Unexpected token')), false, 'a parse error of another file');
  // Normal mode: translate still refuses, and status and guidance say autopilot refuses the question.
  const n = await phase04(t, { mode: 'normal' });
  await assert.rejects(translate(n.root, n.config, fake), /^Error: No translation approval/);
  assert.equal(fs.existsSync(gateFile(n)), false);
  const status = migrationStatus(n.root);
  assert.ok(status.blockers.some(b => b.path === 'migration/gates/translation.json'));
  assert.ok(status.nextActions.some(a => /approve translation with a concrete note \(the person's decision; Copilot CLI autopilot refuses the approval question by itself, so approve in an interactive session without autopilot, or choose auto mode\)/.test(a)), status.nextActions.join('\n'));
  assert.equal(status.currentState, 'awaiting-approval');
  for (const language of ['ja', 'en']) {
    const g = failureGuidance('No translation approval. Review the artifacts and explicitly run approve translation.', { root: n.root, language });
    assert.equal(g.id, 'approval'); assert.equal(g.actionRequired, true);
    assert.deepEqual(g.options.map(o => o.id).slice(0, 2), ['review-approve', 'revise']);
    assert.match(g.options[0].reason, language === 'ja' ? /autopilot ではこの確認が自動で断られて止まるため、autopilot を使わずに対話で承認するか、自動モードを選んでください/ : /autopilot refuses this question by itself and stops there: approve in an interactive session without autopilot, or choose auto mode/);
  }
  // The batch end outside auto mode still waits for the person's next batch.
  approve(n.root, n.config, 'translation', 'The person reviews one file first', { batch: 1 });
  await translate(n.root, n.config, fake);
  assert.ok(migrationStatus(n.root).nextActions.some(a => /^Review the completed batch; obtain approval for the next explicit translation batch \(the person's decision; Copilot CLI autopilot refuses/.test(a)));
  // Relaxed mode, and auto mode chosen without its own record (a hand-edited
  // preferences file), refuse as before too.
  const x = await phase04(t, { mode: 'relaxed' });
  await assert.rejects(translate(x.root, x.config, fake), /^Error: No translation approval/);
  assert.equal(fs.existsSync(gateFile(x)), false);
  const h = await phase04(t, { mode: 'auto' });
  fs.rmSync(safePath(h.root, 'migration/phases/auto-mode.json'));
  await assert.rejects(translate(h.root, h.config, fake), /^Error: No translation approval/);
  assert.equal(fs.existsSync(gateFile(h)), false);
  assert.equal(migrationStatus(h.root).autoRecordsApproval, undefined);
  // A repair never records an approval, in auto mode either.
  const r = await phase04(t, { mode: 'auto' });
  atomicWrite(safePath(r.root, 'migration/evidence.txt'), 'diagnostic\n');
  await assert.rejects(translate(r.root, r.config, fake, { onlyTarget: r.units[0].target, evidence: 'migration/evidence.txt' }), /No translation approval/);
  assert.equal(fs.existsSync(gateFile(r)), false);
});

test('the approval guidance asks nothing in auto mode: translate for the translation approval, approve STAGE alone for another, judge first without a judge run', async t => {
  const f = await phase04(t, { mode: 'auto' });
  for (const language of ['ja', 'en']) {
    const translation = failureGuidance('No translation approval. Review the artifacts and explicitly run approve translation.', { root: f.root, language });
    assert.equal(translation.id, 'approval'); assert.equal(translation.actionRequired, false);
    assert.equal(translation.options[0].id, 'run-translate');
    assert.match(translation.options[0].command, /run_migration\.mjs translate$/);
    const md = guidanceMarkdown(translation, language);
    assert.match(md, language === 'ja' ? /判断は不要です。質問せずにそのまま続けてください。/ : /No decision is needed; continue without asking\./);
    assert.match(md, /run_migration\.mjs translate`/, 'the step\'s command is shown');
    assert.doesNotMatch(md, /どれで進めるか|Choose how to proceed/);
    const build = failureGuidance('No build approval. Review the artifacts and explicitly run approve build.', { root: f.root, language });
    assert.equal(build.actionRequired, false); assert.equal(build.options[0].id, 'approve-auto');
    assert.match(build.options[0].command, /run_migration\.mjs approve build --note '[^'$`]+'$/);
    assert.ok(!build.options.some(o => o.id === 'review-approve'));
    // The command as given runs unasked in auto mode: one command, a note in single quotes.
    assert.equal(interactiveDecision({ toolName: 'bash', toolArgs: { command: build.options[0].command.replace(/^node \S+/, kit) }, cwd: f.root }, f.root), null);
    // So does a batch the person asked for.
    assert.equal(interactiveDecision({ toolName: 'bash', toolArgs: { command: `${kit} approve translation --batch 5 --stop-at-end --note 'The person asked for five files first'` }, cwd: f.root }, f.root), null);
    const judge = failureGuidance('Run judge successfully for these inputs before approving translation', { root: f.root, language });
    assert.equal(judge.options[0].id, 'run-judge'); assert.match(judge.options[0].command, /run_migration\.mjs judge$/);
    assert.equal(judge.actionRequired, false);
  }
  // Outside auto mode a missing judge run also comes first, and the person still decides.
  const normal = failureGuidance('Run judge successfully for these inputs before approving translation', { language: 'en' });
  assert.equal(normal.options[0].id, 'run-judge'); assert.equal(normal.actionRequired, true);
  assert.ok(normal.options.some(o => o.id === 'review-approve'));
});

test('auto mode keeps a batch the person chose when its approval goes out of date: translate approves that batch again, with each file it needs that is no longer done, and still stops at its end', async t => {
  const f = await phase04(t, { mode: 'normal' });
  approve(f.root, f.config, 'translation', 'The person reviews one file first', { batch: 1 });
  setPreferences(f.root, { phaseMode: 'auto' });
  staleGate(f);
  const before = migrationStatus(f.root);
  assert.ok(before.nextActions.some(a => /^Run translate \(the approval of the batch of 1 file\(s\) the person chose is out of date; 1 file\(s\) to do for it, counting each file it needs that is no longer done\): in auto mode it records the approval of those files again itself/.test(a)), before.nextActions.join('\n'));
  assert.ok(!before.blockers.some(b => b.path === 'migration/gates/translation.json'), JSON.stringify(before.blockers));
  const stages = [];
  const first = await translate(f.root, f.config, fake, { onProgress: e => stages.push(e.stage) });
  assert.match(first.autoApproval, /^the translation approval was not current: translation approval is stale/);
  assert.deepEqual(first.scopeTargets, ['ported/math_ops.mjs']);
  assert.ok(stages.some(s => /^auto mode recorded the translation approval of the batch the person chose again \(/.test(s)), stages.join('\n'));
  const again = gate(f);
  assert.deepEqual([again.targets, again.stopAtEnd, again.auto, again.recordedBy], [['ported/math_ops.mjs'], true, true, 'translate']);
  assert.match(again.note, /^Auto mode: translate recorded the approval of the batch the person chose again itself \(1 file\(s\)\)/);
  assert.equal(fs.existsSync(statePath(f.root, f.units[1])), false, 'the run stopped at the end of their batch');
  assert.ok(migrationStatus(f.root).nextActions.some(a => waitWord.test(a)));
  // Their batch done, then out of date: the end of their batch, as before;
  // once they say to go on, translate records every file left.
  staleGate(f);
  const end = migrationStatus(f.root);
  assert.ok(end.nextActions.some(a => waitWord.test(a)), end.nextActions.join('\n'));
  assert.ok(!end.nextActions.some(a => /^Run translate/.test(a)), end.nextActions.join('\n'));
  const second = await translate(f.root, f.config, fake);
  assert.match(second.autoApproval, /^the translation approval was not current/);
  assert.equal(gate(f).targets, undefined);
  assert.ok(allDone(f));
  // A file their batch uses that is no longer done is approved with it, and
  // nothing else is.
  const d = await phase04(t, { count: 3, mode: 'normal' });
  approve(d.root, d.config, 'translation', 'The person reviews the files main uses first', { batch: 2 });
  await translate(d.root, d.config, fake);
  approve(d.root, d.config, 'translation', 'Then main', { targets: ['ported/main.mjs'] });
  setPreferences(d.root, { phaseMode: 'auto' });
  const math = d.units.find(u => u.target === 'ported/math_ops.mjs'), text = d.units.find(u => u.target === 'ported/text_ops.mjs');
  const textState = fs.readFileSync(statePath(d.root, text));
  fs.rmSync(statePath(d.root, math));
  staleGate(d);
  // Status counts the file it needs with it, and says so.
  assert.ok(migrationStatus(d.root).nextActions.some(a => /^Run translate \(the approval of the batch of 1 file\(s\) the person chose is out of date; 2 file\(s\) to do for it, counting each file it needs that is no longer done\)/.test(a)));
  const run = await translate(d.root, d.config, fake);
  const expected = d.units.map(u => u.target).filter(p => ['ported/math_ops.mjs', 'ported/main.mjs'].includes(p));
  assert.deepEqual(run.scopeTargets, expected);
  assert.deepEqual([gate(d).targets, gate(d).stopAtEnd], [expected, true]);
  assert.ok(allDone(d));
  assert.deepEqual(fs.readFileSync(statePath(d.root, text)), textState, 'a file their batch uses that is done is left as it is');
  // Two files that use each other, without a unit typecheck: as the scope
  // check, the batch approved again does not hold the first to the second.
  const m = await phase04(t, { mode: 'normal', setup: x => {
    x.config.commands.typecheck = null;
    writeJSON(safePath(x.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: { 'src/math_ops.py': ['src/text_ops.py'], 'src/text_ops.py': ['src/math_ops.py'] } });
  } });
  approve(m.root, m.config, 'translation', 'The person reviews one file first', { targets: ['ported/math_ops.mjs'] });
  setPreferences(m.root, { phaseMode: 'auto' });
  staleGate(m);
  const one = await translate(m.root, m.config, fake);
  assert.deepEqual(one.scopeTargets, ['ported/math_ops.mjs']);
  assert.deepEqual(gate(m).targets, ['ported/math_ops.mjs']);
  assert.equal(fs.existsSync(statePath(m.root, m.units[1])), false, 'the other file of the pair waits for the person');
});

test('auto mode with every file done and the translation approval out of date: status and the guidance of approve build say to run translate, which records it; outside auto mode the person reviews the change', async t => {
  const f = await phase04(t, { mode: 'auto' });
  await translate(f.root, f.config, fake);
  assert.ok(allDone(f));
  staleGate(f);
  const status = migrationStatus(f.root);
  assert.ok(status.nextActions.some(a => /^Run translate \(every file is done; the approval build needs is missing or out of date\)/.test(a)), status.nextActions.join('\n'));
  assert.ok(!status.nextActions.some(a => /approve (?:build|smoke|parity)/.test(a)), 'no approval of a later stage, which would fail on it');
  const refused = (() => { try { approve(f.root, f.config, 'build', 'Autopilot'); return null; } catch (e) { return e; } })();
  assert.match(refused?.message ?? '', /^translation approval is stale/);
  for (const language of ['ja', 'en']) for (const message of [refused.message, 'translation approval belongs to a different execution purpose', 'Invalid translation approval scope']) {
    const g = failureGuidance(message, { root: f.root, language });
    assert.equal(g.id, 'approval', message); assert.equal(g.actionRequired, false, message);
    assert.equal(g.options[0].id, 'run-translate', message);
  }
  // The gate of another stage names its own stage, which approve STAGE records.
  assert.equal(failureGuidance('build approval belongs to a different execution purpose', { root: f.root }).id, 'unknown');
  const run = await translate(f.root, f.config, fake);
  assert.match(run.autoApproval, /^the translation approval was not current: translation approval is stale/);
  assert.ok(migrationStatus(f.root).nextActions.some(a => /^Review current evidence; approve build with a concrete note and run build/.test(a)));
  assert.equal(approve(f.root, f.config, 'build', 'Autopilot').auto, true);
  // Outside auto mode the same failure keeps its own guidance.
  const n = await phase04(t, { mode: 'normal' });
  assert.equal(failureGuidance(refused.message, { root: n.root }).id, 'inputs-changed');
  assert.equal(failureGuidance(refused.message, { root: n.root }).actionRequired, true);
});

// A pilot is a trial in a copy outside the project: its runner approves its
// own translation, so translate never records one there, in auto mode either.
test('a pilot never has translate record the translation approval itself, in auto mode either', async t => {
  const f = prepare(t, { realCommands: true, count: 3 });
  f.config.phasePolicy = 'strict'; f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, name), 'Disposable preparation fixture; not actual AI review or human signoff.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for boundary tests only' });
  await runStage(f.root, f.config, 'judge');
  setPreferences(f.root, { phaseMode: 'auto' });
  const child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Auto mode: 1 chosen file', expectTotal: 1 });
  setPreferences(child, { phaseMode: 'auto' });
  assert.equal(autoPhases(child), true, 'auto mode is on in the copy');
  const config = loadConfig(child);
  await runStage(child, config, 'judge');
  await assert.rejects(translate(child, config, fake), /^Error: No translation approval/);
  assert.equal(fs.existsSync(safePath(child, 'migration/gates/translation.json')), false);
  assert.equal(migrationStatus(child).autoRecordsApproval, undefined);
  for (const message of ['No translation approval. Review the artifacts and explicitly run approve translation.', 'translation approval is stale; inputs or outputs changed']) {
    const g = failureGuidance(message, { root: child, language: 'en' });
    assert.equal(g.actionRequired, true, message);
    assert.ok(!g.options.some(o => o.id === 'run-translate'), message);
  }
  assert.equal(failureGuidance('translation approval is stale; inputs or outputs changed', { root: child }).id, 'inputs-changed', 'kept as before');
});
