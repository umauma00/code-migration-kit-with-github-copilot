// SPDX-License-Identifier: Apache-2.0
// 2026-10-30: a phase 03 pilot stayed at 0 of 26 for over an hour while
// workers were blocked one by one with the Copilot CLI's own "assistant.reasoning
// event delivery" timeout. That wait is fixed inside the CLI (1.0.105 runtime:
// "Session host did not acknowledge '<event>' delivery within ..."), so the
// runner must retry the call instead of blocking the unit and every unit that
// depends on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, result } from './helpers.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { safePath, writeJSON, readJSON, atomicWrite } from '../lib/core.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { isTransientFailure, isSystemicFailure, hostStallRetries } from '../lib/failures.mjs';
import { failureGuidance } from '../lib/guidance.mjs';

const stall = "Session host did not acknowledge 'assistant.reasoning' delivery within 120s";
const wedged = 'SessionClient: a waited send timed out after 60000ms waiting for the event stream to dispatch through the turn tail (sequence 42); the event poll loop may be wedged.';
const error = (message, stderr = '') => Object.assign(new Error(message), { result: { stderr } });

test('the CLI host stall is a transient failure in the message, on stderr and as a session.error', () => {
  for (const e of [error(`Copilot implementer failed (exit 1): ${stall}`),
    error('Copilot implementer failed (exit 1)', `Error: ${stall}\n`),
    error(`Copilot reviewer-semantics failed (exit 1): session.error query: ${stall}`),
    error("Copilot surveyor failed (exit 1): pending-request event delivery was not acknowledged by the session host"),
    error(`Copilot implementer failed (exit 1): ${wedged}`)]) {
    assert.equal(isTransientFailure(e), true, e.message);
    assert.equal(isSystemicFailure(e), false, e.message);
  }
  // The kit's own deadline and cancellation stay final even next to the stall.
  assert.equal(isTransientFailure(error(`Process timed out after 600000ms (explicit bounded deadline); ${stall}`)), false);
  assert.equal(isTransientFailure(error(`Interrupted; ${stall}`)), false);
  // Other delivery wording is not swept in.
  assert.equal(isTransientFailure(error('Copilot implementer failed (exit 1): client task cancellation delivery failed')), false);
});

async function stallFixture(t, failures, executionMode = 'bounded', rateLimited = 0) {
  const f = prepare(t, { executionMode }); f.config.transientRetryDelayMs = 1;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Regression fixture only');
  const unit = f.units[0], counter = safePath(f.root, 'calls.txt'), script = safePath(f.root, 'stall-cli.mjs');
  const responses = Object.fromEntries(['implementer', 'reviewer-semantics', 'reviewer-rules'].map(role => [role, result(role, unit)]));
  atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
for await (const _ of process.stdin);
const role = process.env.MIGRATION_KIT_ROLE, n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
if (n < ${rateLimited}) { process.stderr.write('Error: 429 Rate limit exceeded\\n'); process.exit(1); }
if (n < ${rateLimited} + ${failures}) { process.stderr.write(${JSON.stringify(`Error: ${stall}\n`)}); process.exit(1); }
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(responses)}[role]), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
  try { return { f, report: await translate(f.root, f.config, createCopilotAdapter({ command: process.execPath, prefixArgs: [script] })) }; }
  catch (e) { e.root = f.root; throw e; }
}

for (const rateLimited of [0, 5]) test(`a stall that never clears blocks the unit after ${hostStallRetries} stall retries (after ${rateLimited} rate-limit retries)`, async t => {
  // Continuous mode has no retry-count limit for other transient failures;
  // earlier rate-limit retries on the same call do not use up the stall cap.
  const failure = await stallFixture(t, Infinity, 'continuous', rateLimited).then(() => null, e => e);
  assert.ok(failure, 'the run reports the blocked unit');
  assert.match(failure.message, /did not acknowledge 'assistant\.reasoning' delivery/);
  assert.equal(Number(fs.readFileSync(safePath(failure.root, 'calls.txt'), 'utf8')), rateLimited + hostStallRetries + 1);
  assert.equal(failureGuidance(failure, { language: 'ja' }).id, 'cli-host-stall');
});

test('bounded mode keeps its own retry limit for stalls (default 2)', async t => {
  const failure = await stallFixture(t, Infinity, 'bounded').then(() => null, e => e);
  assert.ok(failure);
  assert.equal(Number(fs.readFileSync(safePath(failure.root, 'calls.txt'), 'utf8')), 3);
});

test('surveys count stall retries apart from other transient retries too', () => {
  const source = fs.readFileSync(new URL('../lib/survey.mjs', import.meta.url), 'utf8');
  assert.match(source, /retry >= limits\.retries \|\| \(isLimitedRetry\(e\) && stalls\+\+ >= hostStallRetries\)/);
});

test('a worker whose CLI stalls once is retried and the unit completes', async t => {
  const { f, report } = await stallFixture(t, 1);
  assert.equal(report.done, 1);
  assert.deepEqual(report.errors ?? [], []);
  const runDir = safePath(f.root, `migration/runs/${report.runId}`);
  const implementer = fs.readdirSync(runDir).filter(n => n !== 'summary.json' && n.endsWith('.json')).map(n => readJSON(path.join(runDir, n))).find(a => a.role === 'implementer');
  assert.equal(implementer.retries.length, 1);
  assert.match(implementer.retries[0].error, /did not acknowledge 'assistant\.reasoning' delivery/);
  assert.equal(implementer.retries[0].hostStall, true);
});

test('guidance explains the stall in plain words and offers rerun and fewer parallel workers', () => {
  for (const language of ['ja', 'en']) {
    const g = failureGuidance(new Error(`Copilot implementer failed (exit 1): ${stall}`), { language });
    assert.equal(g.id, 'cli-host-stall');
    assert.deepEqual(g.options.map(o => o.id), ['rerun', 'lower-concurrency', 'pause']);
  }
  assert.match(failureGuidance(new Error(stall), { language: 'ja' }).cause, /これを延ばす設定は見当たりません/);
  // The kit's own deadline and a cancellation are final: not described as retried.
  assert.equal(failureGuidance(new Error(`Process timed out after 600000ms (explicit bounded deadline); ${stall}`)).id, 'timeout');
  assert.notEqual(failureGuidance(new Error(`Interrupted; ${stall}`)).id, 'cli-host-stall');
});
