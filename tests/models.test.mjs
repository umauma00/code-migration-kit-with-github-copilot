import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ready, fake } from './helpers.mjs';
import { contextHash, done, readJSON, safePath, loadConfig, validateEfforts, workerEffort } from '../lib/core.mjs';
import { translate } from '../lib/pipeline.mjs';
import { listAvailableModels, checkChoice, setRoleModels, modelsMarkdown, currentAssignments } from '../lib/models.mjs';
import { copilotArgs } from '../scripts/copilot_adapter.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';
import { failureGuidance } from '../lib/guidance.mjs';

// A stand-in for `copilot --headless --stdio`: framed JSON-RPC with connect and models.list.
const catalog = [
  { id: 'big-model', name: 'Big Model', capabilities: { supports: { reasoningEffort: true } }, policy: { state: 'enabled', terms: '' },
    billing: { multiplier: 1, tokenPrices: { input: '$2.00', output: '$10.00' } }, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' },
  { id: 'small-model', name: 'Small Model', capabilities: {}, supportedReasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'plain-model', name: 'Plain Model', capabilities: {} },
  { id: 'blocked-model', name: 'Blocked Model', capabilities: {}, policy: { state: 'disabled', terms: '' } },
];
function fakeCli(t, { auth = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'copilot.mjs');
  fs.writeFileSync(file, `#!${process.execPath}
const args = process.argv.slice(2);
if (!args.includes('--headless') || !args.includes('--stdio')) process.exit(2);
let buf = Buffer.alloc(0);
const send = m => { const b = JSON.stringify(m); process.stdout.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b); };
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\\r\\n\\r\\n'); if (h < 0) return;
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len)); buf = buf.subarray(h + 4 + len);
    send({ jsonrpc: '2.0', method: 'session.log', params: {} });
    if (msg.method === 'connect') send({ jsonrpc: '2.0', id: msg.id, result: { ok: true, protocolVersion: 3 } });
    else if (msg.method === 'models.list') send(${auth} ? { jsonrpc: '2.0', id: msg.id, result: { models: ${JSON.stringify(catalog)} } }
      : { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Request models.list failed with message: Not authenticated. Please authenticate first.' } });
  }
});
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('models list reads the account catalog from the CLI headless server', async t => {
  const models = await listAvailableModels({ command: process.execPath, prefixArgs: [fakeCli(t)] });
  assert.deepEqual(models.map(m => [m.id, m.state, m.efforts.join(',')]), [
    ['big-model', 'enabled', 'low,medium,high,xhigh'], ['small-model', 'enabled', 'low,medium,high,max'],
    ['plain-model', 'enabled', ''], ['blocked-model', 'disabled', '']]);
  assert.equal(models[0].defaultEffort, 'medium');
  const ja = modelsMarkdown(models, null, 'ja');
  assert.match(ja, /\| `big-model` \| Big Model \| low, medium, high, xhigh \(medium\) \| \$2\.00 \/ \$10\.00 \|/);
  assert.match(ja, /利用できないモデル.*`blocked-model` \(disabled\)/);
  await assert.rejects(listAvailableModels({ command: process.execPath, prefixArgs: [fakeCli(t, { auth: false })] }), /not signed in to Copilot.*copilot login/);
  await assert.rejects(listAvailableModels({ command: path.join(os.tmpdir(), 'no-such-copilot') }), /Cannot start the Copilot CLI.*ENOENT/);
  assert.equal(failureGuidance('The Copilot CLI is not signed in to Copilot, so it cannot list your models; run copilot login first').id, 'copilot-auth');
});

test('a choice must be an enabled listed model and one of its efforts', async t => {
  const models = await listAvailableModels({ command: process.execPath, prefixArgs: [fakeCli(t)] });
  assert.deepEqual(checkChoice(models, 'big-model', 'xhigh'), { model: 'big-model', effort: 'xhigh' });
  assert.deepEqual(checkChoice(models, 'BIG-MODEL', 'default'), { model: 'big-model', effort: undefined });
  assert.throws(() => checkChoice(models, 'missing-model'), /not in your Copilot model list/);
  assert.throws(() => checkChoice(models, 'blocked-model'), /disabled for your account/);
  assert.throws(() => checkChoice(models, 'big-model', 'max'), /supports reasoning effort low, medium, high, xhigh; not max/);
  assert.throws(() => checkChoice(models, 'plain-model', 'low'), /no selectable reasoning effort/);
  assert.throws(() => checkChoice(models, 'big-model', 'extreme'), /Effort must be one of/);
});

test('models set records the person\'s choice and revokes reviews made under the old one', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, fake);
  const before = contextHash(f.root, f.config);
  assert.equal(done(f.root, f.units[0], before), true);
  const models = await listAvailableModels({ command: process.execPath, prefixArgs: [fakeCli(t)] });
  setRoleModels(f.root, models, { role: 'all', model: 'small-model', effort: 'high' });
  setRoleModels(f.root, models, { role: 'reviewers', model: 'big-model', effort: 'xhigh' });
  setRoleModels(f.root, models, { role: 'arbiter', model: 'big-model', effort: 'default' });
  const result = setRoleModels(f.root, models, { role: 'surveyor', model: 'plain-model' });
  const written = readJSON(safePath(f.root, 'migration/config.json'));
  assert.deepEqual(written.models, { implementer: 'small-model', 'reviewer-semantics': 'big-model', 'reviewer-rules': 'big-model', arbiter: 'big-model', fixer: 'small-model' });
  assert.deepEqual(written.reasoningEfforts, { implementer: 'high', fixer: 'high', 'reviewer-semantics': 'xhigh', 'reviewer-rules': 'xhigh' });
  assert.equal(written.phaseModels.survey, 'plain-model');
  assert.equal(result.assignments.find(a => a.role === 'surveyor').effort, 'high', 'surveyor effort follows the implementer unless chosen');
  const config = loadConfig(f.root);
  assert.equal(workerEffort(config, 'arbiter'), undefined);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, config)), false, 'a new model or effort means a new review');
  assert.throws(() => setRoleModels(f.root, models, { role: 'planner', model: 'big-model' }), /Unknown role planner/);
  assert.throws(() => setRoleModels(f.root, models, { role: 'fixer', model: 'blocked-model' }), /disabled/);
  assert.deepEqual(readJSON(safePath(f.root, 'migration/config.json')), written, 'a refused choice changes nothing');
  assert.match(modelsMarkdown(models, config, 'en'), /\| reviewer-rules \| `big-model` \| xhigh \|/);
  assert.deepEqual(currentAssignments({ models: {} }).find(a => a.role === 'surveyor'), { role: 'surveyor', model: null, effort: null, inherits: 'implementer' });
});

test('reasoning effort reaches the worker command line and is validated in config', () => {
  const args = copilotArgs('implementer', 'small-model', undefined, null, null, { effort: 'high' });
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4), ['--model', 'small-model', '--reasoning-effort', 'high']);
  assert.equal(copilotArgs('implementer', 'small-model', undefined, null, null).includes('--reasoning-effort'), false, 'default effort passes no flag');
  assert.throws(() => validateEfforts({ reasoningEfforts: { implementer: 'turbo' } }), /must be one of/);
  assert.throws(() => validateEfforts({ reasoningEfforts: { planner: 'high' } }), /not a worker role/);
  assert.throws(() => validateEfforts({ reasoningEfforts: ['high'] }), /must map worker roles/);
  validateEfforts({ reasoningEfforts: { surveyor: 'low', 'reviewer-rules': 'max' } });
});

test('recording a model choice asks the person; listing does not', () => {
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs models set --role all --model big-model --effort high'), 'models set');
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs models list --format markdown'), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'models-gate-'));
  try {
    fs.mkdirSync(path.join(root, 'migration'));
    fs.writeFileSync(path.join(root, 'migration/config.json'), '{}');
    const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'node migration-kit/scripts/run_migration.mjs models set --role fixer --model big-model' }, cwd: root });
    assert.equal(decision.decision, 'ask');
    assert.match(decision.reason, /person's choice/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
