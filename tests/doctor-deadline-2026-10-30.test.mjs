// SPDX-License-Identifier: Apache-2.0
// doctor --check-cli stayed "still running" for over an hour on a Windows PC
// behind a corporate proxy (2026-10-30): continuous mode gave its probes no
// deadline, and a CLI that gets no answer waits forever. doctor now gives each
// probe a deadline, names the stalled stage and finishes; the loopback probes
// add 127.0.0.1 and localhost to NO_PROXY for their own child.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, nodeCli } from './helpers.mjs';
import { safePath, roles } from '../lib/core.mjs';
import { doctor, doctorProbeSeconds, doctorTimeout } from '../scripts/run_migration.mjs';
import { requiredCopilotFlags, probeAgentName, loopbackNoProxy, probeModelTools } from '../scripts/copilot_adapter.mjs';
import { assistedReviewerRoles } from '../lib/review.mjs';
import { doctorGuidance, failureGuidance } from '../lib/guidance.mjs';

// A CLI double that answers every probe except the one at stopAt, which never ends.
function stallingCLI(f, stopAt) {
  const flags = requiredCopilotFlags(undefined, f.config), names = [...roles, ...assistedReviewerRoles, 'surveyor', 'preparation-auditor'].map(r => `migration-${r}`);
  return nodeCli(safePath(f.root, 'stalling-cli.mjs'), `
import fs from 'node:fs';
const args=process.argv.slice(2), stage=args.includes('--version')?'version':args.includes('--help')?'help':args.includes(${JSON.stringify(probeAgentName)})?'agents':args.includes('gpt-4.1')?'loopback':'model';
fs.appendFileSync('stall-calls.txt',stage+' '+(process.env.NO_PROXY ?? '')+'\\n');
if(stage===${JSON.stringify(stopAt)}) {
  // With STALL_AFTER_REQUEST the CLI first sends the loopback provider its tool list, then hangs.
  if(process.env.STALL_AFTER_REQUEST) await fetch(process.env.COPILOT_PROVIDER_BASE_URL+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tools:[{type:'function',function:{name:'view'}}]})});
  setInterval(()=>{},1000);
}
else if(stage==='version') console.log('1.0.105');
else if(stage==='help') console.log(${JSON.stringify(flags.join(' '))});
else if(stage==='agents') { console.error(${JSON.stringify(`No such agent: ${probeAgentName}, available:${names.join(',')}`)}); process.exitCode=1; }
`);
}
const calls = f => fs.readFileSync(safePath(f.root, 'stall-calls.txt'), 'utf8').trim().split('\n');

for (const [stopAt, stage] of [['version', 'Copilot CLI --version'], ['agents', 'worker agents resolve']]) test(`doctor ends a ${stopAt} probe that never answers, names the stage and starts no later probe`, async t => {
  const f = prepare(t, { executionMode: 'continuous' }), command = stallingCLI(f, stopAt);
  const started = Date.now();
  // Windows .cmd shims and a loaded CI machine can be slow to start, so the answering stages get a generous deadline.
  const report = await doctor(f.root, f.config, { checkCLI: true, command, probeTimeoutMs: 10000 });
  assert.ok(Date.now() - started < 30000, 'doctor finishes instead of waiting for the CLI');
  const stall = report.checks.find(c => c.check === 'Copilot CLI answers');
  assert.equal(report.ok, false);
  assert.equal(stall.ok, false); assert.equal(stall.stalled, true); assert.equal(stall.stage, stage);
  assert.match(stall.detail, new RegExp(`Doctor check "${stage}" did not finish within 10 s`));
  assert.match(stall.detail, /proxy/);
  assert.equal(calls(f).at(-1).split(' ')[0], stopAt, 'no later probe starts after a stalled one');
  assert.ok(report.checks.some(c => c.check === 'file descriptor limit'), 'the non-CLI check still runs');
  if (stopAt === 'agents') assert.equal(report.checks.find(c => c.check === 'Copilot executable').ok, true, 'the version already read stays reported');
  const [guidance] = doctorGuidance(report, { language: 'ja' }).filter(g => g.targets.includes('Copilot CLI answers'));
  assert.equal(guidance.guidance.id, 'doctor-stall');
  assert.match(guidance.guidance.cause, new RegExp(`「${stage}」が 10 秒たっても終わりませんでした`));
  assert.deepEqual(guidance.guidance.options.map(o => o.id), ['check-network', 'skip-cli-check', 'pause']);
});

test('a stalled loopback hook probe is reported with the doctor stall guidance and skips the model-tool probes', async t => {
  const f = prepare(t, { executionMode: 'continuous' }), command = stallingCLI(f, 'loopback');
  // Windows .cmd shims and a loaded CI machine can be slow to start, so the answering stages get a generous deadline.
  const report = await doctor(f.root, f.config, { checkCLI: true, command, probeTimeoutMs: 10000 });
  const hook = report.checks.find(c => c.check === 'tool-assisted reviewer hook loads in prompt mode');
  assert.equal(hook.ok, false); assert.equal(hook.stalled, true);
  assert.match(hook.detail, /Doctor check "tool-assisted reviewer hook loads in prompt mode" did not finish within 10 s/);
  assert.equal(report.checks.some(c => c.check.startsWith('model tools: ')), false, 'the same loopback provider would stall again');
  assert.equal(calls(f).filter(line => line.startsWith('loopback')).length, 1);
  assert.equal(doctorGuidance(report).find(g => g.targets.includes(hook.check)).guidance.id, 'doctor-stall');
  assert.ok(report.checks.some(c => c.check === 'file descriptor limit'), 'later non-CLI checks still run');
});

test('a stalled model-tools probe stays not-verified, is marked stalled and starts no other model-tools probe', async t => {
  const f = prepare(t, { executionMode: 'continuous' }), command = stallingCLI(f, 'model');
  // Windows .cmd shims and a loaded CI machine can be slow to start, so the answering stages get a generous deadline.
  const report = await doctor(f.root, f.config, { checkCLI: true, command, probeTimeoutMs: 10000 });
  // The double cannot answer the hook probe's tool call, so that check fails without a stall and the model-tools probes still run.
  const hook = report.checks.find(c => c.check === 'tool-assisted reviewer hook loads in prompt mode');
  assert.equal(hook.ok, false); assert.equal(hook.stalled, undefined);
  const tools = report.checks.filter(c => c.check.startsWith('model tools: '));
  assert.equal(tools.length, 1);
  assert.ok(report.warnings.some(w => /did not finish within 10 s/.test(w)), 'a stalled unverified check is still a warning');
  assert.equal(tools[0].ok, true); assert.equal(tools[0].status, 'not-verified'); assert.equal(tools[0].stalled, true);
  assert.match(tools[0].detail, /Doctor check "model tools: .*" did not finish within 10 s/);
  assert.equal(calls(f).filter(line => line.startsWith('model')).length, 1);
});

test('a probe that hangs after the CLI listed its tools keeps the tool list', async t => {
  const f = prepare(t, { executionMode: 'continuous' }), command = stallingCLI(f, 'model');
  assert.deepEqual(await probeModelTools(command, ['-p', 'probe'], { cwd: f.root, model: 'test-double', env: { STALL_AFTER_REQUEST: '1' }, timeoutMs: 5000 }), { ok: true, tools: ['view'] });
});

test('the doctor deadline: the default applies in continuous mode, an explicit bounded commandTimeoutSeconds can only shorten it', async t => {
  assert.equal(doctorProbeSeconds, 180);
  assert.equal(doctorTimeout({ executionMode: 'continuous', commandTimeoutSeconds: 7200 }), 180000);
  assert.equal(doctorTimeout({ executionMode: 'bounded', commandTimeoutSeconds: 0 }), 180000);
  assert.equal(doctorTimeout({ executionMode: 'bounded', commandTimeoutSeconds: 7200 }), 180000);
  assert.equal(doctorTimeout({ executionMode: 'bounded', commandTimeoutSeconds: 60 }), 60000);
  const f = prepare(t, { executionMode: 'bounded' }); f.config.commandTimeoutSeconds = 1;
  const report = await doctor(f.root, f.config, { checkCLI: true, command: stallingCLI(f, 'version') });
  assert.match(report.checks.find(c => c.check === 'Copilot CLI answers').detail, /did not finish within 1 s/);
});

test('loopback probes add 127.0.0.1 and localhost to NO_PROXY and keep the person\'s entries', async t => {
  const merged = loopbackNoProxy({ HTTPS_PROXY: 'http://proxy.example:8080', no_proxy: '*.corp.example, 127.0.0.1', PATH: 'x' });
  assert.equal(merged.NO_PROXY, '*.corp.example,127.0.0.1,localhost');
  assert.equal(merged.HTTPS_PROXY, 'http://proxy.example:8080'); assert.equal(merged.PATH, 'x');
  const spellings = Object.keys(merged).filter(key => key.toLowerCase() === 'no_proxy');
  assert.deepEqual(spellings.sort(), process.platform === 'win32' ? ['NO_PROXY'] : ['NO_PROXY', 'no_proxy']);
  assert.equal(loopbackNoProxy({}).NO_PROXY, '127.0.0.1,localhost');
  // The probe's own child sees it, whatever the parent had.
  const f = prepare(t, { executionMode: 'continuous' }), command = stallingCLI(f, 'none');
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'no_proxy'));
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.NO_PROXY = '*.corp.example';
  try { await probeModelTools(command, ['-p', 'probe'], { cwd: f.root, model: 'gpt-4.1', timeoutMs: 20000 }); }
  finally { delete process.env.NO_PROXY; delete process.env.no_proxy; Object.assign(process.env, saved); }
  assert.deepEqual(calls(f), ['model *.corp.example,127.0.0.1,localhost']);
});

test('the doctor stall message gets its own guidance, not the bounded-deadline one', () => {
  const g = failureGuidance('Doctor check "Copilot CLI --help" did not finish within 180 s. The Copilot CLI got no answer.', { language: 'en' });
  assert.equal(g.id, 'doctor-stall'); assert.equal(g.recommended, 'check-network');
  assert.match(g.options[1].command, /doctor$/);
  assert.equal(failureGuidance('Doctor check "x" did not finish within 1.5 s.').id, 'doctor-stall');
});
