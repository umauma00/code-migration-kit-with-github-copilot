import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepare, ready, result, fake, finding, cliOutput, cliDouble, python } from './helpers.mjs';
import { approve, requireGate, runStage, translate } from '../lib/pipeline.mjs';
import { safePath, atomicWrite, readJSON, writeJSON, fileHash, loadConfig, contextHash,
  readManifest, done, unitState, statePath, lockRun, roles } from '../lib/core.mjs';
import { parseResult, validateResult } from '../lib/results.mjs';
import { install, kitRoot } from '../scripts/install.mjs';
import { runProcess } from '../lib/process.mjs';
import { copilotArgs, createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { decide } from '../scripts/migration_hook.mjs';
import { createWorkflowDefinition } from '../lib/workflow.mjs';
const write = (root, rel, text) => atomicWrite(safePath(root, rel), text);
const receipt = f => unitState(f.root, f.units[0]);
const node = (args, options) => runProcess(process.execPath, args, options);

test('end-to-end: 3 modules, original/mutation/build/smoke/parity run real commands', async t => {
  const f = await ready(t, { realCommands: true, count: 3 });
  const translated = await translate(f.root, f.config, fake);
  assert.equal(translated.done, 3); assert.equal(translated.agentCalls, 9);
  assert.equal(readJSON(safePath(f.root, 'migration/results/judge.json')).commands.length, 2);
  for (const stage of ['build', 'smoke', 'parity']) {
    approve(f.root, f.config, stage, 'Test fixture: previous results verified');
    assert.equal((await runStage(f.root, f.config, stage)).success, true);
  }
  const parity = readJSON(safePath(f.root, 'migration/results/parity.json'));
  assert.deepEqual(JSON.parse(parity.commands[1].stdout), { mode: 'parity', cases: 12, mismatches: 0, skipped: 0, mutationDetected: false });
  assert.equal((await translate(f.root, f.config, fake)).agentCalls, 0);
  const queue = await node([path.join(kitRoot, 'scripts/queue_runner.mjs'), 'verify', '--root', f.root]);
  assert.equal(queue.code, 0, queue.stderr);
});

test('existing nonempty output needs both reviews and cannot pass queue verify by existence', async t => {
  const f = await ready(t);
  write(f.root, f.units[0].target, result('implementer', f.units[0]).content);
  const before = await node([path.join(kitRoot, 'scripts/queue_runner.mjs'), 'verify', '--root', f.root]);
  assert.equal(before.code, 1);
  const called = [];
  await translate(f.root, f.config, async args => { called.push(args.role); return fake(args); });
  assert.deepEqual(called.sort(), ['reviewer-rules', 'reviewer-semantics']);
  assert.ok(done(f.root, f.units[0], contextHash(f.root, f.config)));
});

test('reviewer failure resumes only missing review, preserving the completed independent review', async t => {
  const f = await ready(t); let fail = true; const called = [];
  const adapter = async args => { called.push(args.role); if (args.role === 'reviewer-rules' && fail) throw new Error('Simulated outage'); return fake(args); };
  await assert.rejects(translate(f.root, f.config, adapter), /Simulated outage/);
  assert.equal(receipt(f).status, 'blocked');
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  fail = false; called.length = 0;
  await translate(f.root, f.config, adapter);
  assert.deepEqual(called, ['reviewer-rules']);
});

test('deleted or corrupt review evidence forces fresh review on resume', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, fake);
  fs.unlinkSync(safePath(f.root, receipt(f).reviews[0]));
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
  const restarted = await translate(f.root, f.config, fake);
  assert.equal(restarted.agentCalls, 2); assert.equal(restarted.done, 1);
  write(f.root, receipt(f).reviews[1], '{broken');
  assert.equal((await translate(f.root, f.config, fake)).agentCalls, 2);
});

test('edited output invalidates completion; changed judge/source/config invalidates approval', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, fake);
  fs.appendFileSync(safePath(f.root, f.units[0].target), '\n// human edit\n');
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
  assert.equal((await translate(f.root, f.config, fake)).agentCalls, 2);
  const initial = contextHash(f.root, f.config);
  fs.appendFileSync(safePath(f.root, 'tests/judge.py'), '\n# changed judge\n');
  assert.notEqual(contextHash(f.root, f.config), initial);
  await assert.rejects(translate(f.root, f.config, fake), /stale/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  const second = contextHash(f.root, f.config);
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), '\n# source edit\n');
  assert.notEqual(contextHash(f.root, f.config), second);
  const third = contextHash(f.root, f.config), file = safePath(f.root, 'migration/config.json');
  fs.appendFileSync(file, '\n');
  assert.equal(contextHash(f.root, f.config), third, 'formatting is not a configuration change');
  writeJSON(file, { ...f.config, models: { ...f.config.models, fixer: 'another-model' } });
  assert.notEqual(contextHash(f.root, f.config), third, 'detect on-disk edits even with an in-memory config');
});

test('confirmed finding is fixed, then independently reviewed again', async t => {
  const f = await ready(t); let fixed = false; const calls = [];
  const adapter = async args => {
    calls.push(args.role);
    if (args.role === 'reviewer-semantics' && !fixed) return { result: result(args.role, args.unit, { findings: [finding] }) };
    if (args.role === 'fixer') { assert.equal(args.extra.confirmedFindings.length, 1); fixed = true; }
    return fake(args);
  };
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 1); assert.equal(receipt(f).round, 1);
  assert.equal(calls.filter(x => x.startsWith('reviewer-')).length, 4);
  assert.equal(receipt(f).arbitration, undefined, 'old arbitration is not evidence for the fixed output');
});

test('rejected finding completes only with bound arbitration evidence', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, async args => {
    if (args.role === 'reviewer-rules') return { result: result(args.role, args.unit, { findings: [finding] }) };
    if (args.role === 'arbiter') return { result: result(args.role, args.unit, { decisions: args.extra.findings.map(x => ({ finding: x.reference, confirmed: false, reason: 'Rule already satisfied' })) }) };
    return fake(args);
  });
  assert.ok(done(f.root, f.units[0], contextHash(f.root, f.config)));
  fs.unlinkSync(safePath(f.root, receipt(f).arbitration.path));
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
  assert.equal((await translate(f.root, f.config, fake)).done, 1);
});

test('missing arbitration decisions fail closed', async t => {
  const f = await ready(t);
  await assert.rejects(translate(f.root, f.config, async args => {
    if (args.role === 'reviewer-rules') return { result: result(args.role, args.unit, { findings: [finding] }) };
    if (args.role === 'arbiter') return { result: result(args.role, args.unit) };
    return fake(args);
  }), /omitted findings/);
  assert.equal(receipt(f).status, 'blocked');
});

test('recurrent findings stop at configured repair limit', async t => {
  const f = await ready(t);
  await assert.rejects(translate(f.root, f.config, args => args.role === 'reviewer-semantics'
    ? Promise.resolve({ result: result(args.role, args.unit, { findings: [finding] }) }) : fake(args)), /Fix-round limit/);
  assert.equal(receipt(f).round, f.config.maxFixRounds);
});

test('diagnostic repair can repair a syntax error before retrying the cheap check', async t => {
  const f = await ready(t);
  write(f.root, f.units[0].target, 'this is not valid JavaScript !');
  // The in-loop typecheck sends its errors to the fixer; a fixer that cannot
  // repair the syntax exhausts the fix rounds instead of looping.
  await assert.rejects(translate(f.root, f.config, async args => args.role === 'fixer'
    ? { result: result(args.role, args.unit, { content: 'this is not valid JavaScript !' }) } : fake(args)), /Fix-round limit/);
  write(f.root, 'migration/diagnostic.txt', 'SyntaxError in ported/math_ops.mjs');
  let fixed = false;
  const repaired = await translate(f.root, f.config, async args => {
    if (args.role === 'reviewer-rules' && !fixed) return { result: result(args.role, args.unit, { findings: [finding] }) };
    if (args.role === 'fixer') fixed = true;
    return fake(args);
  }, { onlyTarget: f.units[0].target, evidence: 'migration/diagnostic.txt' });
  assert.equal(repaired.done, 1);
});

test('review concurrency never exceeds cap across multiple units', async t => {
  const f = await ready(t, { count: 3 }); let active = 0, max = 0;
  await translate(f.root, f.config, async args => {
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return fake(args);
  });
  assert.equal(max, f.config.concurrency);
});

test('concurrent output edits are not overwritten by generated content', async t => {
  const f = await ready(t);
  await assert.rejects(translate(f.root, f.config, async args => {
    if (args.role === 'implementer') write(f.root, args.unit.target, '// human edit');
    return fake(args);
  }), /refusing to overwrite/);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), '// human edit');
});

test('protected-input changes during a worker call prevent completion', async t => {
  const f = await ready(t);
  await assert.rejects(translate(f.root, f.config, async args => {
    if (args.role === 'reviewer-rules') fs.appendFileSync(safePath(f.root, 'migration/RULEBOOK.md'), '\nChanged during review');
    return fake(args);
  }), /inputs changed/);
  assert.equal(receipt(f).status, 'blocked');
});

test('lock blocks overlapping execution/approval; interruption releases lock', async t => {
  const f = await ready(t); const unlock = lockRun(f.root, 'test');
  await assert.rejects(translate(f.root, f.config, fake), /locked/);
  assert.throws(() => approve(f.root, f.config, 'translation', 'test'), /locked/);
  unlock();
  const abort = new AbortController();
  await assert.rejects(translate(f.root, f.config, async args => { abort.abort(); return fake(args); }, { signal: abort.signal }), /Interrupted/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  assert.equal((await translate(f.root, f.config, fake)).done, 1);
});

test('agent call budget limits actual invocations and can resume', async t => {
  const f = prepare(t); f.config.maxAgentCalls = 2;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Test');
  let calls = 0;
  await assert.rejects(translate(f.root, f.config, async args => { calls++; return fake(args); }), /call limit/);
  assert.equal(calls, 2);
  assert.equal((await translate(f.root, f.config, fake)).done, 1);
});

test('failed build records real exit code and prevents smoke approval', async t => {
  const f = prepare(t); f.config.commands.build = [process.execPath, '-e', 'process.exit(7)'];
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Test');
  await translate(f.root, f.config, fake); approve(f.root, f.config, 'build', 'Test');
  await assert.rejects(runStage(f.root, f.config, 'build'), /exit 7/);
  assert.equal(readJSON(safePath(f.root, 'migration/results/build.json')).commands[0].code, 7);
  assert.throws(() => approve(f.root, f.config, 'smoke', 'Test'), /build successfully/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('no translation approval is invented, and missing/empty manifests fail', async t => {
  const f = prepare(t);
  await assert.rejects(translate(f.root, f.config, fake), /No translation approval/);
  assert.throws(() => approve(f.root, f.config, 'translation', 'Test'), /judge successfully/);
  await runStage(f.root, f.config, 'judge');
  assert.throws(() => approve(f.root, f.config, 'translation', ''), /--note/);
  write(f.root, 'migration/manifest.tsv', 'source\ttarget\n');
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Test');
  await assert.rejects(translate(f.root, f.config, fake), /Manifest is empty/);
});

test('JSON validation rejects non-JSON, wrong targets and contradictory review results', () => {
  const unit = { target: 'ported/x.mjs' };
  assert.throws(() => parseResult('looks good'), /valid JSON/);
  assert.deepEqual(parseResult('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => validateResult('implementer', { ...result('implementer', unit, { content: 'x' }), target: '../escape' }, unit), /mismatch/);
  assert.throws(() => validateResult('reviewer-rules', { ...result('reviewer-rules', unit), findings: [finding] }, unit), /contradicts/);
  assert.throws(() => validateResult('reviewer-rules', result('reviewer-rules', unit, { findings: [finding, finding] }), unit), /Duplicate/);
});

test('protected roots, traversal, duplicate mappings and symlinks are refused', t => {
  const f = prepare(t);
  for (const p of ['../x', '/tmp/x', 'a/../b', 'a\\b', 'C:/a', 'a//b']) assert.throws(() => safePath(f.root, p), /relative path/);
  const manifest = 'source\ttarget\nsrc/math_ops.py\tported/a.mjs\nsrc/text_ops.py\tported/A.mjs\n';
  write(f.root, 'migration/manifest.tsv', manifest);
  assert.throws(() => readManifest(f.root, f.config), /Duplicate/);
  write(f.root, 'migration/manifest.tsv', 'source\ttarget\nsrc/math_ops.py\tported/a\nsrc/text_ops.py\tported/a/b\n');
  assert.throws(() => readManifest(f.root, f.config), /parent/);
  f.config.outputRoots = ['src/ported']; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  assert.throws(() => loadConfig(f.root), /protected/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(os.tmpdir(), path.join(f.root, 'escape'));
    assert.throws(() => safePath(f.root, 'escape/file'), /Symlinks/);
  }
});

test('installer dry run, idempotency, existing instructions and conflict preflight', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.github/copilot-instructions.md', '# Keep team instructions\n');
  const preview = install(root, { model: 'test-double', withWorkflow: true });
  assert.ok(preview.changes.length > 10); assert.equal(fs.existsSync(path.join(root, 'migration-kit')), false);
  install(root, { apply: true, model: 'test-double', withWorkflow: true });
  assert.ok(fs.readFileSync(path.join(root, '.github/copilot-instructions.md'), 'utf8').startsWith('# Keep team instructions'));
  assert.equal(install(root, { apply: true, model: 'different-retained', withWorkflow: true }).changes.length, 0);
  assert.equal(loadConfig(root).models.implementer, 'test-double');
  const agent = '.github/agents/migration-implementer.agent.md';
  assert.match(fs.readFileSync(safePath(root, agent), 'utf8'), /\.\.\/\.\.\/migration-kit\/docs\/CONTRACTS.md/);
  fs.unlinkSync(safePath(root, '.github/prompts/migrate-00-feasibility.prompt.md'));
  write(root, agent, 'Existing custom agent');
  assert.throws(() => install(root, { apply: true, withWorkflow: true }), /overwrite/);
  assert.equal(fs.existsSync(safePath(root, '.github/prompts/migrate-00-feasibility.prompt.md')), false, 'preflight must prevent partial installation');
});

test('subprocess preserves literal argv, explicit timeout and abort; large output is spooled', async t => {
  const literal = '$(echo unsafe); `echo unsafe` "quotes"';
  const r = await node(['-e', 'console.log(process.argv[1]); process.exit(9)', literal]);
  assert.equal(r.stdout.trim(), literal); assert.equal(r.code, 9);
  await assert.rejects(node(['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(node(['-e', ''], { signal: abort.signal }), /Interrupted/);
  const output = await node(['-e', 'console.log("x".repeat(10000))'], { maxBytes: 100 });
  t.after(() => fs.rmSync(path.dirname(output.stdoutFile), { recursive: true, force: true }));
  assert.equal(output.code, 0); assert.equal(output.stdoutBytes, 10001);
  assert.equal(fs.readFileSync(output.stdoutFile, 'utf8'), 'x'.repeat(10000) + '\n');
});

test('CLI transport pins model/tools and validates JSON without authenticating', async t => {
  const f = prepare(t), unit = f.units[0];
  const args = copilotArgs('implementer', 'chosen-model', 'a prompt');
  assert.equal(args[args.indexOf('--model') + 1], 'chosen-model');
  assert.equal(args[args.indexOf('--available-tools') + 1], 'view,grep,glob');
  assert.equal(args[args.indexOf('--deny-tool') + 1], 'write,shell');
  write(f.root, 'cli-double.mjs', `console.log(${JSON.stringify(cliOutput(result('implementer', unit)))});`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [path.join(f.root, 'cli-double.mjs')] });
  assert.equal((await adapter({ ...f, role: 'implementer', unit })).result.target, unit.target);
  write(f.root, 'cli-double.mjs', 'console.log("not JSON");');
  await assert.rejects(adapter({ ...f, role: 'implementer', unit }), /valid JSON/);
  const profile = safePath(f.root, '.github/agents/migration-implementer.agent.md');
  fs.writeFileSync(profile, fs.readFileSync(profile, 'utf8').replace('---\n', '---\nmodel: override\n'));
  await assert.rejects(adapter({ ...f, role: 'implementer', unit }), /model override/);
});

test('CLI and Local hook payloads deny worker writes without changing normal sessions', async t => {
  assert.equal(decide({ toolName: 'bash' }), null);
  assert.match(decide({ toolName: 'bash' }, 'implementer'), /read-only/);
  assert.match(decide({ toolName: 'view', toolArgs: JSON.stringify({ path: 'src/a.py' }) }, 'reviewer-rules'), /no tools/);
  assert.match(decide({ toolName: 'view', toolArgs: { path: 'migration/runs/other.json' } }, 'reviewer-rules'), /Independent/);
  const f = prepare(t);
  write(f.root, 'hook-driver.mjs', `import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath, [${JSON.stringify(path.join(kitRoot, 'scripts/migration_hook.mjs'))}, ...process.argv.slice(2)], {input:JSON.stringify({toolName:'bash',toolArgs:{}}),encoding:'utf8',env:{...process.env,MIGRATION_KIT_ROLE:'implementer'}}); process.stdout.write(r.stdout); process.exit(r.status);`);
  const native = await node([path.join(f.root, 'hook-driver.mjs')]);
  assert.equal(JSON.parse(native.stdout).permissionDecision, 'deny');
  const local = await node([path.join(f.root, 'hook-driver.mjs'), '--vscode']);
  assert.equal(JSON.parse(local.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('experimental workflow uses isolated CLI workers and resumes from shared receipts', async t => {
  const f = await ready(t, { workflow: true });
  const definition = createWorkflowDefinition(f.root, cliDouble(f));
  const ctx = { args: { stage: 'translate', copilot: process.execPath }, phase() {}, log() {},
    agent: async () => { throw new Error('The host SDK agent must not run'); } };
  const output = await definition.run(ctx);
  assert.equal(output.done, 1); assert.equal(output.agentCalls, 3);
  const calls = fs.readFileSync(safePath(f.root, 'cli-double-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(x => x.role).sort(), ['implementer', 'reviewer-rules', 'reviewer-semantics']);
  for (const call of calls) {
    assert.ok(call.argv.includes('--no-custom-instructions'));
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'test-double');
    assert.equal(call.argv[call.argv.indexOf('--agent') + 1], `migration-${call.role}`);
  }
  assert.equal((await definition.run(ctx)).agentCalls, 0);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/gates/build.json')), false);
});

test('workflow invalid CLI result fails closed and never marks a unit complete', async t => {
  const f = await ready(t);
  await assert.rejects(createWorkflowDefinition(f.root, cliDouble(f, { empty: true })).run({ args: { stage: 'translate' }, phase() {}, log() {} }), /schemaVersion\/target mismatch/);
  assert.equal(receipt(f).status, 'blocked');
});

test('C#, Java, PHP, VB.NET and COBOL dependency fixtures produce their expected outputs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // [mapper, fixture, prefix of the expected files, extra options]
  const cases = [['csharp', 'csharp'], ['java', 'java'], ['php', 'php'], ['vbnet', 'vbnet'], ['cobol', 'cobol'],
    ['csharp', 'csharp-projects'], ['java', 'java-modules'], ['php', 'php-composer', 'expected_', ['--include-path', 'lib/inc']],
    ['cobol', 'cobol', 'expected_copy_path_', ['--copy-path', 'SHARED,copy']],
    // Review regressions: per-namespace scope, global::, global using aliases,
    // MSBuild item lists and conditions, ./ includes versus include_path;
    // aliases per namespace block, global using static, single-quoted
    // attributes, MSBuild * within one directory.
    ['csharp', 'csharp-scopes'], ['csharp', 'csharp-items'], ['vbnet', 'vbnet-items'], ['csharp', 'csharp-aliases'],
    // Build-output directories only beside a build file, case-insensitive
    // MSBuild paths, ProjectReference attribute order, qualified attributes,
    // relative using in a block, VB implicit continuation, PHP DS/realpath/
    // or die and string callables, COBOL CALL across lines.
    ['csharp', 'csharp-review'], ['java', 'java-packages'], ['vbnet', 'vbnet-continuation'],
    ['php', 'php-includes'], ['cobol', 'cobol-call-newline'],
    // Interpolation holes (C# and VB), VB auto-property followed by Settings,
    // PHP string callables only in callback positions.
    ['csharp', 'csharp-interp'], ['vbnet', 'vbnet-interp'],
    // #if branches with unequal braces.
    ['csharp', 'csharp-ifdef'],
    // Final pass: duplicate non-partial types, attributed enum members, C# 14
    // extension blocks, MSBuild items in document order, $(Prop) items,
    // linked files, ProjectReference case; VB Imports lists; Gradle Kotlin
    // project(path = ...) and projects.x; PHP 7 class Enum/Match/From and
    // dotted file names; a Java import on the package line; MSBuild Exclude;
    // PHP string holes and class_alias.
    ['csharp', 'csharp-final'], ['csharp', 'csharp-msbuild'], ['vbnet', 'vbnet-final'],
    ['java', 'java-final'], ['php', 'php-final'],
    // A file linked into several projects belongs to each (VB RootNamespace too).
    ['vbnet', 'vbnet-linked'],
    // using static does not bring the type's own name; [Foo] as an attribute counts Foo and FooAttribute,
    // Foo elsewhere (collection expressions too) only Foo; an alias target is a full name in type flow too.
    ['csharp', 'csharp-steps'],
    // Real-tree findings: guarded PHP fallbacks, define() literals and
    // --include-var in include paths, dirname(dirname(__FILE__)).
    ['php', 'php-real'], ['php', 'php-real', 'expected_vars_', ['--include-var', 'root=,ext=php,IP=mw']],
    ['php', 'php-relative', 'expected_', ['--include-path', 'lib']],
    // Re-review: global usings of a removed file, <Using> in an XML comment,
    // a shared file linked only under a Condition, UTF-16 and binary sources;
    // Maven groupId:artifactId; PHP callback positions and named arguments,
    // dynamic callbacks (variables, concatenation, calls) and a missing
    // __DIR__ include; <Using> aliases under Conditions; VB.NET nested types and a commented-out
    // RootNamespace. The *-names fixtures: enum members and members named
    // like types, full names written inline (external.tsv), <Using> lists
    // and child metadata, Imports Global., an include inside an
    // expression, namespace\f(), PHP external spelling and more callback
    // tables; cobol-format: *> inside a literal, tabs, CICS HANDLE ABEND.
    ['csharp', 'csharp-rereview'], ['java', 'java-rereview'], ['php', 'php-rereview'], ['vbnet', 'vbnet-rereview'],
    ['csharp', 'csharp-names'], ['java', 'java-names'], ['vbnet', 'vbnet-names'], ['php', 'php-names'], ['cobol', 'cobol-format']];
  for (const [lang, name, prefix = 'expected_', options = []] of cases) {
    const out = path.join(root, `${name}-${prefix}`), fixture = path.join(kitRoot, 'fixtures', name);
    // -I: the mapper must find its shared modules without the script directory on sys.path.
    const r = await runProcess(python, ['-I', path.join(kitRoot, `scripts/depmap_${lang}.py`), '--root', fixture, '--out', out, ...options]);
    assert.equal(r.code, 0, r.stderr);
    for (const file of ['edges.tsv', 'order.txt', 'cycles.txt', 'unresolved.tsv'])
      assert.equal(fs.readFileSync(path.join(out, file), 'utf8'), fs.readFileSync(path.join(fixture, `${prefix}${file}`), 'utf8'), `${name} ${prefix}${file}`);
    // Libraries no file declares go to external.tsv, never to unresolved.tsv.
    const external = path.join(fixture, `${prefix}external.tsv`);
    assert.equal(fs.readFileSync(path.join(out, 'external.tsv'), 'utf8'),
      fs.existsSync(external) ? fs.readFileSync(external, 'utf8') : 'namespace\tfiles\tfirst_file\n', `${name} ${prefix}external.tsv`);
  }
});

test('a directory symlink loop is walked once', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'A.cs'), 'class A { }\n');
  fs.writeFileSync(path.join(root, 'B.cs'), 'class B { A a; }\n');
  fs.symlinkSync('..', path.join(root, 'sub', 'loop'));
  const out = path.join(root, '..', `${path.basename(root)}-out`);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_csharp.py'), '--root', root, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /files=2 edges=1 /);
  assert.match(r.stderr, /symlink loop not followed: sub\/loop\//);
});

test('a missing ProjectReference, a conditional alias and an unread Maven groupId are warned about', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-refs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const csharp = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_csharp.py'),
    '--root', path.join(kitRoot, 'fixtures/csharp-rereview'), '--out', path.join(root, 'cs')]);
  assert.equal(csharp.code, 0, csharp.stderr);
  assert.match(csharp.stderr, /ProjectReference \.\.\\Lib\\Missing\.csproj is not found under --root \(RefName\/Lib\/Lib\.csproj is the project file there\)/);
  assert.match(csharp.stderr, /CondAlias: global alias Model has 2 targets \(CA\.Model, CB\.Model\)/);
  const tree = path.join(root, 'maven');
  for (const [dir, group] of [['a', 'one'], ['b', 'two']]) {
    fs.mkdirSync(path.join(tree, dir), { recursive: true });
    fs.writeFileSync(path.join(tree, dir, 'pom.xml'), `<project><groupId>${group}</groupId><artifactId>core</artifactId></project>\n`);
  }
  fs.mkdirSync(path.join(tree, 'app'));
  fs.writeFileSync(path.join(tree, 'app', 'pom.xml'), '<project><artifactId>app</artifactId><dependencies><dependency>'
    + '<groupId>${core.group}</groupId><artifactId>core</artifactId></dependency></dependencies></project>\n');
  const java = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_java.py'), '--root', tree, '--out', path.join(root, 'java')]);
  assert.equal(java.code, 0, java.stderr);
  assert.match(java.stderr, /app\/pom\.xml: dependency \$\{core\.group\}:core matches 2 modules \(a, b\)/);
});

test('a directory symlink that is not a loop is read under its own path', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'A.cs'), 'class A { }\n');
  fs.writeFileSync(path.join(root, 'B.cs'), 'class B { A a; }\n');
  fs.symlinkSync('sub', path.join(root, 'alias'));
  const out = path.join(root, '..', `${path.basename(root)}-out`);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_csharp.py'), '--root', root, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  // alias/A.cs and sub/A.cs are both files of the tree; B.cs gets an edge to each.
  assert.match(r.stdout, /files=3 edges=2 /);
});

test('a project tag with a raw < in an attribute value is warned about', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-lt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // MSBuild cannot load it either (it needs &lt;); the condition is lost, so say so.
  fs.writeFileSync(path.join(root, 'P.csproj'), '<Project ToolsVersion="4.0">\n<ItemGroup Condition="$(A) < 2">\n<Compile Include="A.cs" />\n</ItemGroup>\n</Project>\n');
  fs.writeFileSync(path.join(root, 'A.cs'), 'class A { }\n');
  const out = path.join(root, 'out');
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_csharp.py'), '--root', root, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /P\.csproj: tags not read at line 2 \(a raw < in an attribute value\?/);
});

test('deeply nested code is parsed, not a crash', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-deep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const n = 3000;
  fs.writeFileSync(path.join(root, 'A.cs'), `class A { void M() { var x = ${'('.repeat(n)}new B()${')'.repeat(n)}; var y = new List<${'List<'.repeat(n)}int${'>'.repeat(n)}>(); } }\n`);
  fs.writeFileSync(path.join(root, 'B.cs'), 'class B { }\n');
  const out = path.join(root, 'out');
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_csharp.py'), '--root', root, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'edges.tsv'), 'utf8'), 'from\tto\nA.cs\tB.cs\n');
});

test('long comma lists are scanned in linear time', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-long-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 20000 enum members took minutes when each comma walked back to its bracket.
  const members = Array.from({ length: 20000 }, (_, i) => `M${i}`);
  fs.writeFileSync(path.join(root, 'E.cs'), `public enum E { ${members.join(',\n')} }\nclass C { B b; int[] a = { ${members.join(', ')} }; }\n`);
  fs.writeFileSync(path.join(root, 'B.cs'), 'class B { }\n');
  const out = path.join(root, 'out'), started = Date.now();
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_csharp.py'), '--root', root, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Date.now() - started < 30000, `took ${Date.now() - started} ms`);
  assert.equal(fs.readFileSync(path.join(out, 'edges.tsv'), 'utf8'), 'from\tto\nE.cs\tB.cs\n');
});

test('Western text that also decodes as cp932 is read as Latin-1', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-cp1252-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A (c) sign in a Windows-1252 comment is a lone half-width katakana in cp932.
  fs.writeFileSync(path.join(root, 'A.cs'), Buffer.concat([Buffer.from('// '), Buffer.from([0xa9]), Buffer.from(' 2008\nclass A { B b; }\n')]));
  // Shift_JIS 日本です has kana, so it stays cp932.
  fs.writeFileSync(path.join(root, 'B.cs'), Buffer.concat([Buffer.from('// '), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x82, 0xc5, 0x82, 0xb7]), Buffer.from('\nclass B { }\n')]));
  const out = path.join(root, 'out');
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_csharp.py'), '--root', root, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /decoded as latin-1: .*A\.cs/);
  assert.match(r.stderr, /decoded as cp932: .*B\.cs/);
  assert.equal(fs.readFileSync(path.join(out, 'edges.tsv'), 'utf8'), 'from\tto\nA.cs\tB.cs\n');
});

test('a mapper survives a file name that is not UTF-8', { skip: process.platform !== 'linux' && 'needs a byte-string file system' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-bytes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  // 商品.cbl in Shift_JIS, as an unpacked legacy archive leaves it on Linux.
  const name = Buffer.concat([Buffer.from(src + '/'), Buffer.from([0x8f, 0xa4, 0x95, 0x69]), Buffer.from('.cbl')]);
  fs.writeFileSync(name, '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. SHOHIN.\n');
  fs.writeFileSync(path.join(src, 'main.cbl'), "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MAIN.\n       PROCEDURE DIVISION.\n           CALL 'SHOHIN'.\n");
  const out = path.join(root, 'out');
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_cobol.py'), '--root', src, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /file name is not UTF-8/);
  // The edge keeps the original bytes, so the path still opens.
  const edges = fs.readFileSync(path.join(out, 'edges.tsv'));
  assert.ok(edges.includes(Buffer.concat([Buffer.from('main.cbl\t'), Buffer.from([0x8f, 0xa4, 0x95, 0x69])])), edges.toString('latin1'));
});

test('typed-language mappers give the same output under every hash seed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Set iteration order follows PYTHONHASHSEED; the output must not. (No -I:
  // it would ignore PYTHONHASHSEED.)
  for (const [lang, name] of [['csharp', 'csharp-scopes'], ['csharp', 'csharp-aliases'], ['csharp', 'csharp-review'], ['vbnet', 'vbnet-items'], ['csharp', 'csharp'],
    ['csharp', 'csharp-final'], ['csharp', 'csharp-msbuild'], ['vbnet', 'vbnet-final']]) {
    const fixture = path.join(kitRoot, 'fixtures', name);
    for (const seed of ['0', '1', '2', '3']) {
      const out = path.join(root, `${name}-${seed}`);
      const r = await runProcess(python, [path.join(kitRoot, `scripts/depmap_${lang}.py`), '--root', fixture, '--out', out],
        { env: { ...process.env, PYTHONHASHSEED: seed } });
      assert.equal(r.code, 0, r.stderr);
      for (const file of ['edges.tsv', 'order.txt', 'unresolved.tsv'])
        assert.equal(fs.readFileSync(path.join(out, file), 'utf8'), fs.readFileSync(path.join(fixture, `expected_${file}`), 'utf8'), `${name} seed ${seed} ${file}`);
    }
  }
});

test('original Python, C and TS dependency fixtures retain byte-for-byte outputs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-depmap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const lang of ['python', 'c', 'ts']) {
    const script = path.join(kitRoot, `scripts/depmap_${lang}.${lang === 'ts' ? 'mjs' : 'py'}`);
    const out = path.join(root, lang), fixture = path.join(kitRoot, 'fixtures', lang);
    const r = await runProcess(lang === 'ts' ? process.execPath : python, [script, '--root', fixture, '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    for (const file of ['edges.tsv', 'order.txt', 'cycles.txt']) assert.equal(fs.readFileSync(path.join(out, file), 'utf8'), fs.readFileSync(path.join(fixture, `expected_${file}`), 'utf8'));
  }
  const manifest = path.join(root, 'manifest.tsv');
  const generated = await runProcess(python, [path.join(kitRoot, 'scripts/make_manifest.py'), '--order', path.join(kitRoot, 'fixtures/python/expected_order.txt'), '--out', manifest, '--sub', 'pkg/=ts/', '--sub', '.py=.ts']);
  assert.equal(generated.code, 0, generated.stderr);
  assert.equal(fs.readFileSync(manifest, 'utf8'), fs.readFileSync(path.join(kitRoot, 'fixtures/python/expected_manifest.tsv'), 'utf8'));
});

test('legacy Bash build transport preserves nonzero exit status', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = await runProcess('bash', [path.join(kitRoot, 'scripts/build_daemon.sh'), '--cmd', 'echo diagnostic; exit 7', '--once'], { cwd: root });
  assert.equal(r.code, 7);
  assert.equal(fs.readFileSync(path.join(root, 'migration/build-output-r1.txt.exit-code'), 'utf8').trim(), '7');
});
