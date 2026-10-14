import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, ready, result, fake, finding } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, contextHash, done, loadConfig, loadReviewDependencies, reviewSources, unitState } from '../lib/core.mjs';
import { reviewInput, validateWorkerProfile } from '../lib/review.mjs';
import { translate, runStage, approve } from '../lib/pipeline.mjs';
import { parseCopilotOutput, createCopilotAdapter, copilotArgs } from '../scripts/copilot_adapter.mjs';
import { makeReviewDependencies } from '../scripts/make_review_dependencies.mjs';
import { doctor } from '../scripts/run_migration.mjs';

const write = (f, name, value) => atomicWrite(safePath(f.root, name), value);
const map = (f, dependencies) => writeJSON(safePath(f.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies });
const jsonl = events => events.map(e => JSON.stringify(e)).join('\n');
const message = (content, extra = {}) => ({ type: 'assistant.message', data: { content, toolRequests: [], ...extra } });
const success = { type: 'result', exitCode: 0 };

test('C1: machine output preserves long code strings, Unicode and fenced final JSON', t => {
  const f = prepare(t), expected = result('implementer', f.units[0], { content: `export const text = ${JSON.stringify('日本語 😀 "\\'.repeat(300))};\n` });
  const events = [{ type: 'session.info', data: {} }, message('Inspecting the source', { toolRequests: [{ name: 'view' }] }),
    { type: 'tool.execution_complete', data: { result: { content: 'unrelated JSON' } } },
    message('```json\n' + JSON.stringify(expected) + '\n```'), success];
  assert.deepEqual(parseCopilotOutput(jsonl(events)), expected);
  assert.equal(copilotArgs('implementer', 'chosen')[copilotArgs('implementer', 'chosen').indexOf('--output-format') + 1], 'json');
});

test('C1: child responses cannot replace the main final reply', t => {
  const f = prepare(t), expected = result('reviewer-rules', f.units[0]);
  const child = message('child reply'); child.agentId = 'child-1';
  assert.deepEqual(parseCopilotOutput(jsonl([message(JSON.stringify(expected)), child,
    message('legacy child reply', { parentToolCallId: 'task-1' }), success])), expected);
});

test('C1: malformed, truncated, failed and unfinished-tool streams never reuse older JSON', t => {
  const f = prepare(t), valid = message(JSON.stringify(result('implementer', f.units[0])));
  for (const events of [[valid], [success], [valid, { ...success, exitCode: 7 }], [valid, { type: 'session.error', data: {} }, success],
    [valid, { type: 'abort', data: {} }, success], [valid, message('tool', { toolRequests: [{ name: 'view' }] }), success],
    [valid, message(''), success], [valid, message('not a JSON result'), success], [valid, success, valid],
    [valid, { type: 'assistant.turn_start', data: { turnId: 'next' } }, success],
    [valid, { type: 'assistant.message', data: {} }, success], [valid, { type: 'assistant.message', data: { content: 'x', toolRequests: {} } }, success]]) {
    assert.throws(() => parseCopilotOutput(jsonl(events)));
  }
  assert.throws(() => parseCopilotOutput(jsonl([valid, success]) + '\nBROKEN'), /valid JSONL/);
  assert.throws(() => parseCopilotOutput(JSON.stringify(result('implementer', f.units[0]))), /event order/);
});

test('C1: a failed terminal event retains process evidence and writes no candidate', async t => {
  const f = await ready(t);
  write(f, 'failed-cli.mjs', `console.log(${JSON.stringify(jsonl([message(JSON.stringify(result('implementer', f.units[0]))), { ...success, exitCode: 9 }]))});`);
  const adapter = createCopilotAdapter({ command: process.execPath, prefixArgs: [safePath(f.root, 'failed-cli.mjs')] });
  await assert.rejects(translate(f.root, f.config, adapter), /exit 9/);
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.status, 'blocked'); assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false);
  const dir = path.dirname(safePath(f.root, statePathFromRuns(f.root)));
  const attempt = fs.readdirSync(dir).find(p => p.includes('-implementer-'));
  const record = readJSON(path.join(dir, attempt));
  assert.equal(record.process.code, 0); assert.match(record.process.stdout, /"exitCode":9/);
});
function statePathFromRuns(root) {
  const run = fs.readdirSync(safePath(root, 'migration/runs'))[0];
  return `migration/runs/${run}/summary.json`;
}

test('C2: unrelated large/binary sources and inventory rows do not enter a small unit review', async t => {
  const f = prepare(t), unit = f.units[0];
  write(f, 'src/unrelated.txt', 'X'.repeat(5 * 1024 * 1024));
  write(f, 'src/unrelated.bin', Buffer.from([0, 255]));
  write(f, 'migration/inventory.tsv', '# Global vocabulary\nfile\tissue\tdecision\nsrc/math_ops.py\tdivision\tfloor\n' +
    Array.from({ length: 2000 }, (_, i) => `src/unrelated-${i}.py\tunrelated\t${'X'.repeat(80)}\n`).join(''));
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Audited narrow scope');
  const inputs = [];
  await translate(f.root, f.config, args => { if (args.reviewInput) inputs.push(args.reviewInput); return fake(args); });
  assert.equal(inputs.length, 2); assert.equal(inputs[0], inputs[1]);
  const snapshot = JSON.parse(inputs[0]);
  assert.deepEqual(snapshot.sources, [unit.source]);
  assert.deepEqual(snapshot.files.map(p => p.path).sort(), ['migration/RULEBOOK.md', 'migration/inventory.tsv', unit.target, unit.source].sort());
  const inventory = snapshot.files.find(p => p.path === 'migration/inventory.tsv').content;
  assert.match(inventory, /Global vocabulary/); assert.doesNotMatch(inventory, /unrelated/);
  assert.ok(Buffer.byteLength(inputs[0]) < 65536);
});

test('C2: transitive dependency closure handles cycles and selects inventory by exact file path', t => {
  const f = prepare(t, { count: 3 }), unit = f.units[2];
  map(f, { 'src/main.py': ['src/math_ops.py'], 'src/math_ops.py': ['src/text_ops.py'], 'src/text_ops.py': ['src/main.py'] });
  write(f, unit.target, result('implementer', unit).content);
  write(f, 'migration/inventory.tsv', '# Global note\nfile\tissue\tdecision\nsrc/math_ops.py\tx\ty\nsrc/math_ops.py.extra\tDROP\tDROP\nsrc/text_ops.py\ta\tb\n');
  const snapshot = JSON.parse(reviewInput(f.root, f.config, unit).text);
  assert.deepEqual(snapshot.sources, ['src/main.py', 'src/math_ops.py', 'src/text_ops.py']);
  assert.doesNotMatch(snapshot.files.find(p => p.path === 'migration/inventory.tsv').content, /DROP/);
});

test('C2: graph and excluded-directory dependency changes invalidate completed receipts', async t => {
  const f = prepare(t), unit = f.units[0];
  write(f, 'src/node_modules/helper.py', 'VALUE = 1\n');
  map(f, { [unit.source]: ['src/node_modules/helper.py'], 'src/node_modules/helper.py': [] });
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Explicit dependency');
  await translate(f.root, f.config, fake);
  const before = contextHash(f.root, f.config); assert.equal(done(f.root, unit, before), true);
  write(f, 'src/node_modules/helper.py', 'VALUE = 2\n');
  assert.notEqual(contextHash(f.root, f.config), before); assert.equal(done(f.root, unit, contextHash(f.root, f.config)), false);
  const changed = contextHash(f.root, f.config);
  map(f, { [unit.source]: [], 'src/node_modules/helper.py': [] });
  assert.notEqual(contextHash(f.root, f.config), changed);
});

test('C2: missing declarations, missing files and unsafe dependency paths fail closed', t => {
  const f = prepare(t), unit = f.units[0];
  map(f, { [unit.source]: ['src/text_ops.py'] });
  assert.throws(() => reviewSources(f.root, f.config, unit.source), /declaration missing: src\/text_ops.py/);
  for (const deps of [['../escape.py'], ['tests/judge.py'], ['src/missing.py']]) {
    map(f, { [unit.source]: deps }); assert.throws(() => loadReviewDependencies(f.root, f.config));
  }
  fs.symlinkSync(safePath(f.root, 'src/text_ops.py'), safePath(f.root, 'src/link.py'));
  map(f, { [unit.source]: ['src/link.py'], 'src/link.py': [] });
  assert.throws(() => loadReviewDependencies(f.root, f.config), /Symlinks/);
  fs.rmSync(safePath(f.root, 'migration/review-dependencies.json'));
  assert.throws(() => contextHash(f.root, f.config), /dependency map missing/);
  for (const p of ['ported/map.json', 'migration/state/map.json']) {
    f.config.reviewDependencyMap = p; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
    assert.throws(() => loadConfig(f.root), /reviewDependencyMap/);
  }
});

test('C2: unknown inventory headers and malformed unrelated rows block before model calls', async t => {
  for (const inventory of ['source\tissue\nx\ty\n', 'file\tissue\nsrc/unrelated.py\tx\textra\n']) {
    const f = prepare(t), calls = [];
    write(f, 'migration/inventory.tsv', inventory);
    await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Invalid inventory fixture');
    await assert.rejects(translate(f.root, f.config, args => { calls.push(args.role); return fake(args); }), /Inventory header|Malformed inventory/);
    assert.deepEqual(calls, []);
  }
});

test('C2: preflight measures escaped JSON bytes; oversized generated candidates still block reviewers', async t => {
  const f = prepare(t), calls = [];
  f.config.maxReviewInputBytes = 4096;
  write(f, f.units[0].source, '"'.repeat(2500));
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Escaped byte fixture');
  await assert.rejects(translate(f.root, f.config, args => { calls.push(args.role); return fake(args); }), /maxReviewInputBytes/);
  assert.deepEqual(calls, []);
  const g = prepare(t), candidateCalls = []; g.config.maxReviewInputBytes = 2048; g.config.commands.typecheck = null;
  writeJSON(safePath(g.root, 'migration/config.json'), g.config);
  await runStage(g.root, g.config, 'judge'); approve(g.root, g.config, 'translation', 'Candidate limit fixture');
  await assert.rejects(translate(g.root, g.config, args => { candidateCalls.push(args.role); return { result: result(args.role, args.unit, { content: 'X'.repeat(5000) }) }; }), /maxReviewInputBytes/);
  assert.deepEqual(candidateCalls, ['implementer']);
});

test('C2: dependency-map conversion keeps isolated nodes and refuses malformed input atomically', t => {
  const f = prepare(t);
  write(f, 'migration/depmap/edges.tsv', 'from\tto\nmain.py\tmath_ops.py\nmain.py\tmath_ops.py\n');
  const generated = makeReviewDependencies(f.root, { sourceRoot: 'src', edges: 'migration/depmap/edges.tsv' });
  assert.equal(generated.files, 3);
  assert.deepEqual(loadReviewDependencies(f.root, f.config), { 'src/main.py': ['src/math_ops.py'], 'src/math_ops.py': [], 'src/text_ops.py': [] });
  const before = fs.readFileSync(safePath(f.root, generated.out), 'utf8');
  for (const edges of ['bad\theader\n', 'from\tto\nmain.py\t../escape.py\n', 'from\tto\nmissing.py\tmain.py\n']) {
    write(f, 'migration/depmap/edges.tsv', edges);
    assert.throws(() => makeReviewDependencies(f.root, { sourceRoot: 'src', edges: 'migration/depmap/edges.tsv' }));
    assert.equal(fs.readFileSync(safePath(f.root, generated.out), 'utf8'), before);
  }
});

test('C2: changed invalid evidence is rejected before another model call', async t => {
  const f = await ready(t), calls = [];
  await assert.rejects(translate(f.root, f.config, args => {
    calls.push(args.role);
    if (args.role.startsWith('reviewer-')) return { result: result(args.role, args.unit, { findings: [finding] }) };
    if (args.role === 'arbiter') write(f, args.unit.source, Buffer.from([255]));
    return fake(args);
  }), /valid UTF-8|Migration inputs changed during worker invocation/);
  assert.equal(calls.includes('arbiter'), true); assert.equal(calls.includes('fixer'), false);
});

test('C3: workers require concrete CLI read tools; aliases or added write tools are rejected', t => {
  const f = prepare(t);
  for (const role of ['implementer', 'fixer', 'arbiter']) {
    validateWorkerProfile(f.root, role);
    const name = `.github/agents/migration-${role}.agent.md`, original = fs.readFileSync(safePath(f.root, name), 'utf8');
    for (const tools of ['["read", "search"]', '["view", "grep", "glob", "edit"]']) {
      write(f, name, original.replace('["view", "grep", "glob"]', tools));
      assert.throws(() => validateWorkerProfile(f.root, role), /view.*grep.*glob/);
    }
    write(f, name, original);
  }
  validateWorkerProfile(f.root, 'reviewer-semantics');
});

test('C1: doctor requires the machine-output flag', async t => {
  const f = prepare(t), command = safePath(f.root, 'cli-help');
  write(f, 'cli-help', '#!/bin/sh\nprintf "%s\\n" "--agent --model --available-tools --deny-tool"\n');
  fs.chmodSync(command, 0o755);
  const report = await doctor(f.root, f.config, { checkCLI: true, command });
  assert.equal(report.checks.find(c => c.check === 'required flags').ok, false);
});
