import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ready, prepare, fake, cliDouble } from './helpers.mjs';
import { contextHash, done, readJSON, safePath, loadConfig, workerContext, validateContextTiers } from '../lib/core.mjs';
import { translate, runStage, approve } from '../lib/pipeline.mjs';
import { normalizeModels, parseAssignments, checkChoice, setRoleModels, modelsMarkdown, currentAssignments } from '../lib/models.mjs';
import { copilotArgs, requiredCopilotFlags, createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';

// Shapes from the SDK's Model type (models.list): Copilot models carry the
// long tier as billing.tokenPrices.longContext; other providers declare
// supportedContextTiers; a model may publish only capabilities.limits.
const models = normalizeModels([
  { id: 'tiered', name: 'Tiered', capabilities: { limits: { max_prompt_tokens: 128000 } }, supportedReasoningEfforts: ['low', 'high'],
    billing: { tokenPrices: { inputPrice: 1, outputPrice: 2, batchSize: 1000, maxPromptTokens: 200000, longContext: { inputPrice: 2, outputPrice: 4, maxPromptTokens: 1000000 } } } },
  { id: 'declared', name: 'Declared', capabilities: {}, supportedContextTiers: ['default', 'long_context'] },
  { id: 'limits-only', name: 'Limits only', capabilities: { limits: { max_prompt_tokens: 64000 } } },
  { id: 'vendor:model', name: 'Colon', capabilities: {}, billing: { tokenPrices: { longContext: { inputPrice: 1 } } } },
]);

test('models list reads each model\'s context tiers and prompt budgets', () => {
  const by = Object.fromEntries(models.map(m => [m.id, m]));
  assert.deepEqual([by.tiered.contexts, by.tiered.contextTokens], [['default', 'long_context'], { default: 200000, long_context: 1000000 }]);
  assert.deepEqual([by.declared.contexts, by.declared.contextTokens], [['default', 'long_context'], {}]);
  assert.deepEqual([by['limits-only'].contexts, by['limits-only'].contextTokens], [[], { default: 64000 }]);
  const ja = modelsMarkdown(models, null, 'ja'), en = modelsMarkdown(models, null, 'en');
  assert.match(ja, /\| モデル ID \| 名前 \| エフォート（既定） \| コンテキスト（入力上限） \| 料金/);
  assert.match(ja, /\| `tiered` \| Tiered \| low, high \| default 200K \/ long_context 1M \|/);
  assert.match(en, /\| `declared` \| Declared \| — \| default \/ long_context \|/);
  assert.match(en, /\| `limits-only` \| Limits only \| — \| default 64K \|/);
  assert.match(ja, /`:long_context`[\s\S]*reviewers=MODEL_ID:EFFORT:long_context/);
});

test('one answer can carry a context tier after the effort, before it, or alone', () => {
  assert.deepEqual(parseAssignments('implementer=tiered:high:long_context, reviewers=tiered:long_context:low, arbiter=tiered:long_context, fixer=tiered:default, all=vendor:model:long_context'), [
    { role: 'implementer', model: 'tiered', effort: 'high', context: 'long_context' },
    { role: 'reviewers', model: 'tiered', effort: 'low', context: 'long_context' },
    { role: 'arbiter', model: 'tiered', effort: undefined, context: 'long_context' },
    { role: 'fixer', model: 'tiered', effort: 'default', context: undefined },
    { role: 'all', model: 'vendor:model', effort: undefined, context: 'long_context' }]);
  // Each suffix counts once; a repeated one stays part of the model ID and is refused as unknown.
  assert.equal(parseAssignments('fixer=tiered:long_context:long_context')[0].model, 'tiered:long_context');
  assert.throws(() => checkChoice(models, 'tiered:long_context'), /not in your Copilot model list/);
  assert.deepEqual(checkChoice(models, 'tiered', 'high', 'long_context'), { model: 'tiered', effort: 'high', context: 'long_context' });
  assert.deepEqual(checkChoice(models, 'tiered', undefined, 'default'), { model: 'tiered', effort: undefined });
  assert.throws(() => checkChoice(models, 'limits-only', undefined, 'long_context'), /limits-only offers no long_context tier/);
  assert.throws(() => checkChoice(models, 'tiered', undefined, 'huge'), /Context must be one of default, long_context/);
});

test('models set records long_context per role, all or nothing, and revokes old reviews', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, fake);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  const file = safePath(f.root, 'migration/config.json'), before = readJSON(file);
  assert.throws(() => setRoleModels(f.root, models, { assign: 'all=tiered:long_context, fixer=limits-only:long_context' }), /offers no long_context tier/);
  assert.throws(() => setRoleModels(f.root, models, { assign: 'all=tiered', context: 'long_context' }), /either/);
  assert.deepEqual(readJSON(file), before, 'a refused answer writes nothing');
  const result = setRoleModels(f.root, models, { assign: 'all=tiered:high, reviewers=tiered:low:long_context, arbiter=declared:long_context' });
  const written = readJSON(file);
  assert.deepEqual(written.contextTiers, { 'reviewer-semantics': 'long_context', 'reviewer-rules': 'long_context', arbiter: 'long_context' });
  assert.equal(result.assignments.find(a => a.role === 'arbiter').context, 'long_context');
  assert.equal(result.assignments.find(a => a.role === 'implementer').context, 'default');
  assert.match(modelsMarkdown(models, written, 'en'), /\| reviewer-rules \| `tiered` \| low \| long_context \|/);
  assert.match(modelsMarkdown(models, written, 'ja'), /\| implementer \| `tiered` \| high \| 既定 \|/);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, loadConfig(f.root))), false, 'a new context tier means a new review');
  // Leaving the suffix out returns a role to the default tier; the key goes when empty.
  setRoleModels(f.root, models, { role: 'reviewers', model: 'tiered', effort: 'low' });
  setRoleModels(f.root, models, { role: 'arbiter', model: 'tiered', context: 'default' });
  assert.equal(readJSON(file).contextTiers, undefined);
  setRoleModels(f.root, models, { role: 'fixer', model: 'tiered', context: 'long_context' });
  assert.deepEqual(readJSON(file).contextTiers, { fixer: 'long_context' });
});

test('the surveyor inherits the implementer\'s tier like its effort, and all resets it', async t => {
  const f = await ready(t);
  setRoleModels(f.root, models, { assign: 'all=tiered, implementer=tiered:long_context' });
  assert.equal(workerContext(loadConfig(f.root), 'surveyor'), 'long_context');
  setRoleModels(f.root, models, { role: 'surveyor', model: 'limits-only' });
  assert.equal(workerContext(loadConfig(f.root), 'surveyor'), undefined, 'a surveyor with its own model never inherits a tier it may lack');
  setRoleModels(f.root, models, { role: 'surveyor', model: 'declared', context: 'long_context' });
  setRoleModels(f.root, models, { assign: 'all=tiered' });
  const config = loadConfig(f.root);
  assert.equal(config.contextTiers, undefined);
  assert.deepEqual(currentAssignments(config).map(a => a.context), Array(6).fill('default'));
  // The effective combination is checked, inheritance included.
  const raw = readJSON(safePath(f.root, 'migration/config.json'));
  raw.models.implementer = 'limits-only'; raw.contextTiers = { implementer: 'long_context' };
  fs.writeFileSync(safePath(f.root, 'migration/config.json'), JSON.stringify(raw));
  assert.throws(() => setRoleModels(f.root, models, { role: 'fixer', model: 'tiered' }), /implementer would run limits-only with the long_context tier/);
});

test('config accepts only long_context entries for worker roles', () => {
  validateContextTiers({});
  validateContextTiers({ contextTiers: { implementer: 'long_context', surveyor: 'long_context' } });
  assert.throws(() => validateContextTiers({ contextTiers: { implementer: 'default' } }), /must be long_context/);
  assert.throws(() => validateContextTiers({ contextTiers: { planner: 'long_context' } }), /not a worker role/);
  assert.throws(() => validateContextTiers({ contextTiers: ['long_context'] }), /must map worker roles/);
});

test('--context reaches only the workers that chose long_context', async t => {
  const plain = copilotArgs('implementer', 'tiered', undefined, null, null, { effort: 'high' });
  assert.equal(plain.includes('--context'), false, 'the default tier passes no flag');
  const long = copilotArgs('implementer', 'tiered', undefined, null, null, { effort: 'high', context: 'long_context' });
  assert.deepEqual(long.slice(long.indexOf('--model'), long.indexOf('--model') + 6), ['--model', 'tiered', '--reasoning-effort', 'high', '--context', 'long_context']);
  // doctor only demands --context from the CLI when some role uses it.
  assert.equal(requiredCopilotFlags(undefined, {}).includes('--context'), false);
  assert.ok(requiredCopilotFlags(undefined, { contextTiers: { fixer: 'long_context' } }).includes('--context'));
  // End to end through the adapter: a call carries the flag only when its role chose it.
  const f = await ready(t);
  const adapter = createCopilotAdapter(cliDouble(f));
  const long1 = await adapter({ root: f.root, config: { ...f.config, contextTiers: { implementer: 'long_context' } }, role: 'implementer', unit: f.units[0] });
  const other = await adapter({ root: f.root, config: { ...f.config, contextTiers: { fixer: 'long_context' } }, role: 'implementer', unit: f.units[0] });
  assert.equal(long1.requestedContext, 'long_context');
  assert.equal(other.requestedContext, undefined);
  const [first, second] = fs.readFileSync(safePath(f.root, 'cli-double-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map(c => c.argv);
  assert.equal(first[first.indexOf('--context') + 1], 'long_context');
  assert.equal(second.includes('--context'), false);
});

test('recording a context tier goes through the same human gate', () => {
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs models set --assign "all=tiered:high:long_context"'), 'models set');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-gate-'));
  try {
    fs.mkdirSync(path.join(root, 'migration'));
    fs.writeFileSync(path.join(root, 'migration/config.json'), '{}');
    const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'node migration-kit/scripts/run_migration.mjs models set --role fixer --model tiered --context long_context' }, cwd: root });
    assert.equal(decision.decision, 'ask');
    assert.match(decision.reason, /context \(long_context costs more\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('records name the requested tier; a host-chosen override and a leftover suffix stay clear', async t => {
  const f = prepare(t), file = safePath(f.root, 'migration/config.json');
  const config = { ...f.config, contextTiers: { implementer: 'long_context' } };
  fs.writeFileSync(file, JSON.stringify({ ...readJSON(file), contextTiers: config.contextTiers }));
  await runStage(f.root, config, 'judge');
  approve(f.root, config, 'translation', 'Automated fixture approval for tests only');
  const report = await translate(f.root, config, fake);
  const runDir = safePath(f.root, `migration/runs/${report.runId}`);
  const attempts = fs.readdirSync(runDir).filter(n => n.endsWith('.json') && n !== 'summary.json').map(n => readJSON(path.join(runDir, n)));
  assert.equal(attempts.find(a => a.role === 'implementer').requestedContext, 'long_context');
  assert.ok(attempts.filter(a => a.role !== 'implementer').every(a => a.requestedContext === undefined));
  // A preparation audit's host-chosen model keeps that model's own default context.
  const adapter = createCopilotAdapter(cliDouble(f));
  const response = await adapter({ root: f.root, config, role: 'implementer', unit: f.units[0], model: 'audit-model' });
  assert.equal(response.requestedContext, undefined);
  const argv = fs.readFileSync(safePath(f.root, 'cli-double-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1).argv;
  assert.equal(argv.includes('--context'), false);
  assert.throws(() => setRoleModels(f.root, models, { assign: 'fixer=tiered:high:default' }), /tiered:high is not in your Copilot model list \(write ID\[:EFFORT\]\[:long_context\]/);
  // --role all with a tier gives every role, the surveyor through the implementer, the same tier.
  setRoleModels(f.root, models, { role: 'surveyor', model: 'declared' });
  setRoleModels(f.root, models, { role: 'all', model: 'tiered', context: 'long_context' });
  const all = loadConfig(f.root);
  assert.equal(all.contextTiers.surveyor, undefined);
  assert.deepEqual(currentAssignments(all).map(a => a.context), Array(6).fill('long_context'));
});
