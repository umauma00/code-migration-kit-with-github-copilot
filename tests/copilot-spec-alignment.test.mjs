// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ready, prepare, fake } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, writeJSON, readJSON, loadConfig } from '../lib/core.mjs';
import { translate } from '../lib/pipeline.mjs';
import { reviewInput } from '../lib/review.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';
import { agentMetadata } from '../lib/runtime.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { failureGuidance } from '../lib/guidance.mjs';

test('worker profiles stay out of the picker; only the parent-dispatched auditor remains model-invocable', () => {
  for (const dir of ['.github/agents', 'com.github.copilot/agents']) for (const name of fs.readdirSync(path.join(kitRoot, dir))) {
    const front = agentMetadata(fs.readFileSync(path.join(kitRoot, dir, name), 'utf8'), name);
    if (name.includes('orchestrator')) { assert.equal(front['user-invocable'], undefined, name); continue; }
    assert.equal(front['user-invocable'], false, name);
    assert.ok(!name.includes('-native-'), `removed native profile still shipped: ${name}`);
    const dispatched = name.includes('preparation-auditor');
    assert.equal(front['disable-model-invocation'], dispatched ? undefined : true, name);
  }
});

test('hook configurations allow 30 seconds because Copilot hooks fail open on timeout', () => {
  for (const file of ['templates/hooks.copilot.json', '.github/hooks/code-migration.json', 'com.github.copilot/hooks/hooks.json']) {
    assert.equal(readJSON(path.join(kitRoot, file)).hooks.preToolUse[0].timeoutSec, 30, file);
  }
  assert.equal(readJSON(path.join(kitRoot, 'templates/hooks.vscode-local.json')).hooks.PreToolUse[0].timeout, 30);
});

test('doctor times the hook', async t => {
  const f = prepare(t);
  const report = await doctor(f.root, f.config);
  const hook = report.checks.find(c => c.check === 'hook responds before its timeout');
  assert.equal(hook.ok, true);
  assert.equal(hook.timeoutSec, 30);
  assert.ok(Number.isInteger(hook.durationMs));
  assert.equal(report.workerBackend, 'copilot-cli');
  assert.equal(report.checks.some(c => /native/.test(c.check)), false);
});

test('prompts put shared rules first and the unit-specific target last for prompt caching', t => {
  const f = prepare(t, { count: 2 });
  for (const u of f.units) { fs.mkdirSync(path.dirname(safePath(f.root, u.target)), { recursive: true }); fs.writeFileSync(safePath(f.root, u.target), '// candidate\n// PORT STATUS: todos=0\n'); }
  const inputs = f.units.map(u => JSON.parse(reviewInput(f.root, f.config, u).text));
  for (const input of inputs) {
    assert.equal(Object.keys(input)[1], 'files');
    assert.equal(input.files[0].path, 'migration/RULEBOOK.md');
  }
  const prompts = f.units.map(u => agentPrompt({ role: 'reviewer-rules', unit: u, reviewInput: reviewInput(f.root, f.config, u).text }));
  for (const [i, prompt] of prompts.entries()) assert.ok(prompt.trimEnd().endsWith(`Set target to ${JSON.stringify(f.units[i].target)}.`));
  // Two units of one role share everything up to and including the full rulebook.
  let common = 0;
  while (prompts[0][common] === prompts[1][common]) common++;
  const rulebook = JSON.stringify(fs.readFileSync(safePath(f.root, 'migration/RULEBOOK.md'), 'utf8'));
  assert.ok(prompts[0].slice(0, common).includes(rulebook.slice(1, -1)), 'shared prefix covers the rulebook');
});

test('a run stops cleanly at maxRunInputBytes and reports measured bytes with estimated tokens', async t => {
  const f = await ready(t, { count: 3 });
  Object.assign(f.config, { maxRunInputBytes: 1024, concurrency: 1 });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const { approve, runStage } = await import('../lib/pipeline.mjs');
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Budget fixture');
  const sized = async options => ({ ...(await fake(options)), promptBytes: 2048, responseBytes: 400 });
  await assert.rejects(translate(f.root, f.config, sized), /Run input budget \(maxRunInputBytes\) reached/);
  const runs = fs.readdirSync(safePath(f.root, 'migration/runs'));
  const summary = readJSON(safePath(f.root, `migration/runs/${runs.sort().at(-1)}/summary.json`));
  assert.equal(summary.usageEstimate.promptBytes, 2048);
  assert.equal(summary.usageEstimate.estimatedInputTokens, 512);
  assert.match(summary.usageEstimate.basis, /not measured/);
  assert.equal(failureGuidance('Translation stopped: ported/a.mjs: Run input budget (maxRunInputBytes) reached; resume', { language: 'ja' }).id, 'input-budget');
  assert.equal(failureGuidance('Copilot implementer failed (exit 1): Your AI Credits budget has been exhausted', { language: 'en' }).id, 'credits');
  assert.throws(() => { writeJSON(safePath(f.root, 'migration/config.json'), { ...f.config, maxRunInputBytes: 10 }); loadConfig(f.root); }, /maxRunInputBytes/);
});
