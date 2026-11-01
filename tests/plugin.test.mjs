import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { install, kitRoot } from '../scripts/install.mjs';
import { ready, prepare, cliDouble, fake, nodeCli } from './helpers.mjs';
import { contextHash, loadConfig, readJSON, safePath, done } from '../lib/core.mjs';
import { runtimeLayout } from '../lib/runtime.mjs';
import { validateWorkerProfile } from '../lib/review.mjs';
import { translate, approve, runStage, requireGate } from '../lib/pipeline.mjs';
import { createCopilotAdapter, requiredCopilotFlags } from '../scripts/copilot_adapter.mjs';
import { doctor } from '../scripts/run_migration.mjs';

test('plugin initialization previews only project artifacts and preserves existing decisions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-plugin-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { layout: 'plugin', model: 'chosen-model' };
  assert.deepEqual(install(root, options).changes.sort(), ['migration/RULEBOOK.md', 'migration/config.json', 'migration/inventory.tsv']);
  assert.deepEqual(fs.readdirSync(root), []);
  install(root, { ...options, apply: true });
  const before = fs.readFileSync(path.join(root, 'migration/config.json'), 'utf8');
  assert.equal(JSON.parse(before).runtime, 'plugin');
  assert.equal(JSON.parse(before).models.implementer, 'chosen-model');
  assert.deepEqual(install(root, { ...options, model: 'different-model', apply: true }).changes, []);
  assert.equal(fs.readFileSync(path.join(root, 'migration/config.json'), 'utf8'), before);
  assert.throws(() => install(root, { apply: true }), /reconcile/);
  assert.deepEqual(fs.readdirSync(root), ['migration']);
});

test('plugin initialization rejects a repository layout and unsafe destinations before writing', t => {
  const f = prepare(t);
  assert.throws(() => install(f.root, { layout: 'plugin', apply: true }), /reconcile/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-plugin-conflict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'migration/inventory.tsv'), { recursive: true });
  assert.throws(() => install(root, { layout: 'plugin', apply: true }), /regular file/);
  assert.equal(fs.existsSync(path.join(root, 'migration/config.json')), false);
  assert.throws(() => install(root, { layout: 'plugin', withWorkflow: true }), /experimental/);
});

test('plugin queue and real fixture validation complete without a copied runtime or project agents', async t => {
  const f = await ready(t, { layout: 'plugin', count: 3, realCommands: true });
  assert.equal(fs.existsSync(path.join(f.root, '.github')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'migration-kit')), false);
  const result = await translate(f.root, f.config, createCopilotAdapter(cliDouble(f)));
  assert.equal(result.done, 3);
  const calls = fs.readFileSync(path.join(f.root, 'cli-double-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 9);
  for (const call of calls) {
    assert.equal(call.argv[call.argv.indexOf('--plugin-dir') + 1], kitRoot);
    assert.equal(call.argv[call.argv.indexOf('--agent') + 1], `code-migration-kit:code-migration-plugin-${call.role}`);
    assert.ok(call.argv.includes('--no-custom-instructions'));
    if (call.role.startsWith('reviewer-')) assert.equal(call.argv[call.argv.indexOf('--deny-tool') + 1], 'read,write,shell');
  }
  for (const stage of ['build', 'smoke', 'parity']) {
    approve(f.root, f.config, stage, 'Explicit test-fixture approval');
    await runStage(f.root, f.config, stage);
  }
  assert.equal((await doctor(f.root, f.config)).ok, true);
});

test('plugin profiles allow unqualified names but reject aliases in project and ancestor agents', t => {
  const f = prepare(t, { layout: 'plugin' });
  validateWorkerProfile(f.root, 'reviewer-rules', f.config);
  const profile = safePath(f.root, '.github/agents/code-migration-plugin-reviewer-rules.agent.md');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, '---\nname: code-migration-plugin-reviewer-rules\ndescription: Noncolliding local profile\ntools: [view]\n---\n');
  assert.doesNotThrow(() => validateWorkerProfile(f.root, 'reviewer-rules', f.config));
  fs.unlinkSync(profile);
  const nested = path.join(f.root, 'nested'); fs.mkdirSync(nested);
  fs.writeFileSync(profile, '---\nname: code-migration-kit:code-migration-plugin-reviewer-rules\ndescription: Local alias\ntools: []\n---\n');
  assert.throws(() => validateWorkerProfile(nested, 'reviewer-rules', f.config), /shadowed/);
});

test('plugin profiles reject quoted, escaped, folded and aliased names in nested Markdown files', t => {
  const f = prepare(t, { layout: 'plugin' });
  const id = runtimeLayout(f.root, f.config).agentId('reviewer-rules');
  const file = safePath(f.root, '.github/agents/team/other.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const variants = [
    `name: '${id}'`, `"name": "${id}"`,
    `name: "${id.replace('kit:', 'ki\\u0074:')}"`,
    `name: >-\n  ${id}`, `alias: &agent ${id}\nname: *agent`,
    `{name: '${id}', description: local, tools: []}`
  ];
  for (const front of variants) {
    fs.writeFileSync(file, `\uFEFF---\r\n${front}\n${front.startsWith('{') ? '' : 'description: local\ntools: []\n'}---\nBody`);
    assert.throws(() => validateWorkerProfile(f.root, 'reviewer-rules', f.config), /shadowed/, front);
  }
  fs.writeFileSync(file, `---\nname: '${id.toUpperCase()}'\ndescription: case-sensitive name\ntools: []\n---\n`);
  assert.doesNotThrow(() => validateWorkerProfile(f.root, 'reviewer-rules', f.config));
});

test('plugin profiles check personal and Claude agents and reject unreadable name definitions', t => {
  const f = prepare(t, { layout: 'plugin' }), id = runtimeLayout(f.root, f.config).agentId('reviewer-rules');
  const saved = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = path.join(f.root, 'personal-home');
  t.after(() => { if (saved === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = saved; });
  for (const directory of ['personal-home/agents/nested', '.claude/agents/nested']) {
    const file = safePath(f.root, `${directory}/alias.agent.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: '${id}'\ndescription: local alias\ntools: []\n---\n`);
    assert.throws(() => validateWorkerProfile(f.root, 'reviewer-rules', f.config), /shadowed/);
    fs.unlinkSync(file);
  }
  const file = safePath(f.root, '.github/agents/bad.agent.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: *unresolvedAlias\ndescription: invalid\n---\n');
  assert.throws(() => validateWorkerProfile(f.root, 'reviewer-rules', f.config), /Cannot verify agent frontmatter/);
});

test('plugin alias is rejected by doctor and adapter before any CLI process or output write', async t => {
  const f = prepare(t, { layout: 'plugin' });
  const file = safePath(f.root, '.github/agents/other.agent.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: code-migration-kit:code-migration-plugin-implementer\ndescription: local alias\ntools: [view]\n---\n');
  const report = await doctor(f.root, f.config);
  assert.equal(report.ok, false);
  assert.match(report.checks.find(c => c.check === 'implementer: model and tools').detail, /shadowed/);
  const adapter = createCopilotAdapter(cliDouble(f));
  await assert.rejects(adapter({ ...f, role: 'implementer', unit: f.units[0] }), /shadowed/);
  assert.equal(fs.existsSync(safePath(f.root, 'cli-double-calls.jsonl')), false);
  assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false);
});

test('project hook creation, edit and removal invalidate plugin approvals and completion', async t => {
  for (const change of ['create', 'edit', 'remove']) {
    const f = prepare(t, { layout: 'plugin' });
    const file = safePath(f.root, '.github/hooks/context.json');
    const content = JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'node -e "console.log(1)"' }] } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (change !== 'create') fs.writeFileSync(file, content);
    await runStage(f.root, f.config, 'judge');
    approve(f.root, f.config, 'translation', 'Explicit test-fixture approval');
    await translate(f.root, f.config, fake);
    const before = contextHash(f.root, f.config);
    assert.equal(done(f.root, f.units[0], before), true);
    if (change === 'remove') fs.unlinkSync(file);
    else fs.writeFileSync(file, change === 'edit' ? content.replace('console.log(1)', 'console.log(2)') : content);
    const after = contextHash(f.root, f.config);
    assert.notEqual(after, before, change);
    assert.equal(done(f.root, f.units[0], after), false, change);
    assert.throws(() => requireGate(f.root, f.config, 'translation', after), /approval|approve|changed/i, change);
    let calls = 0;
    await assert.rejects(translate(f.root, f.config, async args => { calls++; return fake(args); }), /approval|approve|changed/i);
    assert.equal(calls, 0);
  }
});

test('project agent changes invalidate plugin approvals and completed receipts', async t => {
  const f = await ready(t, { layout: 'plugin' });
  await translate(f.root, f.config, fake);
  const before = contextHash(f.root, f.config);
  const file = safePath(f.root, '.github/agents/other.agent.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: code-migration-kit:code-migration-plugin-reviewer-rules\ndescription: alias after completion\ntools: [view]\n---\n');
  const after = contextHash(f.root, f.config);
  assert.notEqual(after, before);
  assert.equal(done(f.root, f.units[0], after), false);
  assert.throws(() => requireGate(f.root, f.config, 'translation', after), /approval|approve|changed/i);
});

test('plugin doctor requires mounting support and config rejects an unknown runtime', async t => {
  const f = prepare(t, { layout: 'plugin' });
  const layout = runtimeLayout(f.root, f.config);
  assert.ok(requiredCopilotFlags(layout).includes('--plugin-dir'));
  assert.throws(() => runtimeLayout(kitRoot, f.config), /outside/);
  const file = nodeCli(safePath(f.root, 'cli-help.mjs'), `console.log(${JSON.stringify(requiredCopilotFlags().join(' '))});\n`);
  const report = await doctor(f.root, f.config, { checkCLI: true, command: file });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.find(c => c.check === 'required flags').missing, ['--plugin-dir']);
  const config = readJSON(safePath(f.root, 'migration/config.json')); config.runtime = 'other';
  fs.writeFileSync(safePath(f.root, 'migration/config.json'), JSON.stringify(config));
  assert.throws(() => loadConfig(f.root), /runtime must/);
});

test('plugin runtime fingerprints survive relocation and a plugin update (the kit is not an input)', async t => {
  const f = prepare(t, { layout: 'plugin' }), before = contextHash(f.root, f.config);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-plugin-package-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const dir of ['lib', 'scripts', 'prompts', 'docs', 'templates', 'skills', 'com.github.copilot']) fs.cpSync(path.join(kitRoot, dir), path.join(copy, dir), { recursive: true });
  for (const file of ['plugin.json', 'package.json']) fs.copyFileSync(path.join(kitRoot, file), path.join(copy, file));
  const copiedCore = await import(pathToFileURL(path.join(copy, 'lib/core.mjs')).href);
  assert.equal(copiedCore.contextHash(f.root, f.config), before);
  // 0.40.0: a plugin update keeps phases, approvals and finished units, as
  // upstream; the project's own agents and hooks stay inputs (tests above).
  fs.appendFileSync(path.join(copy, 'com.github.copilot/agents/code-migration-plugin-implementer.agent.md'), '\nUpdated translation rules.\n');
  fs.appendFileSync(path.join(copy, 'lib/markers.mjs'), '\n// updated\n');
  assert.equal(copiedCore.contextHash(f.root, f.config), before);
});
