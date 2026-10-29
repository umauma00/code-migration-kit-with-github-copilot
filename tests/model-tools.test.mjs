// SPDX-License-Identifier: Apache-2.0
// Model families get different file tools from the Copilot CLI (1.0.105:
// gpt-6-luna has view, rg, glob and apply_patch; gpt-4.1 has view, grep, glob,
// create and edit), and --available-tools drops unknown names silently. The kit
// reads a model's tools from a loopback model provider (no AI usage) to build
// comparison B's command and to check worker models in doctor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare, nodeCli } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { writeJSON, readJSON, safePath, loadConfig } from '../lib/core.mjs';
import { stressBTools, stressBCommand } from '../scripts/copilot_adapter.mjs';
import { stressB, modelToolChecks } from '../scripts/run_migration.mjs';
import { runtimeLayout } from '../lib/runtime.mjs';
import { failureGuidance, doctorGuidance } from '../lib/guidance.mjs';

// A CLI double that asks the configured provider once, with the tools its
// model family has, narrowed by --available-tools the way the real CLI does.
function fakeCli(dir) {
  return nodeCli(path.join(dir, 'fake-copilot.mjs'), `
const argv = process.argv.slice(2), at = name => argv[argv.indexOf(name) + 1];
const model = at('--model') ?? process.env.COPILOT_MODEL;
if (model === 'no-request') { console.error('fails before any request'); process.exit(1); }
let tools = model.startsWith('gpt-6') ? ['bash', 'apply_patch', 'view', 'rg', 'glob', 'skill'] : model === 'read-only' ? ['view', 'glob'] : ['bash', 'view', 'create', 'edit', 'grep', 'glob', 'skill'];
if (argv.includes('--available-tools')) {
  const wanted = at('--available-tools').split(',').map(n => n === 'grep' && tools.includes('rg') ? 'rg' : n);
  tools = tools.filter(n => wanted.includes(n));
}
const body = JSON.stringify({ model, messages: [], tools: tools.map(n => n === 'apply_patch' ? { type: 'custom', custom: { name: n } } : { type: 'function', function: { name: n } }) });
const res = await fetch(process.env.COPILOT_PROVIDER_BASE_URL + '/chat/completions', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
await res.text();
`);
}
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tools-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('comparison B gets the file tools the model really has, and at least one that writes', async t => {
  const cli = fakeCli(tmp(t));
  const luna = await stressBTools(cli, 'gpt-6-luna');
  assert.equal(luna.verified, true);
  assert.deepEqual(luna.tools, ['view', 'glob', 'rg', 'apply_patch']);
  const classic = await stressBTools(cli, 'gpt-4.1');
  assert.deepEqual(classic.tools, ['view', 'glob', 'grep', 'create', 'edit']);
  for (const found of [luna, classic]) assert.ok(!found.tools.includes('skill') && !found.tools.includes('bash'), 'B never gets skills or a shell');
  await assert.rejects(stressBTools(cli, 'read-only'), /model read-only has no file-writing tool/);
  assert.equal(failureGuidance('Comparison B: model read-only has no file-writing tool in this Copilot CLI (it offers view, glob).', { language: 'ja' }).id, 'model-tools');
});

test('a CLI that makes no loopback request leaves the tools unverified and still gives a command, never a stop', async t => {
  const found = await stressBTools(fakeCli(tmp(t)), 'no-request');
  assert.equal(found.verified, false);
  assert.deepEqual(found.tools, ['view', 'create', 'edit', 'apply_patch', 'glob', 'grep']);
  assert.match(found.detail, /no model request/);
});

test('the B command quotes for bash and PowerShell and keeps the isolation flags', () => {
  const c = stressBCommand({ model: 'gpt-6-luna', dir: "/tmp/bake off/it's", targetLanguage: 'Java', tools: ['view', 'apply_patch'] });
  assert.deepEqual(c.argv.slice(2), ['--model', 'gpt-6-luna', '--no-custom-instructions', '--disable-builtin-mcps', '-s', '--available-tools', 'view,apply_patch', '--allow-tool', 'write']);
  assert.match(c.bash, /^cd '\/tmp\/bake off\/it'\\''s' && copilot -p 'Port these files to Java /);
  assert.match(c.powershell, /^Set-Location '\/tmp\/bake off\/it''s'; & copilot -p 'Port these files to Java /);
});

test('stress-b command refuses a directory inside the repository and runs from the runner', async t => {
  const f = prepare(t), cli = fakeCli(tmp(t)), outside = tmp(t);
  const config = { ...f.config, targetLanguage: 'TypeScript', phaseModels: { stressB: 'gpt-6-luna' } };
  await assert.rejects(stressB(f.root, config, { dir: path.join(f.root, 'src'), command: cli }), /inside the repository/);
  await assert.rejects(stressB(f.root, config, { dir: 'relative/dir', command: cli }), /absolute path/);
  await assert.rejects(stressB(f.root, config, { dir: path.join(outside, 'missing'), command: cli }), /not a directory/);
  const result = await stressB(f.root, config, { dir: outside, command: cli });
  assert.equal(result.model, 'gpt-6-luna');
  assert.ok(result.tools.includes('apply_patch'));
  assert.match(result.bash, /--available-tools view,glob,rg,apply_patch --allow-tool write$/);
  // Through the runner, with the model named on the command line.
  const file = safePath(f.root, 'migration/config.json');
  writeJSON(file, { ...readJSON(file), targetLanguage: 'TypeScript' });
  const r = spawnSync(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), 'stress-b', 'command', '--dir', outside, '--model', 'gpt-4.1', '--copilot', cli, '--root', f.root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).tools, ['view', 'glob', 'grep', 'create', 'edit']);
});

test('doctor checks that tool-assisted reviewers can read and search and that B can write, per model', async t => {
  const f = prepare(t), cli = fakeCli(tmp(t)), layout = runtimeLayout(f.root, f.config);
  const models = role => ({ ...f.config.models, 'reviewer-semantics': role, 'reviewer-rules': 'gpt-4.1', implementer: 'gpt-6-luna' });
  let checks = await modelToolChecks(f.root, { ...f.config, models: models('gpt-6-luna') }, layout, { command: cli });
  assert.deepEqual(checks.map(c => [c.check, c.ok]), [['model tools: reviewer-semantics-read', true], ['model tools: reviewer-rules-read', true], ['model tools: comparison B', true]]);
  assert.deepEqual(checks[0].tools, ['view', 'rg', 'glob']);
  checks = await modelToolChecks(f.root, { ...f.config, models: models('read-only'), phaseModels: { stressB: 'read-only' } }, layout, { command: cli });
  assert.deepEqual(checks.map(c => c.ok), [false, true, false]);
  assert.deepEqual(checks[0].missing, ['grep|rg']);
  const guidance = doctorGuidance({ checks }, { root: f.root, language: 'en' });
  assert.deepEqual(guidance.map(g => g.guidance.id), ['model-tools', 'model-tools']);
  checks = await modelToolChecks(f.root, { ...f.config, models: models('no-request'), phaseModels: { stressB: 'no-request' } }, layout, { command: cli });
  assert.deepEqual(checks.map(c => [c.ok, c.status]), [[true, 'not-verified'], [true, undefined], [true, 'not-verified']]);
});
