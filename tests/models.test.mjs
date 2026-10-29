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
    billing: { multiplier: 1, tokenPrices: { inputPrice: 200, outputPrice: 1000, cacheReadPrice: 10, batchSize: 1000000, maxPromptTokens: 272000, longContext: { inputPrice: 400, outputPrice: 1500, maxPromptTokens: 1000000 } } }, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' },
  { id: 'small-model', name: 'Small Model', capabilities: {}, billing: { tokenPrices: { inputPrice: 10000000, outputPrice: 50000000, batchSize: 1000 } }, supportedReasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'plain-model', name: 'Plain Model', capabilities: {}, billing: { tokenPrices: { inputPrice: 3, outputPrice: 9, batchSize: 1000 } } },
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
    else if (msg.method === 'models.listTokenPriceUnits') send({ jsonrpc: '2.0', id: msg.id, result: { units: [{ modelId: 'big-model', unit: 'ai_credits' }, { modelId: 'small-model', unit: 'nano_aiu' }] } });
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
  // Official ModelBillingTokenPrices: inputPrice/outputPrice per batchSize tokens, unit from models.listTokenPriceUnits.
  assert.match(ja, /\| `big-model` \| Big Model \| low, medium, high, xhigh \(medium\) \| default 272K \/ long_context 1M \| 200 \/ 1000 AIC\/100万トークン、長文脈（入力 272000 トークン超） 400 \/ 1500 \|/);
  assert.match(ja, /\| `small-model` \| Small Model \| [^|]* \| — \| 10 \/ 50 AIC\/100万トークン \|/, 'nano-AIU per 1000 tokens becomes AI Credits per million');
  assert.match(modelsMarkdown(models, null, 'en'), /\| `plain-model` \| Plain Model \| — \| — \| 3 \/ 9 per 1000 tokens \(unit unknown\) \|/);
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
  assert.equal(result.assignments.find(a => a.role === 'surveyor').effort, null, 'a surveyor with its own model never inherits the implementer\'s effort');
  const config = loadConfig(f.root);
  assert.equal(workerEffort(config, 'arbiter'), undefined);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, config)), false, 'a new model or effort means a new review');
  assert.throws(() => setRoleModels(f.root, models, { role: 'planner', model: 'big-model' }), /Unknown role planner/);
  assert.throws(() => setRoleModels(f.root, models, { role: 'fixer', model: 'blocked-model' }), /disabled/);
  assert.deepEqual(readJSON(safePath(f.root, 'migration/config.json')), written, 'a refused choice changes nothing');
  assert.match(modelsMarkdown(models, config, 'en'), /\| reviewer-rules \| `big-model` \| xhigh \| default \|/);
  assert.deepEqual(currentAssignments({ models: {} }).find(a => a.role === 'surveyor'), { role: 'surveyor', model: null, effort: null, context: 'default', inherits: 'implementer' });
});

test('models set --assign records every role from one answer, all or nothing', async t => {
  const f = await ready(t);
  const models = await listAvailableModels({ command: process.execPath, prefixArgs: [fakeCli(t)] });
  const before = readJSON(safePath(f.root, 'migration/config.json'));
  // One refused entry (an effort the model lacks) writes nothing at all.
  assert.throws(() => setRoleModels(f.root, models, { assign: 'all=small-model:high, arbiter=plain-model:low' }), /no selectable reasoning effort/);
  assert.throws(() => setRoleModels(f.root, models, { assign: 'implementer' }), /ROLE=MODEL_ID\[:EFFORT\]/);
  assert.throws(() => setRoleModels(f.root, models, { assign: 'all=small-model', role: 'fixer' }), /either/);
  assert.deepEqual(readJSON(safePath(f.root, 'migration/config.json')), before);
  const result = setRoleModels(f.root, models, { assign: 'all=small-model:high, reviewers=big-model:xhigh arbiter=big-model:default,fixer=small-model' });
  const written = readJSON(safePath(f.root, 'migration/config.json'));
  assert.deepEqual(written.models, { implementer: 'small-model', 'reviewer-semantics': 'big-model', 'reviewer-rules': 'big-model', arbiter: 'big-model', fixer: 'small-model' });
  assert.deepEqual(written.reasoningEfforts, { implementer: 'high', 'reviewer-semantics': 'xhigh', 'reviewer-rules': 'xhigh' });
  assert.equal(result.assignments.find(a => a.role === 'surveyor').inherits, 'implementer');
  assert.match(modelsMarkdown(models, written, 'ja'), /まとめて選ぶ（1回の回答）[\s\S]*implementer=MODEL_ID:EFFORT, reviewers=MODEL_ID:EFFORT/);
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs models set --assign "all=small-model:high,reviewers=big-model"'), 'models set');
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

test('questions ask the report language first, then stay in Japanese when ja is recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-gate-'));
  const ask = toolArgs => interactiveDecision({ toolName: 'ask_user', toolArgs, cwd: root });
  try {
    fs.mkdirSync(path.join(root, 'migration'));
    fs.writeFileSync(path.join(root, 'migration/config.json'), '{}');
    assert.equal(ask({ question: 'Which target language?', choices: ['Java', 'Go'] }).decision, 'deny');
    assert.match(ask({ question: 'Which target language?' }).reason, /preferences --language/);
    assert.equal(ask({ question: 'Report language / 報告言語', choices: ['日本語 (ja)', 'English (en)'] }), null);
    fs.writeFileSync(path.join(root, 'migration/preferences.json'), JSON.stringify({ schemaVersion: 1, userLanguage: 'ja' }));
    const english = ask({ question: 'How should Phase 01 proceed?', choices: ['Keep blocked', 'Specify another path'] });
    assert.equal(english.decision, 'deny'); assert.match(english.reason, /日本語/);
    assert.equal(ask({ question: 'Phase 01 をどう進めますか？', choices: ['blocked を維持', '`audit_inputs.mjs run` で実行'] }), null);
    const vscode = toolArgs => interactiveDecision({ toolName: 'vscode/askQuestions', toolArgs, cwd: root });
    assert.equal(vscode({ questions: [{ question: 'Proceed?' }] }).decision, 'deny');
    // A Japanese header, another question or a file name does not pass an English question.
    const headed = vscode({ questions: [{ header: '確認', question: 'How should Phase 01 proceed?', options: [{ label: 'Keep blocked' }, { label: 'Specify another path' }] }] });
    assert.equal(headed.decision, 'deny'); assert.match(headed.reason, /How should Phase 01 proceed\?/);
    const mixed = vscode({ questions: [{ question: '続けますか？', options: [{ label: 'はい' }] }, { question: 'Which module next?' }] });
    assert.equal(mixed.decision, 'deny'); assert.match(mixed.reason, /Which module next/); assert.doesNotMatch(mixed.reason, /続けますか/);
    assert.equal(ask({ question: 'Should we migrate src/売上集計.java next?' }).decision, 'deny');
    assert.equal(ask({ question: '売上集計.java を次に移行しますか？' }), null);
    // Paths and slashes joined to Japanese prose without spaces keep the prose.
    for (const question of ['Java/Goのどちらに移行しますか？', 'src/売上集計.javaを次に移行しますか？', '次にsrc/main.pyを移行しますか？',
      'JavaとGoのどちらに移行しますか？', '`src/売上集計.java`を次に移行しますか？', '続行？', 'src/a.py 移行？']) assert.equal(ask({ question }), null, question);
    for (const question of ['Should we migrate 売上集計.java next?', 'Migrate src\\売上\\集計.java now?', 'Proceed with 移行?'])
      assert.equal(ask({ question }).decision, 'deny', question);
    // Choices are checked separately; single names and `quoted` text pass.
    assert.match(ask({ question: '次に何をしますか？', choices: ['blocked を維持', 'Keep everything blocked'] }).reason, /Keep everything blocked/);
    assert.equal(ask({ question: '移行先の言語は？', choices: ['Java', 'Go', '`Spring Boot` を使う'] }), null);
    assert.match(vscode({ questions: [{ question: '進めますか？', options: [{ label: 'はい', description: 'Runs every pending audit now' }] }] }).reason, /Runs every pending audit/);
    fs.writeFileSync(path.join(root, 'migration/preferences.json'), JSON.stringify({ schemaVersion: 1, userLanguage: 'en' }));
    assert.equal(ask({ question: 'How should Phase 01 proceed?' }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a surveyor set to its model default does not run with the implementer\'s effort', async t => {
  const f = await ready(t);
  const models = await listAvailableModels({ command: process.execPath, prefixArgs: [fakeCli(t)] });
  setRoleModels(f.root, models, { role: 'implementer', model: 'big-model', effort: 'high' });
  assert.equal(workerEffort(loadConfig(f.root), 'surveyor'), 'high', 'without a model of its own the surveyor runs the implementer\'s model and effort');
  setRoleModels(f.root, models, { role: 'surveyor', model: 'plain-model', effort: 'default' });
  const config = loadConfig(f.root);
  assert.equal(workerEffort(config, 'surveyor'), undefined);
  const args = copilotArgs('surveyor', 'plain-model', undefined, null, null, { effort: workerEffort(config, 'surveyor') });
  assert.equal(args.includes('--reasoning-effort'), false);
  // The effective combination is checked too, inheritance included.
  const file = safePath(f.root, 'migration/config.json'), raw = readJSON(file);
  delete raw.phaseModels.survey; raw.models.implementer = 'plain-model';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => setRoleModels(f.root, models, { role: 'fixer', model: 'big-model' }), /implementer would run plain-model with reasoning effort high/);
});

test('--role all also covers a surveyor that had its own model and effort', async t => {
  const f = await ready(t);
  const models = await listAvailableModels({ command: process.execPath, prefixArgs: [fakeCli(t)] });
  setRoleModels(f.root, models, { role: 'surveyor', model: 'small-model', effort: 'max' });
  setRoleModels(f.root, models, { role: 'all', model: 'big-model', effort: 'low' });
  const config = loadConfig(f.root);
  assert.equal(config.phaseModels?.survey, undefined);
  assert.equal(config.reasoningEfforts.surveyor, undefined);
  for (const a of currentAssignments(config)) assert.deepEqual([a.role, a.model, a.effort], [a.role, 'big-model', 'low']);
  setRoleModels(f.root, models, { role: 'all', model: 'plain-model', effort: 'default' });
  assert.equal(loadConfig(f.root).reasoningEfforts, undefined);
  assert.deepEqual(currentAssignments(loadConfig(f.root)).map(a => [a.model, a.effort]), Array(6).fill(['plain-model', null]));
});
