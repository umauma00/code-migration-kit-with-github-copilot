// SPDX-License-Identifier: Apache-2.0
// Regressions for the 2026-10-19 review: resumption across operational changes,
// per-run call budgets, runner-side status waits, CLI usage records, preparation
// audits as CLI workers and the smoke/parity repair queue (upstream Step 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, ready, fake, cliDouble, result } from './helpers.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { contextHash, safePath, writeJSON, readJSON, atomicWrite, done, loadConfig, operationalConfigKeys } from '../lib/core.mjs';
import { createCopilotAdapter, copilotArgs, readUsageFile, sessionName, sessionNameLimit } from '../scripts/copilot_adapter.mjs';
import { waitForProgress } from '../scripts/run_migration.mjs';
import { freezeAudit, runAudit } from '../scripts/audit_inputs.mjs';
import { diagnoseBuild, makeRepairQueue } from '../scripts/diagnostic_queue.mjs';
import { decide } from '../scripts/migration_hook.mjs';

const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);

test('run limits, timeouts, documents and Copilot instructions do not revoke reviewed work', async t => {
  const f = await ready(t, { count: 2 });
  await translate(f.root, f.config, fake);
  const context = contextHash(f.root, f.config);
  const changed = { ...f.config, concurrency: 1, maxAgentCalls: 500, maxFixRounds: 3, timeoutSeconds: 900, commandTimeoutSeconds: 900,
    transientRetries: 4, transientRetryDelayMs: 100, maxConsecutiveFailures: 5, maxRunInputBytes: 4096, maxAiCreditsPerCall: 30 };
  assert.deepEqual(Object.keys(changed).filter(k => changed[k] !== f.config[k]).sort(), [...operationalConfigKeys].sort());
  writeJSON(safePath(f.root, 'migration/config.json'), changed);
  fs.appendFileSync(safePath(f.root, '.github/copilot-instructions.md'), '\nTeam note.\n');
  fs.appendFileSync(safePath(f.root, 'migration-kit/docs/OPERATING-MANUAL.md'), '\n');
  fs.appendFileSync(safePath(f.root, 'migration-kit/prompts/04-translation-kickoff.md'), '\n');
  fs.mkdirSync(safePath(f.root, '.github/skills/other'), { recursive: true });
  atomicWrite(safePath(f.root, '.github/skills/other/SKILL.md'), '---\nname: other\ndescription: unrelated\n---\n');
  const config = loadConfig(f.root);
  assert.equal(contextHash(f.root, config), context);
  assert.ok(f.units.every(u => done(f.root, u, context)));
  assert.equal((await translate(f.root, config, fake)).agentCalls, 0);
  // What reaches workers still invalidates: models, worker profiles and runner code.
  writeJSON(safePath(f.root, 'migration/config.json'), { ...changed, models: { ...changed.models, fixer: 'another-model' } });
  assert.notEqual(contextHash(f.root, loadConfig(f.root)), context);
  writeJSON(safePath(f.root, 'migration/config.json'), changed);
  fs.appendFileSync(safePath(f.root, '.github/agents/migration-fixer.agent.md'), '\n');
  assert.notEqual(contextHash(f.root, config), context);
});

test('translate --max-calls sets one run\'s budget without editing the configuration', async t => {
  const f = await ready(t);
  await assert.rejects(translate(f.root, f.config, fake, { maxCalls: 0 }), /--max-calls must be an integer/);
  await assert.rejects(translate(f.root, f.config, fake, { maxCalls: 2 }), /Agent call limit reached/);
  const resumed = await translate(f.root, f.config, fake, { maxCalls: 1000 });
  assert.equal(resumed.done, 1);
});

test('status --wait returns at once when nothing runs and as soon as a running runner changes', async t => {
  const f = prepare(t);
  const started = Date.now();
  assert.equal((await waitForProgress(f.root, 30, { intervalMs: 20 })).running, false);
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(waitForProgress(f.root, 0), /--wait must be/);
  const lock = safePath(f.root, 'migration/run.lock');
  writeJSON(lock, { pid: process.pid, task: 'translation', runId: 'wait-test', startedAt: new Date().toISOString() });
  setTimeout(() => fs.rmSync(lock, { force: true }), 200);
  const report = await waitForProgress(f.root, 30, { intervalMs: 20 });
  assert.equal(report.running, false);
  assert.ok(Date.now() - started < 10000);
});

test('workers report the CLI\'s own token and AI-unit usage and pass the per-call credit cap', async t => {
  const f = await ready(t), transport = cliDouble(f);
  atomicWrite(safePath(f.root, 'usage-cli.mjs'), `import fs from 'node:fs';
const argv = process.argv, at = argv.indexOf('--usage-output-file');
if (!argv.includes('--version') && at > 0) fs.writeFileSync(argv[at + 1], JSON.stringify({ totalNanoAiu: 1200, aiCreditsStatus: 'unavailable', totalPremiumRequestCost: 0,
  modelMetrics: { 'test-double': { usage: { inputTokens: 2400, outputTokens: 30, cacheReadTokens: 2000, cacheWriteTokens: 0 } } } }));
await import(${JSON.stringify(transport.prefixArgs[0])});
`);
  f.config.maxAiCreditsPerCall = 30; persist(f);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'usage-cli.mjs')] });
  const response = await adapter({ ...f, config: f.config, role: 'implementer', unit: f.units[0], extra: {} });
  assert.equal(response.tokens, 2430);
  assert.deepEqual({ ...response.cliUsage }, { inputTokens: 2400, outputTokens: 30, cacheReadTokens: 2000, cacheWriteTokens: 0, nanoAiu: 1200, aiCreditsStatus: 'unavailable', premiumRequestCost: 0 });
  assert.equal(response.aiCredits, null);
  const calls = fs.readFileSync(safePath(f.root, 'cli-double-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const argv = calls.at(-1).argv;
  assert.equal(argv[argv.indexOf('--max-ai-credits') + 1], '30');
  assert.ok(!argv[argv.indexOf('--usage-output-file') + 1].startsWith(f.root), 'usage files stay outside the project');
  assert.equal(readUsageFile(safePath(f.root, 'missing.json')), null);
});

test('preparation audits run as tool-free CLI workers on the planned model and record the reported one', async t => {
  const f = prepare(t);
  f.config.phaseModels = { inventoryAudit: 'audit-model' }; persist(f);
  const frozen = freezeAudit(f.root, f.config, { type: 'inventory', files: ['migration/RULEBOOK.md', 'migration/inventory.tsv'] });
  const seen = [];
  const adapter = async args => {
    seen.push(args);
    const request = JSON.parse(args.reviewInput);
    return { result: { schemaVersion: 1, kind: 'preparation-audit', task: request.task, inputHash: request.inputHash, target: args.unit.target, verdict: 'pass', findings: [] },
      observedModel: 'audit-model', cliVersion: '1.0.98', cliSessionId: args.sessionId };
  };
  const record = await runAudit(f.root, f.config, adapter, { directory: frozen.directory });
  assert.equal(seen[0].role, 'preparation-auditor'); assert.equal(seen[0].model, 'audit-model');
  assert.equal(record.observedModel, 'audit-model'); assert.equal(record.execution.worker, 'copilot-cli');
  assert.equal(readJSON(safePath(f.root, `${frozen.directory}/result.json`)).result.verdict, 'pass');
  await assert.rejects(runAudit(f.root, f.config, adapter, { directory: frozen.directory }), /already submitted/);
  assert.ok(copilotArgs('preparation-auditor', 'm').join(' ').includes('--deny-tool read,write,shell'));
  assert.match(decide({ toolName: 'view', toolArgs: { path: 'src/a.py' } }, 'preparation-auditor'), /no tools/);
});

test('a failed parity run becomes a reviewed repair queue; an original-suite failure never does', async t => {
  const f = prepare(t);
  const failing = [process.execPath, '-e', "console.error('ReferenceError: parity divergence\\n    at f (' + require('path').join(process.cwd(), 'ported/math_ops.mjs') + ':1:1)'); process.exit(1)"];
  f.config.commands.parity = failing; persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Fixture only');
  await translate(f.root, f.config, fake);
  for (const stage of ['build', 'smoke']) { approve(f.root, f.config, stage, 'Fixture only'); await runStage(f.root, f.config, stage); }
  approve(f.root, f.config, 'parity', 'Fixture only');
  await assert.rejects(runStage(f.root, f.config, 'parity'), /parity failed/);
  // The original suite failing is inherited or environmental, not a translation defect.
  const file = safePath(f.root, 'migration/results/parity.json'), recorded = fs.readFileSync(file, 'utf8'), record = JSON.parse(recorded);
  record.commands[0].status = 'failed'; writeJSON(file, record);
  assert.throws(() => diagnoseBuild(f.root, f.config, { stage: 'parity' }), /original suite failed/);
  // A hand-written TSV is refused the same way.
  atomicWrite(safePath(f.root, 'migration/manual-parity.tsv'), 'file\tmodule\tcode\tmessage\nported/math_ops.mjs\tmath\tP1\tcase 3 differs\n');
  assert.throws(() => makeRepairQueue(f.root, f.config, { stage: 'parity', diagnostics: 'migration/manual-parity.tsv', out: 'migration/manual-queue.json' }), /original suite failed/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/manual-queue.json')), false);
  fs.writeFileSync(file, recorded);
  // A queue made while the original passed is re-checked when it is read.
  makeRepairQueue(f.root, f.config, { stage: 'parity', diagnostics: 'migration/manual-parity.tsv', out: 'migration/manual-queue.json' });
  writeJSON(file, record);
  let workers = 0;
  await assert.rejects(translate(f.root, f.config, async args => { workers++; return fake(args); }, { repairQueue: 'migration/manual-queue.json' }), /original suite failed/);
  assert.equal(workers, 0);
  fs.writeFileSync(file, recorded);
  const diagnosis = diagnoseBuild(f.root, f.config, { stage: 'parity' });
  assert.equal(diagnosis.stage, 'parity'); assert.deepEqual(diagnosis.targets, ['ported/math_ops.mjs']);
  assert.equal(diagnosis.rounds, 'migration/parity-rounds.tsv');
  assert.equal(readJSON(safePath(f.root, diagnosis.queue)).stage, 'parity');
  const repaired = await translate(f.root, f.config, async args => args.role === 'arbiter'
    ? { result: result('arbiter', args.unit, { decisions: args.extra.findings.map(x => ({ finding: x.reference, confirmed: true, reason: x.evidence })) }) } : fake(args), { repairQueue: diagnosis.queue });
  assert.deepEqual(repaired.scopeTargets, ['ported/math_ops.mjs']); assert.equal(repaired.scopeComplete, true);
  // Changed outputs need fresh approved build, smoke and parity runs.
  assert.throws(() => diagnoseBuild(f.root, f.config, { stage: 'parity' }), /No current parity attempt/);
});

test('worker session names stay within the CLI limit and keep the role, file name and ID', () => {
  const id = '0123abcd-0000-4000-8000-000000000000';
  const deep = `ported/${'very-long-package-name/'.repeat(8)}module_with_a_long_name.mjs`;
  for (const [worker, target] of [['implementer', 'ported/a.mjs'], ['reviewer-semantics-read', deep], ['preparation-auditor', `migration/audits/${id}/request.json`]]) {
    const name = sessionName(worker, target, id);
    assert.ok(name.length <= sessionNameLimit, name);
    assert.ok(name.startsWith(`migration-kit ${worker} `)); assert.ok(name.endsWith(' 0123abcd'));
  }
  assert.match(sessionName('implementer', deep, id), /module_with_a_long_name\.mjs 0123abcd$/);
  assert.equal(sessionName('implementer', 'ported/a.mjs', id), 'migration-kit implementer ported/a.mjs 0123abcd');
});

test('maxAiCreditsPerCall follows the CLI minimum of 30', t => {
  const f = prepare(t), file = safePath(f.root, 'migration/config.json');
  for (const value of [29, 0, -1, '30', Infinity]) {
    writeJSON(file, { ...f.config, maxAiCreditsPerCall: value });
    assert.throws(() => loadConfig(f.root), /at least 30/, String(value));
  }
  for (const value of [30, 30.5, 500]) {
    writeJSON(file, { ...f.config, maxAiCreditsPerCall: value });
    assert.equal(loadConfig(f.root).maxAiCreditsPerCall, value);
  }
});

test('a semantic configuration change during a preparation audit voids its result; a run limit does not', async t => {
  const f = prepare(t), file = safePath(f.root, 'migration/config.json');
  f.config.phaseModels = { inventoryAudit: 'model-a' }; persist(f);
  const answer = args => { const q = JSON.parse(args.reviewInput);
    return { result: { schemaVersion: 1, kind: 'preparation-audit', task: q.task, inputHash: q.inputHash, target: args.unit.target, verdict: 'pass', findings: [] }, observedModel: 'model-a' }; };
  const first = freezeAudit(f.root, f.config, { type: 'inventory', files: ['migration/RULEBOOK.md'] });
  await assert.rejects(runAudit(f.root, f.config, async args => {
    writeJSON(file, { ...f.config, phaseModels: { inventoryAudit: 'model-b' } }); return answer(args);
  }, { directory: first.directory }), /inputs changed/);
  assert.equal(fs.existsSync(safePath(f.root, `${first.directory}/result.json`)), false);
  persist(f);
  const second = freezeAudit(f.root, f.config, { type: 'inventory', files: ['migration/RULEBOOK.md'] });
  const record = await runAudit(f.root, f.config, async args => { writeJSON(file, { ...f.config, concurrency: 1 }); return answer(args); }, { directory: second.directory });
  assert.equal(record.result.verdict, 'pass');
});

test('a retried call counts the failed attempt\'s usage, or leaves the run total unknown', async t => {
  const transient = usage => Object.assign(new Error('Copilot implementer failed (exit 1): session.error rate_limit 429: slow down'), usage ? { tokens: 7, cliUsage: { inputTokens: 5, outputTokens: 2 } } : {});
  const measured = args => ({ ...fakeUsage(args), tokens: 10, cliUsage: { inputTokens: 8, outputTokens: 2 } });
  const fakeUsage = args => ({ result: result(args.role, args.unit), observedModel: 'test-double' });
  for (const [withUsage, expected] of [[false, 'unknown'], [true, String(3 * 10 + 7)]]) {
    const f = await ready(t);
    f.config.transientRetryDelayMs = 0; persist(f);
    let failed = false;
    const report = await translate(f.root, f.config, async args => {
      if (!failed) { failed = true; throw transient(withUsage); }
      return measured(args);
    });
    assert.equal(report.agentCalls, 4);
    assert.equal(report.measuredUsage.complete, withUsage);
    assert.equal(report.measuredUsage.calls, withUsage ? 4 : 3);
    const row = fs.readFileSync(safePath(f.root, 'migration/cost-log.tsv'), 'utf8').trimEnd().split('\n').at(-1).split('\t');
    assert.equal(row[3], expected);
  }
});
