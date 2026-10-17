import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { prepare, result, finding } from './helpers.mjs';
import { install, kitRoot } from '../scripts/install.mjs';
import { approve, runStage, translate, requireGate } from '../lib/pipeline.mjs';
import { loadConfig, contextHash, safePath, writeJSON, readJSON, done, unitState, atomicWrite, fileHash, lockRun } from '../lib/core.mjs';
import { createNativeAdapter, listNativeTasks, claimNativeTask, submitNativeTask } from '../lib/native-workers.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { runProcess } from '../lib/process.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { validateNativeProfile } from '../lib/review.mjs';
import { runtimeLayout } from '../lib/runtime.mjs';

async function nativeReady(t, options = {}) {
  const f = prepare(t, options);
  Object.assign(f.config, { workerBackend: 'native', nativeHarness: options.layout === 'plugin' ? 'copilot' : 'vscode-local', timeoutSeconds: 15 });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Native transport fixture only');
  return f;
}
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = fn(); if (value) return value; await delay(10); }
  throw new Error('Test timed out waiting for native task');
}
function start(t, f) {
  const controller = new AbortController();
  let settled = false;
  // Convert rejection immediately, including while the host is doing other work.
  const completion = translate(f.root, f.config, createNativeAdapter({ pollMs: 5 }), { signal: controller.signal })
    .then(report => ({ report }), error => ({ error })).finally(() => { settled = true; });
  t.after(async () => { controller.abort(); await completion; });
  return { controller, completion, settled: () => settled };
}
async function drain(f, run, respond = task => result(task.role, task.unit)) {
  const seen = [];
  while (!run.settled()) {
    for (const descriptor of listNativeTasks(f.root).tasks.filter(t => t.status === 'pending')) {
      const task = claimNativeTask(f.root, descriptor.task);
      seen.push(task);
      submitNativeTask(f.root, task.task, task.claimToken, { result: respond(task), model: task.model });
    }
    await delay(10);
  }
  const completion = await run.completion;
  if (completion.error) throw completion.error;
  return { ...completion.report, seen };
}
const nextTask = f => until(() => listNativeTasks(f.root).tasks.find(t => t.status === 'pending'));

test('runner lock is published complete before native clients can read it', t => {
  const f = prepare(t), lock = safePath(f.root, 'migration/run.lock'), runId = '12345-12345678';
  let observations = 0;
  const inspect = () => {
    observations++;
    const listing = listNativeTasks(f.root);
    assert.equal(listing.running, true);
    assert.equal(listing.runner.runId, runId);
    assert.deepEqual(listing.tasks, []);
  };
  // Simulate a reader immediately after the lock path first becomes visible.
  const open = fs.openSync, link = fs.linkSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args);
    if (file === lock && args[0] === 'wx') {
      try { inspect(); } catch (e) { fs.closeSync(fd); throw e; }
    }
    return fd;
  });
  t.mock.method(fs, 'linkSync', (source, target, ...args) => {
    link(source, target, ...args);
    if (target === lock) inspect();
  });
  const release = lockRun(f.root, 'translation', { runId });
  try {
    assert.equal(observations, 1);
    const original = fileHash(lock);
    assert.throws(() => lockRun(f.root, 'translation', { runId: '67890-abcdef12' }), /Migration locked/);
    assert.equal(fileHash(lock), original);
    assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter(name => name.startsWith('run.lock.')), []);
  } finally { release(); }
  assert.equal(listNativeTasks(f.root).running, false);
});

test('native host runs parallel units, frozen independent reviews and real parity without Copilot CLI', async t => {
  const f = await nativeReady(t, { count: 3, realCommands: true });
  const run = start(t, f);
  await until(() => listNativeTasks(f.root).tasks.filter(t => t.status === 'pending').length === 2);
  const report = await drain(f, run);
  assert.equal(report.done, 3); assert.equal(report.agentCalls, 9);
  for (const unit of f.units) {
    const reviews = report.seen.filter(t => t.unit.id === unit.id && t.role.startsWith('reviewer-'));
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].inputHash, reviews[1].inputHash);
    assert.equal(reviews[0].prompt.split('Frozen review input (JSON task data):\n')[1], reviews[1].prompt.split('Frozen review input (JSON task data):\n')[1]);
    assert.equal(done(f.root, unit, contextHash(f.root, f.config)), true);
    const record = readJSON(safePath(f.root, unitState(f.root, unit).reviews[0]));
    assert.equal(record.workerBackend, 'native'); assert.equal(record.instructionIsolation, 'host-managed');
    assert.equal(record.observedModel, null);
  }
  assert.ok(report.seen.every(t => t.tools.length === 0 && t.agent.startsWith('migration-native-')));
  assert.match(report.seen[0].prompt, /Frozen task input/);
  for (const stage of ['build', 'smoke', 'parity']) {
    approve(f.root, f.config, stage, 'Native transport fixture approval');
    await runStage(f.root, f.config, stage);
  }
  assert.equal((await translate(f.root, f.config, createNativeAdapter())).agentCalls, 0);
});

test('native arbitration, confirmed fixing and re-review use the shared pipeline', async t => {
  const f = await nativeReady(t, { layout: 'plugin' });
  let fixed = false;
  const report = await drain(f, start(t, f), task => {
    if (task.role === 'arbiter') {
      assert.match(task.prompt, /reviewer-semantics:F1/);
      assert.doesNotMatch(task.prompt, /return a changes finding/);
      return result(task.role, task.unit, { decisions: [{ finding: 'reviewer-semantics:F1', confirmed: true, reason: finding.evidence }] });
    }
    if (task.role === 'fixer') { fixed = true; assert.match(task.prompt, /confirmedFindings/); }
    return result(task.role, task.unit, { findings: task.role === 'reviewer-semantics' && !fixed ? [finding] : [] });
  });
  assert.equal(report.done, 1); assert.equal(report.agentCalls, 7);
  assert.ok(report.seen.every(t => t.agent.startsWith('code-migration-kit:code-migration-plugin-native-')));
  const check = await doctor(f.root, f.config, { checkCLI: true, command: '/does/not/exist/copilot' });
  assert.equal(check.staticValid, true); assert.equal(check.ok, false);
  assert.equal(check.executionReady, 'unknown');
  assert.equal(check.checks.some(c => c.check === 'Copilot executable'), false);
});

test('claims and submissions bind the task, model and result and reject duplicate writers', async t => {
  const f = await nativeReady(t), run = start(t, f);
  const descriptor = await nextTask(f), task = claimNativeTask(f.root, descriptor.task);
  assert.throws(() => claimNativeTask(f.root, task.task), /already claimed/);
  const payload = { result: result(task.role, task.unit), model: task.model };
  assert.throws(() => submitNativeTask(f.root, task.task, 'wrong', payload), /token/);
  assert.throws(() => submitNativeTask(f.root, task.task, task.claimToken, { ...payload, model: undefined }), /model/);
  assert.throws(() => submitNativeTask(f.root, task.task, task.claimToken, { ...payload, model: 'substituted' }), /model/);
  assert.throws(() => submitNativeTask(f.root, task.task, task.claimToken, { ...payload, result: { ...payload.result, target: 'ported/wrong.mjs' } }), /target/);
  submitNativeTask(f.root, task.task, task.claimToken, payload);
  assert.throws(() => submitNativeTask(f.root, task.task, task.claimToken, payload), /already submitted/);
  assert.equal((await drain(f, run)).done, 1);
  assert.throws(() => submitNativeTask(f.root, task.task, task.claimToken, payload), /inactive|closed/);
  assert.throws(() => claimNativeTask(f.root, '../../config.json'), /Invalid native task/);
});

test('input changes and edited requests cannot be accepted or written to output', async t => {
  for (const mode of ['source', 'candidate', 'request']) {
    const f = await nativeReady(t), run = start(t, f);
    const task = claimNativeTask(f.root, (await nextTask(f)).task);
    if (mode === 'source') fs.appendFileSync(safePath(f.root, f.units[0].source), '\n# changed\n');
    if (mode === 'candidate') atomicWrite(safePath(f.root, f.units[0].target), '// external change\n');
    if (mode === 'request') {
      const [id, job] = task.task.split('/'), file = safePath(f.root, `migration/runs/${id}/native/${job}/request.json`);
      writeJSON(file, { ...readJSON(file), prompt: 'tampered prompt' });
    }
    assert.throws(() => submitNativeTask(f.root, task.task, task.claimToken, { result: result(task.role, task.unit), model: task.model }), /changed|hash mismatch/);
    run.controller.abort(); assert.ok((await run.completion).error);
    if (mode !== 'candidate') assert.equal(fileHash(safePath(f.root, f.units[0].target)), null);
  }
});

test('cancelled tasks cannot submit to a resumed run and incomplete output is reviewed again', async t => {
  const f = await nativeReady(t), run = start(t, f);
  const first = claimNativeTask(f.root, (await nextTask(f)).task);
  submitNativeTask(f.root, first.task, first.claimToken, { result: result(first.role, first.unit), model: first.model });
  const oldReview = claimNativeTask(f.root, (await nextTask(f)).task);
  run.controller.abort(); assert.ok((await run.completion).error);
  assert.equal(listNativeTasks(f.root).running, false);
  const resumed = start(t, f);
  await nextTask(f);
  assert.throws(() => submitNativeTask(f.root, oldReview.task, oldReview.claimToken, { result: result(oldReview.role, oldReview.unit), model: oldReview.model }), /inactive|closed/);
  const report = await drain(f, resumed);
  assert.equal(report.done, 1); assert.equal(report.agentCalls, 2);
});

test('native resume ignores corrupt requests from older runs, including unclosed tasks', async t => {
  const f = await nativeReady(t), previous = start(t, f);
  const old = claimNativeTask(f.root, (await nextTask(f)).task);
  previous.controller.abort(); assert.ok((await previous.completion).error);
  const [id, job] = old.task.split('/');
  const request = safePath(f.root, `migration/runs/${id}/native/${job}/request.json`);
  atomicWrite(request, '{truncated');
  const run = start(t, f);
  // Closed tasks and leftovers from a hard crash must both be irrelevant.
  assert.notEqual((await nextTask(f)).task, old.task);
  fs.rmSync(safePath(f.root, `migration/runs/${id}/native/${job}/closed.json`));
  assert.equal((await drain(f, run)).done, 1);
});

test('corrupt active requests remain errors and never produce completion', async t => {
  const f = await nativeReady(t), run = start(t, f);
  const task = claimNativeTask(f.root, (await nextTask(f)).task);
  const [id, job] = task.task.split('/');
  atomicWrite(safePath(f.root, `migration/runs/${id}/native/${job}/request.json`), '{truncated');
  assert.throws(() => listNativeTasks(f.root));
  assert.throws(() => submitNativeTask(f.root, task.task, task.claimToken, { result: result(task.role, task.unit), model: task.model }));
  run.controller.abort(); assert.ok((await run.completion).error);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
});

test('native timeout and explicit host failure close tasks without completing units', async t => {
  for (const timeout of [true, false]) {
    const f = prepare(t);
    Object.assign(f.config, { workerBackend: 'native', nativeHarness: 'vscode-local', timeoutSeconds: 1 });
    writeJSON(safePath(f.root, 'migration/config.json'), f.config);
    await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture only');
    const run = start(t, f), task = claimNativeTask(f.root, (await nextTask(f)).task);
    if (!timeout) submitNativeTask(f.root, task.task, task.claimToken, { error: 'Requested native model unavailable' });
    const completed = await run.completion;
    assert.match(completed.error.message, timeout ? /timed out/ : /model unavailable/);
    assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
    assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  }
});

test('native backend and repository instruction changes invalidate approvals', async t => {
  const f = await nativeReady(t), before = contextHash(f.root, f.config);
  atomicWrite(safePath(f.root, 'AGENTS.md'), 'New instructions\n');
  const after = contextHash(f.root, f.config);
  assert.notEqual(before, after);
  assert.throws(() => requireGate(f.root, f.config, 'translation', after), /stale/);
  f.config.workerBackend = 'copilot-cli';
  assert.notEqual(after, contextHash(f.root, f.config));
});

test('native call budget stops dispatch and resumes with existing candidate and fresh reviews', async t => {
  const f = prepare(t);
  Object.assign(f.config, { workerBackend: 'native', nativeHarness: 'vscode-local', maxAgentCalls: 2 });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture only');
  const run = start(t, f);
  await assert.rejects(drain(f, run), /Agent call limit/);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
  const resumed = await drain(f, start(t, f));
  assert.equal(resumed.done, 1); assert.equal(resumed.agentCalls, 1);
});

test('native profiles reject tools or model overrides and cannot silently fall back to CLI', async t => {
  const f = prepare(t);
  Object.assign(f.config, { workerBackend: 'native', nativeHarness: 'vscode-local' });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const file = safePath(f.root, '.github/agents/migration-native-implementer.agent.md');
  const original = fs.readFileSync(file, 'utf8');
  for (const replacement of ['tools: [read]', 'tools: []\nmodel: substituted']) {
    atomicWrite(file, original.replace('tools: []', replacement));
    const report = await doctor(f.root, f.config);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find(c => c.check === 'implementer: model and tools').ok, false);
  }
  await assert.rejects(createCopilotAdapter({ command: '/must/not/run' })({ ...f, role: 'implementer', unit: f.units[0] }), /fallback/);
});

test('native plugin reserves both qualified IDs and host-selectable names before dispatch', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'native-alias-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  const f = prepare(t, { root, layout: 'plugin' });
  Object.assign(f.config, { workerBackend: 'native', nativeHarness: 'copilot' });
  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = path.join(parent, 'personal');
  t.after(() => { if (previousHome === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previousHome; });
  const role = 'implementer', id = runtimeLayout(root, f.config).nativeAgentId(role);
  const name = validateNativeProfile(root, role, f.config).name;
  const directories = ['project/.github/agents/nested', 'project/.claude/agents', '.github/agents', 'personal/agents'];
  for (const directory of directories) for (const selector of [id, name]) {
    const file = safePath(parent, `${directory}/alias.agent.md`);
    atomicWrite(file, `---\nname: ${JSON.stringify(selector)}\ndescription: Conflicting host agent\ntools: [view]\n---\n`);
    assert.throws(() => validateNativeProfile(root, role, f.config), /shadowed|duplicated/);
    assert.equal((await doctor(root, f.config)).ok, false);
    await assert.rejects(createNativeAdapter()({ ...f, role, unit: f.units[0] }), /shadowed|duplicated/);
    fs.rmSync(file);
  }
  // A file-derived selector collides even if its frontmatter uses another name.
  const file = safePath(root, `.github/agents/${name}.agent.md`);
  atomicWrite(file, '---\nname: unrelated\ndescription: Alias by filename\ntools: [view]\n---\n');
  assert.throws(() => validateNativeProfile(root, role, f.config), /shadowed|duplicated/);
  fs.rmSync(file);
  assert.equal(validateNativeProfile(root, role, f.config).id, id);
});

test('runner revalidates response binding even when a client bypasses the submit command', async t => {
  const f = await nativeReady(t), run = start(t, f);
  const task = claimNativeTask(f.root, (await nextTask(f)).task), [id, job] = task.task.split('/');
  writeJSON(safePath(f.root, `migration/runs/${id}/native/${job}/response.json`), {
    task: task.task, claimToken: task.claimToken, requestHash: 'wrong-input',
    hostReportedModel: task.model, result: result(task.role, task.unit)
  });
  assert.match((await run.completion).error.message, /binding mismatch/);
  assert.equal(fileHash(safePath(f.root, f.units[0].target)), null);
});

test('native installer selects backend without changing existing configuration or CLI default', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, workerBackend: 'native', harness: 'vscode-local', model: 'native-model' });
  const config = loadConfig(root);
  assert.equal(config.workerBackend, 'native'); assert.equal(config.nativeHarness, 'vscode-local');
  assert.equal(fs.existsSync(safePath(root, '.github/agents/migration-native-implementer.agent.md')), true);
  install(root, { apply: true, workerBackend: 'copilot-cli', harness: 'vscode-local', model: 'other' });
  assert.deepEqual(loadConfig(root), config);
  assert.equal(prepare(t).config.workerBackend, 'copilot-cli');
  assert.throws(() => install(root, { workerBackend: 'native', layout: 'plugin', nativeHarness: 'vscode-local' }), /repository/);
  const pluginProject = path.join(root, 'plugin-project'); fs.mkdirSync(pluginProject);
  const options = { layout: 'plugin', workerBackend: 'native', nativeHarness: 'copilot', model: 'host-model' };
  assert.equal(install(pluginProject, options).applied, false);
  assert.deepEqual(fs.readdirSync(pluginProject), []);
  install(pluginProject, { ...options, apply: true });
  const pluginConfig = loadConfig(pluginProject);
  assert.equal(pluginConfig.runtime, 'plugin');
  assert.equal(pluginConfig.workerBackend, 'native');
  assert.equal(pluginConfig.nativeHarness, 'copilot');
  install(pluginProject, { apply: true, layout: 'plugin', workerBackend: 'copilot-cli', model: 'different' });
  assert.deepEqual(loadConfig(pluginProject), pluginConfig);
});

test('native command interface transports exact JSON, rejects bad JSON and starts no CLI', async t => {
  const f = await nativeReady(t), controller = new AbortController();
  const runner = safePath(f.root, 'migration-kit/scripts/run_migration.mjs');
  const client = safePath(f.root, 'migration-kit/scripts/native_workers.mjs');
  let finished = false;
  const completion = runProcess(process.execPath, [runner, 'translate'], { cwd: f.root, signal: controller.signal })
    .then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
  t.after(async () => { controller.abort(); await completion; });
  const call = async (args, input) => runProcess(process.execPath, [client, ...args], { cwd: f.root, input });
  await nextTask(f);
  let rejectedInvalid = false;
  while (!finished) {
    const listing = await call(['list']); assert.equal(listing.code, 0, listing.stderr);
    for (const task of JSON.parse(listing.stdout).tasks.filter(t => t.status === 'pending')) {
      const claimed = await call(['claim', '--task', task.task]); assert.equal(claimed.code, 0, claimed.stderr);
      const request = JSON.parse(claimed.stdout);
      const argv = ['submit', '--task', request.task, '--claim', request.claimToken, '--model', request.model, '--file', '-'];
      if (!rejectedInvalid) { assert.notEqual((await call(argv, 'not JSON')).code, 0); rejectedInvalid = true; }
      const response = await call(argv, JSON.stringify(result(request.role, request.unit)));
      assert.equal(response.code, 0, response.stderr);
    }
    await delay(10);
  }
  const outcome = await completion;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value.code, 0, outcome.value.stderr);
  assert.equal(JSON.parse(outcome.value.stdout).done, 1);
});

test('native initialization is reported as experimental and copilot-cli stays the default', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-experimental-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(install(root, { layout: 'plugin', workerBackend: 'native', nativeHarness: 'copilot' }).warnings[0], /EXPERIMENTAL/);
  assert.equal(install(root, { layout: 'plugin' }).warnings, undefined);
  for (const skill of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = fs.readFileSync(path.join(kitRoot, skill), 'utf8');
    assert.match(text, /default `copilot-cli` backend, in VS Code/); assert.match(text, /EXPERIMENTAL/);
  }
});
