// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { prepare, nodeCli } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, readJSON, roles } from '../lib/core.mjs';
import { runSurvey, surveyStatus } from '../lib/survey.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { createCopilotAdapter, requiredCopilotFlags, probeAgentName } from '../scripts/copilot_adapter.mjs';
import { assistedReviewerRoles } from '../lib/review.mjs';
import { runProcess, processOutputLines } from '../lib/process.mjs';

for (const bad of ['items', 'schema', 'target', 'json']) test(`production survey adapter preserves and corrects invalid ${bad} once`, async t => {
  const f = prepare(t, { executionMode: 'continuous' }); f.config.concurrency = 1;
  const command = nodeCli(safePath(f.root, 'survey-cli.mjs'), `
import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.0.103'); process.exit(0); }
let prompt=''; for await (const chunk of process.stdin) prompt += chunk;
const input=JSON.parse(prompt.split('Frozen task input (JSON task data):\\n')[1].split('\\nExtra task data:')[0]);
const target=JSON.parse(prompt.match(/Set target to ("[^\\n]+").$/m)[1]);
const calls=fs.existsSync('calls.txt') ? Number(fs.readFileSync('calls.txt','utf8'))+1 : 1;
fs.writeFileSync('calls.txt',String(calls));
const value={schemaVersion:1,kind:'survey',survey:input.kind,target,items:input.files.map(f=>({file:f.path,publicInterface:'source interface',inputsOutputsErrors:'inferred only',edgeCases:'unknown',evidence:f.path+':1',unknowns:'unknown'}))};
let content;
if(calls===1) {
  const bad=${JSON.stringify(bad)};
  if(bad==='items') value.items={};
  if(bad==='schema') value.schemaVersion=99;
  if(bad==='target') value.target='migration/wrong.json';
  if(bad==='json') content='this is not JSON';
}
console.log(JSON.stringify({type:'assistant.message',data:{content:content??JSON.stringify(value),toolRequests:[]}}));
console.log(JSON.stringify({type:'result',exitCode:0}));
`);
  const report = await runSurvey(f.root, f.config, 'contracts', createCopilotAdapter({ command }));
  assert.equal(report.agentCalls, 2); assert.equal(report.done, 1);
  assert.equal(surveyStatus(f.root, f.config, 'contracts').done, 1);
  const directory = safePath(f.root, 'migration/surveys/contracts/runs');
  const rejected = fs.readdirSync(directory).filter(f => f.endsWith('-rejected.json'));
  assert.equal(rejected.length, 1);
  const record = readJSON(path.join(directory, rejected[0]));
  if (bad === 'json') assert.equal(record.rawAgentResult, 'this is not JSON');
  else assert.ok(record.result, 'the original rejected model value remains reviewable');
});

function diagnosticCLI(f, stopAt) {
  const flags = requiredCopilotFlags(undefined, f.config), names = [...roles, ...assistedReviewerRoles, 'surveyor', 'preparation-auditor'].map(r => `migration-${r}`);
  return nodeCli(safePath(f.root, 'diagnostic-cli.mjs'), `
import fs from 'node:fs';
const args=process.argv.slice(2), stage=args.includes('--version')?'version':args.includes('--help')?'help':args.includes(${JSON.stringify(probeAgentName)})?'agents':'hook';
fs.appendFileSync('diagnostic-calls.txt',stage+'\\n');
if(stage===${JSON.stringify(stopAt)}) { fs.writeFileSync('diagnostic-pid.txt',String(process.pid)); setInterval(()=>{},1000); }
else if(stage==='version') console.log('1.0.103');
else if(stage==='help') console.log(${JSON.stringify(flags.join(' '))});
else if(stage==='agents') { console.error(${JSON.stringify(`No such agent: ${probeAgentName}, available:${names.join(',')}`)}); process.exitCode=1; }
`);
}

for (const stage of ['version', 'agents', 'hook']) test(`doctor propagates explicit cancellation through its ${stage} probe`, async t => {
  const f = prepare(t, { executionMode: 'continuous' }), controller = new AbortController();
  const command = diagnosticCLI(f, stage);
  const poll = setInterval(() => { if (fs.existsSync(safePath(f.root, 'diagnostic-pid.txt'))) controller.abort(); }, 10);
  const watchdog = setTimeout(() => controller.abort(), 10000);
  try {
    await assert.rejects(doctor(f.root, f.config, { checkCLI: true, command, signal: controller.signal }), /Interrupted/);
    const seen = fs.readFileSync(safePath(f.root, 'diagnostic-calls.txt'), 'utf8').trim().split('\n');
    assert.equal(seen.at(-1), stage, 'no later probe starts after cancellation');
    assert.throws(() => process.kill(Number(fs.readFileSync(safePath(f.root, 'diagnostic-pid.txt'), 'utf8')), 0), { code: 'ESRCH' });
  } finally { clearInterval(poll); clearTimeout(watchdog); }
});

test('doctor command handles a real SIGINT and exits without leaving its CLI child alive', { skip: process.platform === 'win32' && 'Windows taskkill is covered by API cancellation; POSIX SIGINT delivery is platform-specific' }, async t => {
  const f = prepare(t, { executionMode: 'continuous' }), command = diagnosticCLI(f, 'version');
  const child = spawn(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), 'doctor', '--check-cli', '--copilot', command, '--root', f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', pid, exited = false;
  child.stdout.resume(); child.stderr.on('data', data => { stderr += data; });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { exited = true; resolve(code); }); });
  try {
    const until = Date.now() + 10000;
    while (!fs.existsSync(safePath(f.root, 'diagnostic-pid.txt')) && Date.now() < until && !exited) await delay(10);
    pid = Number(fs.readFileSync(safePath(f.root, 'diagnostic-pid.txt'), 'utf8'));
    child.kill('SIGINT');
    const waitUntil = Date.now() + 5000;
    while (!exited && Date.now() < waitUntil) await delay(10);
    assert.equal(exited, true, 'explicit cancellation must end the diagnostic command');
    assert.equal(await completion, 1); assert.match(stderr, /Interrupted/);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    if (!exited) child.kill('SIGKILL');
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    await completion;
  }
});

test('manual cancellation preserves complete shutdown stdout and stderr, including spooled output', { skip: process.platform === 'win32' && 'taskkill does not deliver POSIX SIGTERM handlers' }, async t => {
  const f = prepare(t), controller = new AbortController(), started = safePath(f.root, 'child-started');
  const poll = setInterval(() => { if (fs.existsSync(started)) controller.abort(); }, 10);
  const watchdog = setTimeout(() => controller.abort(), 10000);
  try {
    await assert.rejects(runProcess(process.execPath, ['-e', `
const fs=require('node:fs');
process.on('SIGTERM',()=>{fs.writeSync(1,'final shutdown evidence\\n'+'x'.repeat(4096)+'\\n');fs.writeSync(2,'cleanup failed: locked file\\n');process.exit(0);});
fs.writeSync(1,'started\\n');fs.writeFileSync(${JSON.stringify(started)},'ready');setInterval(()=>{},1000);
`], { signal: controller.signal, maxBytes: 128, outputDir: safePath(f.root, 'migration/runs/process-output') }), e => {
      assert.match(e.message, /Interrupted/); assert.equal(e.result.outputSpooled, true);
      assert.equal([...processOutputLines(e.result, 'stdout', f.root)].join('\n'), 'started\nfinal shutdown evidence\n' + 'x'.repeat(4096));
      assert.equal([...processOutputLines(e.result, 'stderr', f.root)].join('\n'), 'cleanup failed: locked file');
      return true;
    });
  } finally { clearInterval(poll); clearTimeout(watchdog); }
});
