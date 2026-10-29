import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepare, ready, fake, result, cliOutput, cliDouble } from './helpers.mjs';
import { approve, requireGate, runStage, translate } from '../lib/pipeline.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, contextHash, readManifest, done, verificationFiles, filesUnder, loadConfig, unitState } from '../lib/core.mjs';
import { runProcess } from '../lib/process.mjs';
import { reviewInput } from '../lib/review.mjs';
import { copilotArgs, createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { decide } from '../scripts/migration_hook.mjs';
import { createWorkflowDefinition } from '../lib/workflow.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { kitRoot } from '../scripts/install.mjs';

const write = (root, name, text) => atomicWrite(safePath(root, name), text);
const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);
const node = (args, options) => runProcess(process.execPath, args, options);
async function start(f) {
  persist(f); await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Regression fixture');
  await translate(f.root, f.config, fake);
}
async function validateThrough(f, last = 'smoke') {
  for (const stage of ['build', 'smoke', 'parity']) {
    approve(f.root, f.config, stage, 'Regression fixture');
    await runStage(f.root, f.config, stage);
    if (stage === last) break;
  }
}

test('R1: explicit manifest source under a normally excluded directory invalidates completion and approval', async t => {
  const f = prepare(t);
  write(f.root, 'src/node_modules/dependency.py', 'value = 1\n');
  write(f.root, 'migration/manifest.tsv', 'source\ttarget\nsrc/node_modules/dependency.py\tported/math_ops.mjs\n');
  const map = readJSON(safePath(f.root, 'migration/review-dependencies.json'));
  map.dependencies['src/node_modules/dependency.py'] = [];
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), map);
  await start(f);
  const unit = readManifest(f.root, f.config)[0], before = contextHash(f.root, f.config);
  assert.ok(done(f.root, unit, before));
  write(f.root, unit.source, 'value = 2\n');
  assert.notEqual(contextHash(f.root, f.config), before);
  assert.equal(done(f.root, unit, contextHash(f.root, f.config)), false);
  await assert.rejects(translate(f.root, f.config, fake), /stale/);
});

test('R1: build scripts, standard configs and explicit nested inputs participate in approvals', async t => {
  const f = prepare(t);
  write(f.root, 'build.mjs', 'process.exit(0)\n');
  write(f.root, 'package.json', '{"name":"fixture","private":true}\n');
  write(f.root, 'build-settings/options.json', '{"mode":"a"}\n');
  f.config.commands.build = [process.execPath, 'build.mjs'];
  f.config.verificationInputs = ['build-settings/options.json'];
  await start(f); await validateThrough(f, 'build');
  for (const name of ['build.mjs', 'package.json', 'build-settings/options.json']) {
    const before = contextHash(f.root, f.config);
    fs.appendFileSync(safePath(f.root, name), '\n');
    assert.notEqual(contextHash(f.root, f.config), before, name);
    assert.throws(() => approve(f.root, f.config, 'smoke', 'test'), /current reviewed receipts/);
  }
  assert.ok(verificationFiles(f.root, f.config).includes('build.mjs'));
  assert.ok((await doctor(f.root, f.config)).ok);
  fs.unlinkSync(safePath(f.root, 'build-settings/options.json'));
  assert.equal((await doctor(f.root, f.config)).ok, false);
  assert.throws(() => contextHash(f.root, f.config), /verificationInputs file missing/);
});

test('R2: failed build retry revokes downstream results and already issued approvals', async t => {
  const f = prepare(t);
  f.config.commands.build = [process.execPath, '-e', 'process.exit(require("node:fs").existsSync("migration/fail-build") ? 7 : 0)'];
  await start(f); await validateThrough(f);
  approve(f.root, f.config, 'parity', 'Approved before build retry');
  const before = contextHash(f.root, f.config);
  write(f.root, 'migration/fail-build', 'fail');
  assert.equal(contextHash(f.root, f.config), before);
  await assert.rejects(runStage(f.root, f.config, 'build'), /exit 7/);
  assert.equal(readJSON(safePath(f.root, 'migration/results/smoke.json')).invalidatedBy, 'build');
  assert.throws(() => approve(f.root, f.config, 'parity', 'stale smoke'), /smoke successfully/);
  await assert.rejects(runStage(f.root, f.config, 'parity'), /No parity approval/);
  fs.unlinkSync(safePath(f.root, 'migration/fail-build'));
  await runStage(f.root, f.config, 'build');
  assert.throws(() => approve(f.root, f.config, 'parity', 'still stale smoke'), /smoke successfully/);
  await validateThrough(f, 'parity');
});

test('R2: successful upstream retry also changes generation; restoring stale files cannot restore validity', async t => {
  const f = await ready(t); await translate(f.root, f.config, fake); await validateThrough(f);
  approve(f.root, f.config, 'parity', 'Old smoke');
  const smoke = readJSON(safePath(f.root, 'migration/results/smoke.json'));
  const gate = readJSON(safePath(f.root, 'migration/gates/parity.json'));
  const build = readJSON(safePath(f.root, 'migration/results/build.json'));
  const next = await runStage(f.root, f.config, 'build');
  assert.notEqual(next.executionId, build.executionId);
  writeJSON(safePath(f.root, 'migration/results/smoke.json'), smoke);
  writeJSON(safePath(f.root, 'migration/gates/parity.json'), gate);
  assert.throws(() => requireGate(f.root, f.config, 'parity', contextHash(f.root, f.config)), /smoke successfully/);
  await runStage(f.root, f.config, 'judge');
  assert.throws(() => approve(f.root, f.config, 'build', 'old translation gate'), /No translation approval/);
});

test('R3: timeout kills a TERM-ignoring grandchild before the caller resumes', { skip: process.platform === 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-process-proof-'));
  t.after(() => {
    const pidFile = path.join(dir, 'pid');
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'child.cjs'), 'const fs=require("node:fs"); process.on("SIGTERM",()=>{}); fs.writeFileSync("pid",String(process.pid)); setInterval(()=>fs.appendFileSync("heartbeat","x"),25);');
  fs.writeFileSync(path.join(dir, 'parent.cjs'), 'require("node:child_process").spawn(process.execPath,["child.cjs"],{stdio:"ignore"}); setInterval(()=>{},1000);');
  await assert.rejects(node(['parent.cjs'], { cwd: dir, timeoutMs: 700 }), /timed out/);
  const heartbeat = path.join(dir, 'heartbeat'), before = fs.statSync(heartbeat).size;
  assert.ok(before > 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(fs.statSync(heartbeat).size, before, 'no writes after timeout promise rejects');
});

test('R4: both reviewers receive the same snapshot without other evidence; a missing review resumes with the same input', async t => {
  const f = await ready(t);
  write(f.root, 'migration/runs/old/review.json', 'DO_NOT_EXPOSE_OTHER_REVIEW');
  write(f.root, 'migration/state/other.json', 'DO_NOT_EXPOSE_OTHER_STATE');
  const seen = []; let fail = true;
  const adapter = async args => {
    if (args.role.startsWith('reviewer-')) {
      seen.push(args.reviewInput);
      assert.doesNotMatch(args.reviewInput, /DO_NOT_EXPOSE_OTHER/);
      assert.deepEqual(args.extra, {});
      const data = JSON.parse(args.reviewInput);
      assert.ok(data.files.some(x => x.path === args.unit.target));
      assert.ok(data.files.some(x => x.path === args.unit.source));
      if (args.role === 'reviewer-rules' && fail) throw new Error('test retry');
    }
    return fake(args);
  };
  await assert.rejects(translate(f.root, f.config, adapter), /test retry/);
  fail = false;
  await translate(f.root, f.config, adapter);
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 1);
  const state = unitState(f.root, f.units[0]);
  for (const file of state.reviews) assert.equal(readJSON(safePath(f.root, file)).reviewInputHash, state.reviewInputHash);
});

test('R4: review tools deny direct, directory and repo-wide reads; CLI uses stdin and pins an empty profile', async t => {
  const f = prepare(t), unit = f.units[0];
  write(f.root, unit.target, result('implementer', unit).content);
  const snapshot = reviewInput(f.root, f.config, unit);
  for (const location of ['migration/runs/a.json', 'migration/runs', '.', 'src/math_ops.py']) {
    assert.match(decide({ toolName: 'grep', toolArgs: { path: location } }, 'reviewer-rules'), /no tools/);
  }
  const args = copilotArgs('reviewer-rules', 'test-model');
  assert.equal(args[args.indexOf('--deny-tool') + 1], 'read,write,shell');
  assert.ok(!args.includes('--allow-tool'));
  write(f.root, 'transport-double.mjs', `let input=''; for await(const c of process.stdin) input+=c; if(!input.includes('Frozen review input')) process.exit(8); console.log(${JSON.stringify(cliOutput(result('reviewer-rules', unit)))});`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [path.join(f.root, 'transport-double.mjs')] });
  assert.equal((await adapter({ ...f, role: 'reviewer-rules', unit, reviewInput: snapshot.text })).result.verdict, 'pass');
  const p = safePath(f.root, '.github/agents/migration-reviewer-rules.agent.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('tools: []', 'tools: ["read", "search"]'));
  await assert.rejects(adapter({ ...f, role: 'reviewer-rules', unit, reviewInput: snapshot.text }), /tools: \[\]/);
});

test('R4: workflow CLI reviewers receive frozen input and reject a profile that re-enables tools', async t => {
  const f = await ready(t, { workflow: true }), transport = cliDouble(f);
  const run = () => createWorkflowDefinition(f.root, transport).run({ args: { stage: 'translate' }, phase() {}, log() {},
    agent: async () => { throw new Error('SDK agent inheritance is forbidden'); } });
  await run();
  const reviewers = fs.readFileSync(safePath(f.root, 'cli-double-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.role.startsWith('reviewer-'));
  assert.equal(reviewers.length, 2);
  assert.equal(reviewers[0].prompt.split('Frozen review input (JSON task data):\n')[1], reviewers[1].prompt.split('Frozen review input (JSON task data):\n')[1]);
  for (const reviewer of reviewers) {
    assert.match(reviewer.prompt, /Frozen review input/);
    assert.match(fs.readFileSync(safePath(f.root, `.github/agents/migration-${reviewer.role}.agent.md`), 'utf8'), /tools: \[\]/);
  }
  const p = safePath(f.root, '.github/agents/migration-reviewer-rules.agent.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('tools: []', 'tools: ["read", "search"]'));
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Changed profile fixture');
  await assert.rejects(run(), /tools: \[\]/);
});

test('R4: oversized static review input is tool-assisted; metadata cannot become a source root', async t => {
  const f = prepare(t); f.config.maxReviewInputBytes = 1024;
  write(f.root, 'migration/RULEBOOK.md', '# Required global rules\n' + 'X'.repeat(1024));
  persist(f); await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Limit fixture');
  const report = await translate(f.root, f.config, fake);
  assert.deepEqual(report.toolAssistedReviews, [f.units[0].target]);
  f.config.sourceRoots = ['migration']; persist(f);
  assert.throws(() => loadConfig(f.root), /metadata/);
});

test('R5: target ancestor collision is rejected even when a sibling sorts between them', t => {
  const f = prepare(t, { count: 3 });
  write(f.root, 'migration/manifest.tsv', 'source\ttarget\nsrc/math_ops.py\tported/a\nsrc/text_ops.py\tported/a-b\nsrc/main.py\tported/a/b\n');
  assert.throws(() => readManifest(f.root, f.config), /parent/);
  assert.equal(fs.existsSync(safePath(f.root, 'ported')), false);
});

test('R6: timed-out validation retains command, output, timestamps and failure before releasing the lock', async t => {
  const f = prepare(t); f.config.commandTimeoutSeconds = 1;
  f.config.commands.original = [process.execPath, '-e', 'console.log("started");console.error("useful diagnostic");setInterval(()=>{},1000)'];
  persist(f);
  await assert.rejects(runStage(f.root, f.config, 'judge'), /timed out/);
  const r = readJSON(safePath(f.root, 'migration/results/judge.json'));
  assert.equal(r.commands.length, 1); assert.equal(r.commands[0].status, 'failed');
  assert.deepEqual(r.commands[0].command, f.config.commands.original);
  assert.match(r.commands[0].stderr, /useful diagnostic/); assert.match(r.commands[0].stdout, /started/);
  assert.ok(r.commands[0].startedAt <= r.commands[0].finishedAt);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('R6: malformed model JSON is a recorded failed attempt with model and bounded process output', async t => {
  const f = await ready(t);
  write(f.root, 'invalid-cli.mjs', 'console.log("NOT JSON"); console.error("model diagnostic");');
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [path.join(f.root, 'invalid-cli.mjs')] });
  await assert.rejects(translate(f.root, f.config, adapter), /valid JSON/);
  const records = filesUnder(f.root, 'migration/runs').filter(x => x.includes('-implementer-')).map(x => readJSON(safePath(f.root, x)));
  assert.equal(records.length, 1); assert.equal(records[0].status, 'failed');
  assert.equal(records[0].requestedModel, 'test-double');
  assert.match(records[0].process.stdout, /NOT JSON/); assert.match(records[0].process.stderr, /model diagnostic/);
});

test('R6: abort, output spooling and spawn failure preserve process diagnostics', async t => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(node(['-e', ''], { signal: aborted.signal }), e => e.result.code === null && /Interrupted/.test(e.result.error));
  const output = await node(['-e', 'console.log("x".repeat(1000))'], { maxBytes: 100 });
  t.after(() => fs.rmSync(path.dirname(output.stdoutFile), { recursive: true, force: true }));
  assert.equal(output.code, 0); assert.equal(output.outputSpooled, true);
  assert.equal(fs.readFileSync(output.stdoutFile, 'utf8'), 'x'.repeat(1000) + '\n');
  assert.ok(Buffer.byteLength(output.stdout) <= 50);
  await assert.rejects(runProcess('nonexistent-migration-test-executable', []), e => e.result.command[0] === 'nonexistent-migration-test-executable' && e.result.code === null);
});

test('R7: installed runtime advertises only executable checks; missing tests cannot pass silently', async t => {
  const f = prepare(t);
  const pkg = readJSON(safePath(f.root, 'migration-kit/package.json'));
  assert.deepEqual(Object.keys(pkg.scripts), ['check']);
  const check = await node([safePath(f.root, 'migration-kit/scripts/run_migration.mjs'), 'doctor', '--root', f.root]);
  assert.equal(check.code, 0, check.stderr); assert.equal(JSON.parse(check.stdout).ok, true);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-empty-tests-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  fs.mkdirSync(path.join(empty, 'scripts')); fs.mkdirSync(path.join(empty, 'tests'));
  fs.copyFileSync(path.join(kitRoot, 'scripts/test.mjs'), path.join(empty, 'scripts/test.mjs'));
  const zero = await node([path.join(empty, 'scripts/test.mjs')]);
  assert.notEqual(zero.code, 0); assert.match(zero.stderr, /No test files/);
});

test('C1: every hook denial carries both the CLI top-level and the VS Code hookSpecificOutput decision', async t => {
  const f = prepare(t);
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: {} });
  for (const local of [false, true]) {
    const r = await node([path.join(kitRoot, 'scripts/migration_hook.mjs'), ...(local ? ['--vscode'] : [])], { cwd: f.root, input: event, env: { ...process.env, MIGRATION_KIT_ROLE: 'implementer' } });
    assert.equal(r.code, 0); const d = JSON.parse(r.stdout);
    assert.equal(d.permissionDecision, 'deny');
    assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(d.hookSpecificOutput.hookEventName, 'PreToolUse');
  }
});
