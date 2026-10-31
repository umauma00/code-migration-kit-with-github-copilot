// SPDX-License-Identifier: Apache-2.0
// 2026-10-31: a Windows phase 03 pilot (kit 0.29) recorded what stopped it.
// Workers failed with "session event delivery failed: session host did not
// complete the assistant.reasoning event within 120s", a wording the 0.28.0
// stall retry did not know, so each file was blocked on its first stall. A
// reviewer's ETIMEDOUT followed by the CLI's sign-in help stopped the whole run
// as a sign-in problem although the CLI was signed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, result } from './helpers.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { safePath, writeJSON, readJSON, atomicWrite } from '../lib/core.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { isTransientFailure, isSystemicFailure, isHostStall, isNetworkFailure } from '../lib/failures.mjs';
import { failureGuidance } from '../lib/guidance.mjs';

const recorded = event => `Copilot implementer failed (exit 1): session.error query: session event delivery failed: session host did not complete the ${event} event within 120s\nError executing prompt: Error: Request session.send failed with message: session event delivery failed`;
const timedOutWithHelp = 'Copilot reviewer-rules failed (exit 1): Error: Failed to fetch models: connect ETIMEDOUT 140.82.112.21:443\nTo authenticate, you can use any of the following methods';
const error = (message, stderr = '') => Object.assign(new Error(message), { result: { stderr } });

test('the stall wording recorded on Windows is a retried stall, not a blocked unit', () => {
  for (const event of ['assistant.reasoning', 'system.message', 'user.message', 'model.call_final_result']) {
    const e = error(recorded(event));
    assert.equal(isHostStall(e), true, event);
    assert.equal(isTransientFailure(e), true, event);
    assert.equal(isSystemicFailure(e), false, event);
    assert.equal(failureGuidance(e, { language: 'ja' }).id, 'cli-host-stall', event);
  }
  for (const message of ['Copilot reviewer-rules failed (exit 1): Error: Request session.send failed with message: session event delivery failed',
    'Copilot implementer failed (exit 1)\nsession host did not acknowledge the session.usage_record event within 120s'])
    assert.equal(isHostStall(error(message)), true, message);
  // The kit's own deadline and a cancellation stay final.
  assert.equal(isTransientFailure(error(`Process timed out after 600000ms (explicit bounded deadline); ${recorded('assistant.reasoning')}`)), false);
});

test('a network error followed by sign-in help is retried, while an explicit rejection still stops the run', () => {
  for (const e of [error(timedOutWithHelp), error('Copilot reviewer-rules failed (exit 1)', `Error: read ECONNRESET\nTo authenticate, you can use any of the following methods\n`),
    error("Copilot implementer failed (exit 1): fetch failed; run the '/login' command")]) {
    assert.equal(isNetworkFailure(e), true, e.message);
    assert.equal(isTransientFailure(e), true, e.message);
    assert.equal(isSystemicFailure(e), false, e.message);
    // The adapter puts the CLI's stderr into the message, which guidance reads.
    assert.equal(failureGuidance(`${e.message}\n${e.result.stderr}`, { language: 'ja' }).id, 'cli-network', e.message);
  }
  for (const message of ['Copilot implementer failed (exit 1): To authenticate, you can use any of the following methods',
    'Copilot implementer failed (exit 1): connect ETIMEDOUT; Bad credentials',
    'Copilot implementer failed (exit 1): 401 Unauthorized after ECONNRESET',
    'Copilot implementer failed (exit 1): session.error authentication: token expired (ETIMEDOUT earlier)']) {
    assert.equal(isSystemicFailure(error(message)), true, message);
    assert.equal(failureGuidance(message, { language: 'en' }).id, 'copilot-auth', message);
  }
  // Other systemic causes are not hidden by a network word next to them.
  assert.equal(isSystemicFailure(error('Copilot implementer failed (exit 1): ETIMEDOUT; No such agent: migration-implementer')), true);
});

test('the network guidance names no sign-in and offers a rerun and a proxy check', () => {
  for (const language of ['ja', 'en']) {
    const g = failureGuidance(timedOutWithHelp, { language });
    assert.deepEqual(g.options.map(o => o.id), ['rerun', 'check-network', 'pause']);
    assert.ok(!g.options.some(o => /login/.test(o.command ?? '')), language);
    assert.match(g.cause, language === 'ja' ? /サインインの失敗ではありません/ : /not a failed sign-in/);
  }
});

async function run(t, failure, failRole) {
  const f = prepare(t, { executionMode: 'continuous' }); f.config.transientRetryDelayMs = 1;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Regression fixture only');
  const unit = f.units[0], flag = safePath(f.root, 'failed-once'), script = safePath(f.root, 'flaky-cli.mjs');
  const responses = Object.fromEntries(['implementer', 'reviewer-semantics', 'reviewer-rules'].map(role => [role, result(role, unit)]));
  atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.105.'); process.exit(0); }
for await (const _ of process.stdin);
const role = process.env.MIGRATION_KIT_ROLE;
if (role === ${JSON.stringify(failRole)} && !fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, '1'); process.stderr.write(${JSON.stringify(`${failure}\n`)}); process.exit(1); }
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(${JSON.stringify(responses)}[role]), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
  const report = await translate(f.root, f.config, createCopilotAdapter({ command: process.execPath, prefixArgs: [script] }));
  const runDir = safePath(f.root, `migration/runs/${report.runId}`);
  const attempts = fs.readdirSync(runDir).filter(n => n !== 'summary.json' && n.endsWith('.json')).map(n => readJSON(path.join(runDir, n)));
  return { report, attempt: attempts.find(a => a.role === failRole) };
}

test('a worker that stalls once with the recorded wording is retried and the unit completes', async t => {
  const { report, attempt } = await run(t, `Error: session event delivery failed: session host did not complete the assistant.reasoning event within 120s`, 'implementer');
  assert.equal(report.done, 1);
  assert.deepEqual(report.errors ?? [], []);
  assert.equal(attempt.retries.length, 1);
  assert.equal(attempt.retries[0].hostStall, true);
});

test('a reviewer whose connection times out once, with sign-in help, is retried instead of stopping the run', async t => {
  const { report, attempt } = await run(t, 'Error: Failed to fetch models: connect ETIMEDOUT 140.82.112.21:443\nTo authenticate, you can use any of the following methods', 'reviewer-rules');
  assert.equal(report.done, 1);
  assert.deepEqual(report.errors ?? [], []);
  assert.equal(attempt.retries.length, 1);
  assert.match(attempt.retries[0].error, /ETIMEDOUT/);
  assert.equal(attempt.retries[0].hostStall, undefined);
});
