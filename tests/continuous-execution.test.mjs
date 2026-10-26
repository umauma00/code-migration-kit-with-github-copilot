// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from '../scripts/install.mjs';
import { loadConfig, safePath, writeJSON, readJSON } from '../lib/core.mjs';
import { executionLimits, processTimeout } from '../lib/execution-policy.mjs';
import { runProcess, processOutputLines } from '../lib/process.mjs';
import { translate, runStage, approve } from '../lib/pipeline.mjs';
import { buildLoop } from '../lib/build-loop.mjs';
import { createCopilotAdapter, requiredCopilotFlags } from '../scripts/copilot_adapter.mjs';
import { ready, prepare, fake, finding, result, cliDouble, cliOutput } from './helpers.mjs';
import { diagnosticsForUnits } from '../lib/diagnostics.mjs';

test('new and legacy configurations default to continuous execution; old 600s/call/round caps cannot interrupt them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-continuous-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double' });
  const installed = loadConfig(root);
  assert.equal(installed.executionMode, 'continuous');
  assert.equal(installed.timeoutSeconds, 0); assert.equal(installed.commandTimeoutSeconds, 0);
  const legacy = { ...installed, timeoutSeconds: 600, commandTimeoutSeconds: 600, maxAgentCalls: 1, maxFixRounds: 0,
    maxRunInputBytes: 1024, transientRetries: 0, maxConsecutiveFailures: 1, maxAiCreditsPerCall: 30 };
  delete legacy.executionMode;
  writeJSON(safePath(root, 'migration/config.json'), legacy);
  const config = loadConfig(root), limits = executionLimits(config);
  for (const key of ['calls', 'fixRounds', 'inputBytes', 'retries', 'consecutiveFailures']) assert.equal(limits[key], Infinity);
  assert.equal(limits.aiCredits, undefined);
  assert.equal(processTimeout(config, 'timeoutSeconds'), 0); assert.equal(processTimeout(config, 'commandTimeoutSeconds'), 0);
  assert.ok(!requiredCopilotFlags(undefined, config).includes('--max-ai-credits'));
  config.executionMode = 'bounded';
  assert.equal(executionLimits(config).calls, 1); assert.equal(processTimeout(config, 'timeoutSeconds'), 600000);
  assert.ok(requiredCopilotFlags(undefined, config).includes('--max-ai-credits'));
});

test('continuous translation completes beyond saved call and input budgets and retries real transient failures', async t => {
  const f = await ready(t);
  Object.assign(f.config, { executionMode: 'continuous', maxAgentCalls: 1, maxRunInputBytes: 1024, transientRetries: 0, transientRetryDelayMs: 0 });
  let failures = 0;
  const report = await translate(f.root, f.config, async args => {
    if (args.role === 'implementer' && failures++ < 4) throw new Error('session.error rate_limit 429: temporarily unavailable');
    return { ...await fake(args), promptBytes: 10000 };
  });
  assert.equal(report.done, 1); assert.ok(report.agentCalls >= 7); assert.ok(report.usageEstimate.promptBytes > 1024);
});

test('systemic failures carrying a transient status are returned without endless retries in continuous mode', async t => {
  const f = await ready(t);
  Object.assign(f.config, { executionMode: 'continuous', transientRetryDelayMs: 0 });
  let calls = 0;
  await assert.rejects(translate(f.root, f.config, async () => {
    calls++;
    if (calls > 2) throw new Error('Unexpected retry of systemic quota failure');
    throw new Error('session.error quota_exceeded 429: quota exhausted');
  }), /quota_exceeded/);
  assert.equal(calls, 1);
});

test('continuous repairs are not stopped at saved maxFixRounds', async t => {
  const f = await ready(t); f.config.executionMode = 'continuous'; f.config.maxFixRounds = 0;
  let fixes = 0;
  await translate(f.root, f.config, async args => {
    if (args.role === 'fixer') fixes++;
    if (args.role.startsWith('reviewer-') && fixes < 3) return { result: result(args.role, args.unit, { findings: [finding] }) };
    return fake(args);
  });
  assert.equal(fixes, 3);
});

test('several genuine failures do not prevent independent units from finishing in continuous mode', async t => {
  const f = prepare(t, { count: 3 });
  Object.assign(f.config, { executionMode: 'continuous', maxConsecutiveFailures: 1, concurrency: 1, dependencyOrder: 'none' });
  f.config.commands.typecheck = null;
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Independent-unit fixture');
  const attempted = [];
  const error = await translate(f.root, f.config, async args => {
    attempted.push(args.unit.target);
    if (!args.unit.target.endsWith('main.mjs')) throw new Error('Invalid JSON from this unit');
    return fake(args);
  }).catch(e => e);
  assert.ok(attempted.includes('ported/main.mjs'));
  assert.equal(error.report.done, 1);
  assert.ok(!error.message.includes('maxConsecutiveFailures'));
});

test('continuous build-loop passes old round, stalled-count and shared-call defaults until clean', async t => {
  const f = prepare(t);
  Object.assign(f.config, { executionMode: 'continuous', maxAgentCalls: 1, maxFixRounds: 0 });
  f.config.commands.build = [process.execPath, '-e', `
const fs = require('node:fs'), file = 'migration/build-count.txt';
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(file, String(n));
if (n < 7) { console.error('ported/math_ops.mjs:1:1: error: still broken'); process.exit(1); }
`];
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture until clean');
  await translate(f.root, f.config, fake);
  const report = await buildLoop(f.root, f.config, fake, { note: 'Fixture authorizes repairs until clean' });
  assert.equal(report.stopped, 'clean'); assert.equal(report.rounds.length, 7); assert.ok(report.agentCalls > 1);
  assert.equal(report.maxRounds, null); assert.equal(report.maxCalls, null);
});

test('an explicitly supplied per-command call budget still applies in continuous mode', async t => {
  const f = await ready(t); f.config.executionMode = 'continuous';
  let calls = 0;
  await assert.rejects(translate(f.root, f.config, async args => { calls++; return fake(args); }, { maxCalls: 1 }), e => e.budgetStop === true);
  assert.equal(calls, 1);
});

test('CPU-busy, silent commands and CLI workers finish after the legacy configured deadline', async t => {
  const f = prepare(t);
  Object.assign(f.config, { executionMode: 'continuous', timeoutSeconds: 1, commandTimeoutSeconds: 1 });
  const busy = 'const until = Date.now() + 1300; while (Date.now() < until) {}';
  f.config.commands.original = [process.execPath, '-e', busy];
  f.config.commands.mutation = [process.execPath, '-e', ''];
  const stage = await runStage(f.root, f.config, 'judge');
  assert.equal(stage.success, true);
  assert.ok(Date.parse(stage.commands[0].finishedAt) - Date.parse(stage.commands[0].startedAt) >= 1300);
  const cli = cliDouble(f), script = cli.prefixArgs[0];
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace("let prompt = '';", `${busy}\nlet prompt = '';`));
  const response = await createCopilotAdapter(cli)({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0] });
  assert.equal(response.result.kind, 'implementation');
});

test('bounded adapter version probes honor the explicit command deadline while continuous probes stay unbounded', async t => {
  const f = prepare(t);
  Object.assign(f.config, { executionMode: 'bounded', commandTimeoutSeconds: 1, timeoutSeconds: 0 });
  const cli = cliDouble(f), script = cli.prefixArgs[0];
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace("if (process.argv.includes('--version')) {", "if (process.argv.includes('--version')) { const until=Date.now()+1300;while(Date.now()<until){}"));
  const adapter = createCopilotAdapter(cli);
  const bounded = await adapter({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0] });
  assert.equal(bounded.result.kind, 'implementation'); assert.match(bounded.cliVersionWarning, /explicit bounded deadline/);
  f.config.executionMode = 'continuous';
  const continuous = await adapter({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0] });
  assert.equal(continuous.cliVersion, '0.0.0-test'); assert.equal(continuous.cliVersionWarning, undefined);
});

test('output larger than 16 MiB is preserved, the child finishes, and middle diagnostics are still parsed', async t => {
  const f = prepare(t), outputDir = safePath(f.root, 'migration/runs/process-output');
  const r = await runProcess(process.execPath, ['-e', `
const line = 'normal log ' + 'x'.repeat(1000) + '\\n';
for (let i = 0; i < 18000; i++) { if (i === 9000) process.stdout.write('ported/math_ops.mjs:3: error: middle diagnostic\\n'); process.stdout.write(line); }
process.stderr.write('finished successfully\\n');
`], { outputDir });
  assert.equal(r.code, 0); assert.equal(r.outputSpooled, true); assert.ok(r.stdoutBytes > 16 * 1024 * 1024);
  assert.equal(fs.statSync(r.stdoutFile).size, r.stdoutBytes);
  assert.match(fs.readFileSync(r.stderrFile, 'utf8'), /finished successfully/);
  const diagnostics = diagnosticsForUnits(f.root, f.units, processOutputLines(r, 'stdout', f.root));
  assert.equal(diagnostics.rows.length, 1); assert.match(diagnostics.rows[0].message, /middle diagnostic/);
  fs.appendFileSync(r.stdoutFile, 'altered log\n');
  assert.throws(() => [...processOutputLines(r, 'stdout', f.root)], /log changed/);
  assert.throws(() => [...processOutputLines({ ...r, stdoutFile: safePath(f.root, 'migration/config.json') }, 'stdout', f.root)], /outside runner log directory/);
});

test('a large Copilot JSONL stream is parsed from its full spool and retains terminal result and model facts', async t => {
  const f = prepare(t); f.config.executionMode = 'continuous';
  const file = safePath(f.root, 'verbose-cli.mjs');
  fs.writeFileSync(file, `
if (process.argv.includes('--version')) { console.log('1.0.103'); process.exit(0); }
for await (const chunk of process.stdin) {}
const line = JSON.stringify({type:'progress', data:'x'.repeat(1000)}) + '\\n';
for (let i=0;i<18000;i++) process.stdout.write(line);
console.log(JSON.stringify({type:'model.call_final_result',data:{result:'success',model:'test-double'}}));
process.stdout.write(${JSON.stringify(cliOutput(result('implementer', f.units[0])) + '\n')});
`);
  const response = await createCopilotAdapter({ command: process.execPath, prefixArgs: [file] })({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0] });
  assert.equal(response.result.kind, 'implementation'); assert.equal(response.observedModel, 'test-double');
  assert.ok(response.processOutput.stdoutBytes > 16 * 1024 * 1024);
  assert.equal(fs.statSync(response.processOutput.stdoutFile).size, response.processOutput.stdoutBytes);
});

test('manual cancellation still terminates an unbounded child and preserves its output', async t => {
  const f = prepare(t), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("started"); setInterval(()=>{},1000)'], { signal: controller.signal, outputDir: safePath(f.root, 'migration/runs/process-output') }), e => /Interrupted/.test(e.message) && e.result.code === null);
  } finally { clearTimeout(timer); }
});
