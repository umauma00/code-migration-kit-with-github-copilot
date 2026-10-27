// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ready, prepare, fake } from './helpers.mjs';
import { kitRoot, install } from '../scripts/install.mjs';
import { safePath, writeJSON, readJSON, loadConfig, filesUnder } from '../lib/core.mjs';
import { translate } from '../lib/pipeline.mjs';
import { reviewInput } from '../lib/review.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';
import { agentMetadata } from '../lib/runtime.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { failureGuidance } from '../lib/guidance.mjs';

test('worker profiles, the preparation auditor included, stay out of the picker and the task tool', () => {
  for (const dir of ['.github/agents', 'com.github.copilot/agents']) for (const name of fs.readdirSync(path.join(kitRoot, dir))) {
    const front = agentMetadata(fs.readFileSync(path.join(kitRoot, dir, name), 'utf8'), name);
    if (name.includes('orchestrator')) { assert.equal(front['user-invocable'], undefined, name); continue; }
    assert.equal(front['user-invocable'], false, name);
    assert.ok(!name.includes('-native-'), `removed native profile still shipped: ${name}`);
    // A tool-free auditor reached through a task tool gets a path or a retyped
    // body, never the exact frozen request; only audit_inputs.mjs run starts it.
    assert.equal(front['disable-model-invocation'], true, name);
  }
});

test('the orchestrator is the only entry point: skills leave the slash menu but stay loadable', t => {
  for (const file of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md', 'skills/depmap-adapter/SKILL.md', '.github/skills/depmap-adapter/SKILL.md']) {
    const front = agentMetadata(fs.readFileSync(path.join(kitRoot, file), 'utf8'), file);
    assert.equal(front['user-invocable'], false, file);
    // Copilot CLI reports "Skill not found" for every invocation of such a skill
    // (github/copilot-cli#4438), so the orchestrator could no longer load it.
    assert.equal(front['disable-model-invocation'], undefined, file);
  }
  for (const file of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8');
    assert.match(text, /`migration-orchestrator`/, file);
    assert.match(text, /`code-migration-plugin-orchestrator`/, file);
    assert.match(text.replace(/\s+/g, ' '), /do not start, resume or approve migration phases/, file);
    const depmap = text.match(/\[depmap-adapter skill\]\(([^)]+)\)/)?.[1];
    assert.ok(depmap && fs.existsSync(path.join(kitRoot, path.dirname(file), depmap)), `${file} must link the hidden depmap-adapter skill`);
    assert.doesNotMatch(text, /Use the plugin's code-migration-plugin-orchestrator agent/, file);
    assert.match(text.replace(/\s+/g, ' '), /A subagent started by the orchestrator is not such an agent/, file);
    assert.match(text.replace(/\s+/g, ' '), /`\.github\/prompts\/migrate-\*\.prompt\.md` files .* propose deleting them/, file);
  }
  assert.equal(fs.existsSync(path.join(kitRoot, '.github/prompts')), false, 'phase prompt files would add slash commands');
  const skillLink = (text, file) => {
    const link = text.match(/\[the code-migration skill\]\(([^)]+)\)/)?.[1];
    assert.ok(link, `${file} must link the hidden skill`);
    assert.ok(text.indexOf(link) < text.indexOf('Use the phase prompts'), `${file} must read the skill first`);
    return path.join(path.dirname(file), link);
  };
  for (const file of ['.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md']) {
    assert.ok(agentMetadata(fs.readFileSync(path.join(kitRoot, file), 'utf8'), file).tools.includes('skill'), `${file} needs the skill tool fallback`);
  }
  for (const [file, skill] of [['.github/agents/migration-orchestrator.agent.md', '.github/skills/code-migration/SKILL.md'],
    ['com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md', 'skills/code-migration/SKILL.md']]) {
    assert.equal(path.normalize(skillLink(fs.readFileSync(path.join(kitRoot, file), 'utf8'), file)), path.normalize(skill), file);
  }
  const guarded = text => assert.match(text.replace(/\s+/g, ' '), /only in the `migration-orchestrator` agent.*Other agents never start, resume or approve phases\. A subagent the orchestrator starts returns its plan and status to it/);
  guarded(fs.readFileSync(path.join(kitRoot, '.github/copilot-instructions.md'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-point-')), plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-plugin-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  install(root, { apply: true, model: 'test-double' });
  assert.equal(fs.existsSync(path.join(root, '.github/prompts')), false);
  const agent = '.github/agents/migration-orchestrator.agent.md';
  assert.equal(path.normalize(skillLink(fs.readFileSync(path.join(root, agent), 'utf8'), agent)), path.normalize('.github/skills/code-migration/SKILL.md'));
  for (const skill of ['code-migration', 'depmap-adapter']) {
    const file = `.github/skills/${skill}/SKILL.md`;
    assert.equal(agentMetadata(fs.readFileSync(path.join(root, file), 'utf8'), file)['user-invocable'], false, `installed ${file}`);
  }
  assert.ok(fs.existsSync(path.join(root, '.github/skills/depmap-adapter/SKILL.md')), 'installed skill must reach the installed depmap-adapter skill');
  assert.match(install(root, {}).next, /migration-orchestrator/);
  guarded(fs.readFileSync(path.join(root, '.github/copilot-instructions.md'), 'utf8'));
  assert.match(install(plugin, { layout: 'plugin' }).next, /code-migration-plugin-orchestrator/);
});

test('current documents no longer offer the removed slash entry points', () => {
  // History (CHANGELOG, reviews, plans, validation) and upgrade notes may name them.
  const history = /^(CHANGELOG\.md|docs\/(reviews|plans|validation)\/|docs\/UPGRADING(\.en)?\.md$)/;
  const files = ['README.md', 'README.en.md', ...filesUnder(kitRoot, 'docs'), ...filesUnder(kitRoot, '.github'), ...filesUnder(kitRoot, 'skills'), ...filesUnder(kitRoot, 'com.github.copilot')]
    .filter(f => /\.(md|json)$/.test(f) && !history.test(f));
  for (const file of files) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8');
    assert.doesNotMatch(text, /`\/code-migration`|\/migrate-0/, file);
  }
});

test('hook configurations allow 30 seconds because Copilot hooks fail open on timeout', () => {
  for (const file of ['templates/hooks.copilot.json', '.github/hooks/code-migration.json', 'com.github.copilot/hooks/hooks.json']) {
    assert.equal(readJSON(path.join(kitRoot, file)).hooks.preToolUse[0].timeoutSec, 30, file);
  }
  assert.equal(readJSON(path.join(kitRoot, 'templates/hooks.vscode-local.json')).hooks.PreToolUse[0].timeout, 30);
});

test('doctor times the hook', async t => {
  const f = prepare(t);
  const report = await doctor(f.root, f.config);
  const hook = report.checks.find(c => c.check === 'hook responds before its timeout');
  assert.equal(hook.ok, true);
  assert.equal(hook.timeoutSec, 30);
  assert.ok(Number.isInteger(hook.durationMs));
  assert.equal(report.workerBackend, 'copilot-cli');
  assert.equal(report.checks.some(c => /native/.test(c.check)), false);
});

test('prompts put shared rules first and the unit-specific target last for prompt caching', t => {
  const f = prepare(t, { count: 2 });
  for (const u of f.units) { fs.mkdirSync(path.dirname(safePath(f.root, u.target)), { recursive: true }); fs.writeFileSync(safePath(f.root, u.target), '// candidate\n// PORT STATUS: todos=0\n'); }
  const inputs = f.units.map(u => JSON.parse(reviewInput(f.root, f.config, u).text));
  for (const input of inputs) {
    assert.equal(Object.keys(input)[1], 'files');
    assert.equal(input.files[0].path, 'migration/RULEBOOK.md');
  }
  const prompts = f.units.map(u => agentPrompt({ role: 'reviewer-rules', unit: u, reviewInput: reviewInput(f.root, f.config, u).text }));
  for (const [i, prompt] of prompts.entries()) assert.ok(prompt.trimEnd().endsWith(`Set target to ${JSON.stringify(f.units[i].target)}.`));
  // Two units of one role share everything up to and including the full rulebook.
  let common = 0;
  while (prompts[0][common] === prompts[1][common]) common++;
  const rulebook = JSON.stringify(fs.readFileSync(safePath(f.root, 'migration/RULEBOOK.md'), 'utf8'));
  assert.ok(prompts[0].slice(0, common).includes(rulebook.slice(1, -1)), 'shared prefix covers the rulebook');
});

test('a run stops cleanly at maxRunInputBytes and reports measured bytes with estimated tokens', async t => {
  const f = await ready(t, { count: 3 });
  Object.assign(f.config, { maxRunInputBytes: 1024, concurrency: 1 });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const { approve, runStage } = await import('../lib/pipeline.mjs');
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Budget fixture');
  const sized = async options => ({ ...(await fake(options)), promptBytes: 2048, responseBytes: 400 });
  await assert.rejects(translate(f.root, f.config, sized), /Run input budget \(maxRunInputBytes\) reached/);
  const runs = fs.readdirSync(safePath(f.root, 'migration/runs'));
  const summary = readJSON(safePath(f.root, `migration/runs/${runs.sort().at(-1)}/summary.json`));
  assert.equal(summary.usageEstimate.promptBytes, 2048);
  assert.equal(summary.usageEstimate.estimatedInputTokens, 512);
  assert.match(summary.usageEstimate.basis, /not measured/);
  assert.equal(failureGuidance('Translation stopped: ported/a.mjs: Run input budget (maxRunInputBytes) reached; resume', { language: 'ja' }).id, 'input-budget');
  assert.equal(failureGuidance('Copilot implementer failed (exit 1): Your AI Credits budget has been exhausted', { language: 'en' }).id, 'credits');
  assert.throws(() => { writeJSON(safePath(f.root, 'migration/config.json'), { ...f.config, maxRunInputBytes: 10 }); loadConfig(f.root); }, /maxRunInputBytes/);
});
