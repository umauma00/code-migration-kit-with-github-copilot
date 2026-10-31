// Opt-in integration check: a real Copilot executable, a loopback-only provider,
// canned responses, temporary CLI home. No external model or account is used.
// Run: node tests/verify_cli_transport.mjs /absolute/path/to/copilot
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { prepare, result } from './helpers.mjs';
import { safePath, writeJSON, fileHash, unitState, atomicWrite, roles } from '../lib/core.mjs';
import { createCopilotAdapter, copilotArgs, agentPrompt, parseCopilotOutput } from '../scripts/copilot_adapter.mjs';
import { reviewInput } from '../lib/review.mjs';
import { createWorkflowDefinition } from '../lib/workflow.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { runProcess } from '../lib/process.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { sessionsStatus, pruneSessions, workerSessions } from '../lib/sessions.mjs';
import { sessionStateDirs } from '../lib/worker-home.mjs';

const command = process.argv[2];
if (!command || !path.isAbsolute(command)) throw new Error('Supply an absolute Copilot executable path');
const workflow = process.argv.includes('--workflow');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cli-transport-')), project = path.join(sandbox, 'project');
fs.mkdirSync(project);
const f = prepare(null, { root: project, model: 'gpt-4.1', count: 3, realCommands: true, workflow });
const records = [], savedEnv = { ...process.env };
const canaries = {
  root: 'ROOT_INSTRUCTION_CANARY_20261010', ancestor: 'ANCESTOR_INSTRUCTION_CANARY_20261010',
  personal: 'PERSONAL_INSTRUCTION_CANARY_20261010', repository: 'REPO_INSTRUCTION_CANARY_20261010'
};
// Instruction sources vary by CLI version and launcher (for example, an
// ancestor AGENTS.md outside the repository). Isolation must hide every source
// the unisolated control actually discovered.
let providerError, control = false;
const discovered = new Set();
const server = http.createServer(async (req, res) => {
  try {
    let body = ''; for await (const c of req) body += c;
    const request = JSON.parse(body), messages = JSON.stringify(request.messages);
    const role = messages.match(/You are a ([\w-]+) in a controlled language migration/)?.[1];
    const target = messages.match(/Set target to \\"([^\\"]+)\\"/)?.[1];
    const unit = f.units.find(u => u.target === target);
    assert.ok(role && unit, 'Request must contain the exact role and assigned target');
    const tools = request.tools?.map(t => t.function?.name ?? t.name) ?? [];
    assert.deepEqual([...tools].sort(), role.startsWith('reviewer-') ? [] : ['glob', 'grep', 'view']);
    const ambient = Object.fromEntries(Object.entries(canaries).map(([name, marker]) => [name, messages.includes(marker)]));
    const profileIncluded = messages.includes(`PROFILE_CANARY_${role}`);
    assert.ok(profileIncluded, 'Explicit --agent profile must still be loaded');
    if (control) for (const [name, seen] of Object.entries(ambient)) { if (seen) discovered.add(name); }
    else assert.ok([...discovered].every(name => !ambient[name]), 'Ambient instructions must not enter a worker request');
    records.push({ control, role, target, tools, requestedModel: request.model, profileIncluded, ambient });
    const content = JSON.stringify(result(role, unit));
    if (request.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const choice of [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }]) {
        res.write('data: ' + JSON.stringify({ id: 'local-test', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [choice] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'local-test', object: 'chat.completion', created: 1, model: request.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    }
  } catch (e) { providerError = e; res.writeHead(500); res.end('Local test provider failed'); }
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const cliHome = safePath(f.root, 'cli-test-home'); fs.mkdirSync(cliHome);
  atomicWrite(safePath(f.root, 'AGENTS.md'), canaries.root + '\n');
  fs.writeFileSync(path.join(sandbox, 'AGENTS.md'), canaries.ancestor + '\n');
  atomicWrite(safePath(f.root, '.github/copilot-instructions.md'), canaries.repository + '\n');
  atomicWrite(path.join(cliHome, 'copilot-instructions.md'), canaries.personal + '\n');
  for (const role of roles) fs.appendFileSync(safePath(f.root, `.github/agents/migration-${role}.agent.md`), `\nPROFILE_CANARY_${role}\n`);
  Object.assign(process.env, { COPILOT_HOME: cliHome, COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'local-test-only', COPILOT_PROVIDER_BEARER_TOKEN: '',
    COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'gpt-4.1', COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' });
  f.config.timeoutSeconds = 30; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const adapter = createCopilotAdapter({ command, prefixArgs: ['--log-dir', safePath(f.root, 'cli-test-logs')] });
  const checks = await doctor(f.root, f.config, { checkCLI: true, command }); assert.equal(checks.ok, true);
  // Same CLI/profile/input, but deliberately omit the isolation flag once.
  // This proves the canaries are discoverable instead of testing an empty setup.
  control = true;
  const unit = f.units[0], frozen = reviewInput(f.root, f.config, unit, null, { candidate: false }).text;
  const positive = await runProcess(command, copilotArgs('reviewer-rules', f.config.models['reviewer-rules']).filter(a => a !== '--no-custom-instructions'), {
    cwd: f.root, timeoutMs: 30000, input: agentPrompt({ role: 'reviewer-rules', unit, reviewInput: frozen }),
    env: { ...process.env, COPILOT_ALLOW_ALL: 'false', MIGRATION_KIT_ROLE: 'reviewer-rules' }
  });
  assert.equal(positive.code, 0, positive.stderr); parseCopilotOutput(positive.stdout); control = false;
  if (providerError) throw providerError;
  assert.ok(discovered.size > 0, 'Positive control must discover at least one instruction canary');
  const definition = createWorkflowDefinition(f.root);
  const runTranslation = () => workflow ? definition.run({ args: { stage: 'translate', copilot: command }, phase() {}, log() {},
    agent: async () => { throw new Error('Host SDK agent must not run'); } }) : translate(f.root, f.config, adapter);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Canned local-provider transport verification only');
  const translation = await runTranslation();
  assert.equal(translation.done, 3); assert.equal(translation.agentCalls, 9);
  for (const unit of f.units) {
    assert.equal(fs.readFileSync(safePath(f.root, unit.target), 'utf8'), result('implementer', unit).content);
    const state = unitState(f.root, unit);
    assert.equal(state.reviews.length, 2); assert.ok(state.reviewInputHash);
  }
  const stages = {};
  for (const stage of ['build', 'smoke', 'parity']) {
    approve(f.root, f.config, stage, 'Canned local-provider fixture');
    const run = await runStage(f.root, f.config, stage);
    stages[stage] = { success: run.success, output: run.commands.map(c => c.stdout.trim()) };
  }
  for (const role of ['arbiter', 'fixer']) await adapter({ ...f, role, unit: f.units[0], extra: {} });
  atomicWrite(safePath(f.root, 'AGENTS.md'), canaries.root + '_EDITED\n');
  const resumed = await runTranslation(); assert.equal(resumed.agentCalls, 0);
  if (providerError) throw providerError;
  // Workers ran as runner-named sessions in the kit's worker home (0.34.0):
  // each recorded ID exists there, none in the person's home, and prune
  // removes exactly those (the control run's session in the person's home stays).
  const [workerState, personState] = sessionStateDirs(f.root);
  const list = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => !n.startsWith('.')) : [];
  const before = list(workerState), personBefore = list(personState);
  const recorded = sessionsStatus(f.root);
  assert.ok(recorded.recorded >= 9); assert.equal(recorded.present, recorded.recorded);
  assert.ok([...workerSessions(f.root).keys()].every(id => before.includes(id) && !personBefore.includes(id)), 'workers used the worker home');
  assert.ok(fs.existsSync(path.join(path.dirname(workerState), 'session-store.db')), 'the worker home has its own session index');
  const pruned = pruneSessions(f.root), after = list(workerState);
  assert.equal(pruned.removed, recorded.present); assert.equal(before.length - after.length, pruned.removed);
  assert.ok(personBefore.length >= 1 && list(personState).length === personBefore.length, 'the unrecorded control session is left alone');
  const sessions = { recorded: recorded.recorded, present: recorded.present, removed: pruned.removed, untouched: list(personState).length };
  const version = await runProcess(command, ['--version'], { cwd: f.root });
  console.log(JSON.stringify({ schemaVersion: 1, date: new Date().toISOString(), cli: version.stdout.trim(),
    platform: `${process.platform}/${process.arch}`, node: process.version, localProviderIsTestDouble: true,
    externalAIUsed: false, entrypoint: workflow ? 'workflow (simulated SDK host, real CLI workers)' : 'CLI', doctorOK: checks.ok,
    controlDiscovered: [...discovered].sort(),
    instructionIsolationOK: records.filter(r => !r.control).every(r => [...discovered].every(name => !r.ambient[name]) && r.profileIncluded),
    translation: { done: translation.done, total: translation.total, agentCalls: translation.agentCalls },
    stages, resumedAgentCalls: resumed.agentCalls, sessions, records, outputHashes: f.units.map(u => ({ target: u.target, hash: fileHash(safePath(f.root, u.target)) })) }, null, 2));
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
