// SPDX-License-Identifier: Apache-2.0
// Kit-wide AI usage: every Copilot CLI worker call (translation, survey,
// preparation audit) lands in one ledger, survey runs total it like
// translation runs, and `usage` reports the whole kit without a gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare, ready, cliDouble, importable } from './helpers.mjs';
import { safePath, writeJSON, atomicWrite, readJSON } from '../lib/core.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { recordCallUsage, usageReport, usageMarkdown, runUsage, usageLog } from '../lib/usage.mjs';
import { runSurvey } from '../lib/survey.mjs';
import { parseCommandLine, specs } from '../lib/cli.mjs';
import { humanGate } from '../lib/guardrails.mjs';

const runner = fileURLToPath(new URL('../scripts/run_migration.mjs', import.meta.url));
const lines = root => fs.existsSync(safePath(root, usageLog)) ? fs.readFileSync(safePath(root, usageLog), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const usageJSON = JSON.stringify({ totalNanoAiu: 1500000000, aiCreditsStatus: 'applied',
  modelMetrics: { 'test-double': { usage: { inputTokens: 2400, outputTokens: 30, cacheReadTokens: 2000, cacheWriteTokens: 5 } } } });
// mode: 'ok' writes usage and answers; 'fail' writes usage and exits 1; 'none' answers without usage.
const wrapper = (f, transport) => atomicWrite(safePath(f.root, 'usage-cli.mjs'), `import fs from 'node:fs';
const argv = process.argv, at = argv.indexOf('--usage-output-file');
const mode = fs.existsSync(${JSON.stringify(safePath(f.root, 'mode.txt'))}) ? fs.readFileSync(${JSON.stringify(safePath(f.root, 'mode.txt'))}, 'utf8') : 'ok';
if (!argv.includes('--version') && at > 0 && mode !== 'none') fs.writeFileSync(argv[at + 1], ${JSON.stringify(usageJSON)});
if (!argv.includes('--version') && mode.startsWith('fallback')) console.log(JSON.stringify({ type: 'model.call_final_result', data: { result: 'success', model: 'fallback-model' } }));
if (!argv.includes('--version') && mode === 'fallback-hang') { fs.writeFileSync(${JSON.stringify(safePath(f.root, 'hanging.txt'))}, 'reported'); setInterval(() => {}, 1000); }
else if (!argv.includes('--version') && (mode === 'fail' || mode === 'fallback-fail')) { process.stderr.write('boom'); process.exit(1); }
await import(${JSON.stringify(importable(transport.prefixArgs[0]))});
`);

test('every started worker call is logged once, measured or not, success or failure', async t => {
  const f = await ready(t), transport = cliDouble(f);
  wrapper(f, transport);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'usage-cli.mjs')] });
  const call = runId => adapter({ ...f, config: f.config, role: 'implementer', unit: f.units[0], extra: {}, runId });
  await call('1-aaaaaaaa');
  atomicWrite(safePath(f.root, 'mode.txt'), 'fail');
  await assert.rejects(call('1-aaaaaaaa'), /failed \(exit 1\)/);
  atomicWrite(safePath(f.root, 'mode.txt'), 'none');
  await call('2-bbbbbbbb');
  const log = lines(f.root);
  assert.equal(log.length, 3);
  assert.deepEqual(log.map(e => [e.runId, e.role, e.ok, e.usage?.inputTokens ?? null]), [['1-aaaaaaaa', 'implementer', true, 2400], ['1-aaaaaaaa', 'implementer', false, 2400], ['2-bbbbbbbb', 'implementer', true, null]]);
  assert.equal(log[0].target, f.units[0].target);
  assert.match(log[0].sessionId, /^[0-9a-f-]{36}$/);
  const report = usageReport(f.root);
  assert.equal(report.total.calls, 3);
  assert.equal(report.total.failedCalls, 1);
  assert.equal(report.total.unmeasuredCalls, 1);
  assert.equal(report.total.complete, false);
  assert.equal(report.total.inputTokens, 4800);
  assert.equal(report.total.cacheWriteTokens, 10);
  assert.equal(report.total.aiu, 3);
  assert.deepEqual(report.aiCreditsStatus, ['applied']);
  assert.equal(runUsage(f.root, '1-aaaaaaaa').complete, true);
  assert.equal(runUsage(f.root, 'missing-run'), null);
  // The ledger is runner state: tool-assisted reviewers are denied migration/runs.
  assert.ok(usageLog.startsWith('migration/runs/'));
});

test('usage report groups by role and model, and says what it leaves out', t => {
  const f = prepare(t);
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, nanoAiu: 250000000 };
  recordCallUsage(f.root, { runId: 'r1', role: 'implementer', model: 'm-a', ok: true, usage });
  recordCallUsage(f.root, { runId: 'r1', role: 'reviewer-rules', model: 'm-b', ok: true, usage });
  recordCallUsage(f.root, { runId: 'audit-x', role: 'preparation-auditor', model: 'm-b', ok: true, usage });
  fs.appendFileSync(safePath(f.root, usageLog), 'not json\n');
  const report = usageReport(f.root);
  assert.deepEqual(Object.keys(report.byRole), ['implementer', 'preparation-auditor', 'reviewer-rules']);
  assert.equal(report.byModel['m-b'].calls, 2);
  assert.equal(report.total.aiu, 0.75);
  assert.equal(report.total.complete, true);
  assert.equal(report.unreadableLines, 1);
  assert.ok(report.notIncluded.some(s => /orchestrator/.test(s)));
  assert.equal(usageReport(f.root, { runId: 'r1' }).total.calls, 2);
  const ja = usageMarkdown(report, 'ja');
  assert.match(ja, /\| 合計 \| 3 \| 300 \| 30 \| 150 \| 0\.750 \|/);
  assert.match(ja, /\/usage/);
  assert.match(usageMarkdown(report, 'en'), /does not report the AI Credits amount/);
  assert.match(usageMarkdown(usageReport(prepare(t).root), 'en'), /No worker call usage recorded yet/);
});

test('usage command is read-only, needs no gate and rejects unknown options', t => {
  const f = prepare(t);
  recordCallUsage(f.root, { runId: 'r1', role: 'surveyor', model: 'm', ok: true, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 0 } });
  const before = fs.readFileSync(safePath(f.root, usageLog), 'utf8');
  const out = spawnSync(process.execPath, [runner, 'usage', '--root', f.root], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).total.outputTokens, 2);
  const md = spawnSync(process.execPath, [runner, 'usage', '--format', 'markdown', '--run', 'r1', '--root', f.root], { encoding: 'utf8' });
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /run r1|（run r1）/);
  assert.equal(fs.readFileSync(safePath(f.root, usageLog), 'utf8'), before);
  assert.throws(() => parseCommandLine(['usage', '--bogus'], specs.run_migration), /--bogus/);
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs usage --format markdown'), null);
});

test('survey runs total their surveyor calls from the ledger and fill cost-log tokens', async t => {
  const f = prepare(t, { count: 2 });
  Object.assign(f.config, { transientRetryDelayMs: 1, phaseModels: { survey: 'survey-model' } });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const answer = ({ unit, reviewInput }) => {
    const input = JSON.parse(reviewInput);
    return { result: { schemaVersion: 1, kind: 'survey', survey: 'facts', target: unit.target,
      items: input.files.map(x => ({ file: x.path, category: 'entry-point', summary: `${x.path} defines functions`, evidence: `${x.path}:1 def` })) } };
  };
  const usage = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 1000 };
  // A double that logs like the real adapter does.
  const measured = async args => { recordCallUsage(args.root, { runId: args.runId, role: 'surveyor', model: 'survey-model', ok: true, usage }); return answer(args); };
  const report = await runSurvey(f.root, f.config, 'facts', measured, { maxFiles: 1 });
  assert.ok(report.agentCalls > 0);
  assert.equal(report.measuredUsage.calls, report.agentCalls);
  assert.equal(report.measuredUsage.complete, true);
  assert.equal(report.measuredUsage.inputTokens, 40 * report.agentCalls);
  assert.deepEqual(readJSON(safePath(f.root, `migration/surveys/facts/runs/${report.runId}.json`)).measuredUsage.calls, report.agentCalls);
  const row = fs.readFileSync(safePath(f.root, 'migration/cost-log.tsv'), 'utf8').trimEnd().split('\n').at(-1).split('\t');
  assert.equal(row[3], String(44 * report.agentCalls));
  // A call without a record (a double that logs nothing) keeps the total unknown.
  fs.appendFileSync(safePath(f.root, 'src/main.py'), '# changed\n');
  const unmeasured = await runSurvey(f.root, f.config, 'facts', async args => answer(args), { maxFiles: 1 });
  assert.equal(unmeasured.measuredUsage, undefined);
  assert.equal(fs.readFileSync(safePath(f.root, 'migration/cost-log.tsv'), 'utf8').trimEnd().split('\n').at(-1).split('\t')[3], 'unknown');
});

test('an empty or partly measured report is never complete, and fallback models are counted as reported', t => {
  const f = prepare(t);
  const none = usageReport(f.root, { runId: 'typo' });
  assert.equal(none.total.calls, 0);
  assert.equal(none.total.complete, false);
  assert.match(usageMarkdown(none, 'en'), /No usage record for run typo/);
  assert.match(usageMarkdown(none, 'ja'), /run typo の使用量記録はありません/);
  recordCallUsage(f.root, { runId: 'r', role: 'implementer', model: 'asked', observedModel: 'fallback', ok: true, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  recordCallUsage(f.root, { runId: 'r', role: 'implementer', model: 'asked', observedModel: 'asked', ok: true, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 5 } });
  const report = usageReport(f.root);
  assert.deepEqual(Object.keys(report.byModel), ['asked', 'fallback']);
  assert.equal(report.total.complete, true, 'every call has tokens');
  assert.equal(report.total.aiuComplete, false, 'one call reported no AI units');
  assert.equal(report.total.callsWithoutAiu, 1);
  const md = usageMarkdown(report, 'en');
  assert.match(md, /\(lower bound\)/);
  assert.match(md, /1 calls reported no AI units/);
  assert.match(md, /Not included:[\s\S]*\/usage[\s\S]*0\.22\.0[\s\S]*benchmark/);
});

test('a call that fails before the CLI starts is not logged', async t => {
  const f = await ready(t), transport = cliDouble(f);
  wrapper(f, transport);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'usage-cli.mjs')] });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter({ ...f, config: f.config, role: 'implementer', unit: f.units[0], extra: {}, signal: controller.signal, runId: '3-cccccccc' }));
  assert.equal(lines(f.root).length, 0);
  // A missing command: the version check only warns, then spawn fails and nothing ran.
  const missing = createCopilotAdapter({ command: safePath(f.root, 'no-such-copilot') });
  await assert.rejects(missing({ ...f, config: f.config, role: 'implementer', unit: f.units[0], extra: {}, runId: '4-dddddddd' }), /ENOENT|not found|no-such-copilot/);
  assert.equal(lines(f.root).length, 0);
});

test('a survey with one unmeasured surveyor call keeps its tokens unknown', async t => {
  const f = prepare(t, { count: 2 });
  Object.assign(f.config, { transientRetryDelayMs: 1, phaseModels: { survey: 'survey-model' } });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  let n = 0;
  const report = await runSurvey(f.root, f.config, 'facts', async args => {
    recordCallUsage(args.root, { runId: args.runId, role: 'surveyor', model: 'survey-model', ok: true, usage: n++ ? null : { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 1 } });
    const input = JSON.parse(args.reviewInput);
    return { result: { schemaVersion: 1, kind: 'survey', survey: 'facts', target: args.unit.target,
      items: input.files.map(x => ({ file: x.path, category: 'entry-point', summary: `${x.path} defines functions`, evidence: `${x.path}:1 def` })) } };
  }, { maxFiles: 1 });
  assert.ok(report.agentCalls > 1);
  assert.equal(report.measuredUsage.complete, false);
  assert.equal(report.measuredUsage.unmeasuredCalls, report.agentCalls - 1);
  assert.equal(fs.readFileSync(safePath(f.root, 'migration/cost-log.tsv'), 'utf8').trimEnd().split('\n').at(-1).split('\t')[3], 'unknown');
});

test('the usage log counts a call under the model the CLI reported, on success, failure and interruption', async t => {
  const f = await ready(t), transport = cliDouble(f);
  wrapper(f, transport);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'usage-cli.mjs')] });
  const call = () => adapter({ ...f, config: f.config, role: 'implementer', unit: f.units[0], extra: {}, runId: '5-eeeeeeee' });
  atomicWrite(safePath(f.root, 'mode.txt'), 'fallback');
  const response = await call();
  assert.match(response.modelWarning, /fallback-model/);
  atomicWrite(safePath(f.root, 'mode.txt'), 'fallback-fail');
  await assert.rejects(call(), /failed \(exit 1\)/);
  // Interrupted while running: the CLI started, so the call is logged under its reported model.
  atomicWrite(safePath(f.root, 'mode.txt'), 'fallback-hang');
  const controller = new AbortController();
  const hanging = adapter({ ...f, config: f.config, role: 'implementer', unit: f.units[0], extra: {}, runId: '5-eeeeeeee', signal: controller.signal });
  // Abort only once the CLI has reported its model and is hanging.
  for (const until = Date.now() + 20000; !fs.existsSync(safePath(f.root, 'hanging.txt')) && Date.now() < until;) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 200));
  controller.abort();
  await assert.rejects(hanging, /Interrupted/);
  assert.deepEqual(lines(f.root).map(e => [e.ok, e.observedModel]), [[true, 'fallback-model'], [false, 'fallback-model'], [false, 'fallback-model']]);
  assert.deepEqual(Object.keys(usageReport(f.root).byModel), ['fallback-model']);
});
