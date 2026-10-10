// Opt-in integration check: a real Copilot executable, a loopback-only provider,
// canned responses, temporary CLI home. No external model or account is used.
// Run: node tests/verify_cli_transport.mjs /absolute/path/to/copilot
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { prepare, result } from './helpers.mjs';
import { safePath, writeJSON, fileHash, unitState } from '../lib/core.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { runProcess } from '../lib/process.mjs';
import { doctor } from '../scripts/run_migration.mjs';

const command = process.argv[2];
if (!command || !path.isAbsolute(command)) throw new Error('Supply an absolute Copilot executable path');
const f = prepare(null, { model: 'gpt-4.1', count: 3, realCommands: true });
const records = [], savedEnv = { ...process.env };
let providerError;
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
    records.push({ role, target, tools, requestedModel: request.model });
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
  Object.assign(process.env, { COPILOT_HOME: cliHome, COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'local-test-only', COPILOT_PROVIDER_BEARER_TOKEN: '',
    COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'gpt-4.1', COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' });
  f.config.timeoutSeconds = 30; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const adapter = createCopilotAdapter({ command, prefixArgs: ['--log-dir', safePath(f.root, 'cli-test-logs')] });
  const checks = await doctor(f.root, f.config, { checkCLI: true, command }); assert.equal(checks.ok, true);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Canned local-provider transport verification only');
  const translation = await translate(f.root, f.config, adapter);
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
  const resumed = await translate(f.root, f.config, adapter); assert.equal(resumed.agentCalls, 0);
  if (providerError) throw providerError;
  const version = await runProcess(command, ['--version'], { cwd: f.root });
  console.log(JSON.stringify({ schemaVersion: 1, date: new Date().toISOString(), cli: version.stdout.trim(),
    platform: `${process.platform}/${process.arch}`, node: process.version, localProviderIsTestDouble: true,
    externalAIUsed: false, doctorOK: checks.ok, translation: { done: translation.done, total: translation.total, agentCalls: translation.agentCalls },
    stages, resumedAgentCalls: resumed.agentCalls, records, outputHashes: f.units.map(u => ({ target: u.target, hash: fileHash(safePath(f.root, u.target)) })) }, null, 2));
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(f.root, { recursive: true, force: true });
}
