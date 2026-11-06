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
import { prepare, fake, result } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, statePath } from '../lib/core.mjs';
import { translate, approve, runStage } from '../lib/pipeline.mjs';
import { runProcess, callLimitMessage, callLimiter } from '../lib/process.mjs';
import { createCopilotAdapter, answerWatch, isStreamedDelta } from '../scripts/copilot_adapter.mjs';
import { failureGuidance, guidanceMarkdown } from '../lib/guidance.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { statusSnapshot, runProgress } from '../lib/status-snapshot.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { interactiveDecision } from '../lib/guardrails.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { kitRoot } from '../scripts/install.mjs';

const gateFile = f => safePath(f.root, 'migration/gates/translation.json');
const gate = f => readJSON(gateFile(f));
const allDone = f => f.units.every(u => fs.existsSync(statePath(f.root, u)) && readJSON(statePath(f.root, u)).status === 'done');
// A strict project with phases 00 to 03 recorded by the person, the judge run
// and the guardrails installed: ready for phase 04 except its approval.
async function phase04(t, { count = 2, mode } = {}) {
  const f = prepare(t, { count });
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
    const plain = callLimiter(1000, { ...(check ? { writing: check } : {}), clock });
    assert.deepEqual(ticks(plain, 20), [...Array(19).fill(false), true]);
    assert.equal(plain.writingAtStop, false);
  }
});

test('answerWatch reads from the CLI\'s events whether the main agent is writing its answer', () => {
  const w = answerWatch(), ev = e => w.line(JSON.stringify(e));
  assert.equal(w.writing(), false);
  ev({ type: 'assistant.turn_start', data: { turnId: '1' } }); assert.equal(w.writing(), false);
  ev({ type: 'assistant.reasoning_delta', data: { deltaContent: 'thinking' } }); assert.equal(w.writing(), false, 'reasoning is not its answer');
  ev({ type: 'assistant.message_delta', data: { deltaContent: '' } }); assert.equal(w.writing(), false, 'an empty piece');
  ev({ type: 'assistant.message_delta', data: { deltaContent: '{"schemaVersion"' } }); assert.equal(w.writing(), true);
  ev({ type: 'tool.execution_start', data: { toolName: 'view' } }); assert.equal(w.writing(), false, 'a tool call ends it');
  ev({ type: 'assistant.message_delta', data: { deltaContent: 'x' } }); assert.equal(w.writing(), true);
  ev({ type: 'assistant.turn_start', data: { turnId: '2' } }); assert.equal(w.writing(), false, 'a new turn ends it');
  ev({ type: 'assistant.message_delta', agentId: 'sub', data: { deltaContent: 'x' } }); assert.equal(w.writing(), false, 'a subagent\'s text is not its answer');
  ev({ type: 'assistant.message_delta', data: { deltaContent: 'x', parentToolCallId: 'call_1' } }); assert.equal(w.writing(), false);
  ev({ type: 'assistant.message', data: { content: 'Let me read it', toolRequests: [{ name: 'view' }] } }); assert.equal(w.writing(), false, 'a reply that asks for tools');
  ev({ type: 'assistant.message', data: { content: '{"kind":"review"}', toolRequests: [] } }); assert.equal(w.writing(), true, 'the final reply: the result is next');
  for (const line of ['not json', '{"type":"assistant.message_delta"', '"assistant.turn_start"', JSON.stringify({ type: 'session.info', data: {} })]) w.line(line);
  assert.equal(w.writing(), true, 'a broken or other line changes nothing');
  ev({ type: 'tool.execution_start', agentId: 'sub', data: { toolName: 'grep' } }); assert.equal(w.writing(), false, 'any agent\'s tool call');
  // The pieces the watch reads are the ones the runner drops from its logs.
  assert.equal(isStreamedDelta(JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'x' } })), true);
});

// A stand-in for the Copilot CLI that streams its answer slowly (--stream on).
function streamingCli(f, name, body) {
  const file = safePath(f.root, name);
  atomicWrite(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
const started = Date.now();
// Never outlives the test, whatever the limit does.
setTimeout(() => process.exit(0), 30000);
${body}
`);
  return createCopilotAdapter({ command: process.execPath, prefixArgs: [file] });
}
const call = (f, adapter, callLimitMs) => adapter({ root: f.root, config: f.config, role: 'reviewer-semantics', unit: f.units[0], reviewInput: '{"mode":"frozen"}', extra: {}, callLimitMs });

test('end to end: the real adapter lets a CLI still writing its answer at its limit finish, stops one writing past twice the limit, and stops one at work with tools at the limit', { timeout: 60000 }, async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const answer = JSON.stringify(result('reviewer-semantics', f.units[0]));
  const limit = 2000;
  // Still writing at its limit; done at about 1.4 times the limit.
  const finishing = streamingCli(f, 'finishing-cli.mjs', `const answer = ${JSON.stringify(answer)};
out({ type: 'assistant.turn_start', data: { turnId: '1' } });
const timer = setInterval(() => {
  out({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'x' } });
  if (Date.now() - started > ${1.4 * limit}) { clearInterval(timer); out({ type: 'assistant.message', data: { content: answer, toolRequests: [] } }); out({ type: 'result', exitCode: 0 }); process.exit(0); }
}, 25);`);
  const done = await call(f, finishing, limit);
  assert.equal(done.result.verdict, 'pass', 'its answer is used');
  // Writes forever: stopped at twice its limit, and says so.
  const forever = streamingCli(f, 'forever-cli.mjs', `out({ type: 'assistant.turn_start', data: { turnId: '1' } });
setInterval(() => out({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'x' } }), 25);`);
  const at = Date.now();
  const stopped = await call(f, forever, limit).then(() => null, e => e);
  assert.ok(stopped, 'stopped');
  assert.equal(stopped.callLimit, true); assert.equal(stopped.writingAtLimit, true);
  assert.equal(stopped.message, callLimitMessage(limit, { writing: true }));
  assert.ok(Date.now() - at >= 2 * limit, `not before twice the limit (${Date.now() - at} ms)`);
  // At work with tools: stopped at its limit, as in 0.47.0.
  const reading = streamingCli(f, 'reading-cli.mjs', `let n = 0;
setInterval(() => { n++; out({ type: 'assistant.turn_start', data: { turnId: String(n) } }); out({ type: 'tool.execution_start', data: { toolCallId: 'call_' + n, toolName: 'view', arguments: {} } }); }, 25);`);
  const tools = await call(f, reading, limit).then(() => null, e => e);
  assert.ok(tools, 'stopped');
  assert.equal(tools.callLimit, true); assert.equal(tools.writingAtLimit, undefined);
  assert.equal(tools.message, callLimitMessage(limit));
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
  assert.match(state.error, /^Copilot implementer ran past its call limit on 2 attempts \(30 min, then 60 min on the retry; workerCallBaseMinutes\), the last time while still writing its answer at twice its limit; this file is set aside for this run/);
  assert.equal(failureGuidance(state.error).id, 'cli-call-limit');
  assert.equal(readJSON(statePath(f.root, f.units[1])).status, 'done', 'the other file went on');
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
  writeJSON(gateFile(s), { ...gate(s), contextHash: 'f'.repeat(64) });
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
});

test('auto mode stops at the end of a batch the person approved outside it; status says to wait for the person, and the next translate records the rest', async t => {
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
  assert.ok(status.nextActions.some(a => /^The batch of 1 file\(s\) the person approved is done: tell the person and wait for their word \(auto mode stops at a batch only when the person chose it\); when they say to go on, run translate/.test(a)), status.nextActions.join('\n'));
  assert.ok(!status.nextActions.some(a => /obtain approval for the next explicit translation batch/.test(a)));
  const second = await translate(f.root, f.config, fake);
  assert.equal(second.autoApproval, 'every file of the batch of 1 the person approved was done');
  assert.ok(allDone(f));
  assert.equal(gate(f).recordedBy, 'translate');
});

test('auto mode approves nothing when a check of approve translation fails; normal mode, repairs and the batch end outside auto mode are as before', async t => {
  // The stress report is gone: phase 03 and the approval's check fail.
  const f = await phase04(t, { mode: 'auto' });
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  const failed = await translate(f.root, f.config, fake).then(() => null, e => e);
  assert.ok(failed);
  assert.match(failed.message, /^Auto mode could not record the translation approval itself: /);
  assert.equal(fs.existsSync(gateFile(f)), false, 'no approval written');
  assert.ok(!f.units.some(u => fs.existsSync(statePath(f.root, u))), 'nothing translated');
  assert.notEqual(failureGuidance(failed, { root: f.root }).id, 'unknown', 'the check keeps its own guidance');
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
    const judge = failureGuidance('Run judge successfully for these inputs before approving translation', { root: f.root, language });
    assert.equal(judge.options[0].id, 'run-judge'); assert.match(judge.options[0].command, /run_migration\.mjs judge$/);
    assert.equal(judge.actionRequired, false);
  }
  // Outside auto mode a missing judge run also comes first, and the person still decides.
  const normal = failureGuidance('Run judge successfully for these inputs before approving translation', { language: 'en' });
  assert.equal(normal.options[0].id, 'run-judge'); assert.equal(normal.actionRequired, true);
  assert.ok(normal.options.some(o => o.id === 'review-approve'));
});
