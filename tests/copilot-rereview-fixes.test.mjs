import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake, ready, python } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, loadReviewDependencies, reviewSources, roles } from '../lib/core.mjs';
import { inventorySlice } from '../lib/review.mjs';
import { runStage, approve, translate } from '../lib/pipeline.mjs';
import { copilotArgs, requiredCopilotFlags } from '../scripts/copilot_adapter.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { makeReviewDependencies } from '../scripts/make_review_dependencies.mjs';
import { createWorkflowDefinition } from '../lib/workflow.mjs';
import { runProcess } from '../lib/process.mjs';
import { kitRoot } from '../scripts/install.mjs';

const write = (f, p, data) => atomicWrite(safePath(f.root, p), data);
const edges = 'migration/depmap/edges.tsv';

test('rereview 1: every CLI role disables ambient instructions; doctor rejects an unsupported CLI', async t => {
  for (const role of roles) assert.ok(copilotArgs(role, 'chosen-model').includes('--no-custom-instructions'));
  const f = prepare(t), command = safePath(f.root, 'help-double');
  const advertised = requiredCopilotFlags().filter(flag => flag !== '--no-custom-instructions').join(' ');
  write(f, 'help-double', `#!/bin/sh\nprintf '%s\\n' '${advertised}'\n`);
  fs.chmodSync(command, 0o755);
  const check = (await doctor(f.root, f.config, { checkCLI: true, command })).checks.find(c => c.check === 'required flags');
  assert.equal(check.ok, false); assert.deepEqual(check.missing, ['--no-custom-instructions']);
});

test('rereview 1: workflow cancellation reaches the shared runner without calling the host SDK agent', async t => {
  const f = await ready(t, { workflow: true }), controller = new AbortController(), started = safePath(f.root, 'worker-started.json');
  write(f, 'slow-cli.mjs', "import fs from 'node:fs'; for await (const c of process.stdin) {} fs.writeFileSync('worker-started.json', JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000);\n");
  const running = createWorkflowDefinition(f.root, { command: process.execPath, prefixArgs: [safePath(f.root, 'slow-cli.mjs')] }).run({
    args: { stage: 'translate' }, signal: controller.signal, phase() {}, log() {}, agent() { assert.fail('SDK agent must not run'); }
  });
  const rejected = assert.rejects(running, /Interrupted/);
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(started), 'Worker must start before cancelling');
  } finally { controller.abort(); }
  await rejected;
  assert.throws(() => process.kill(readJSON(started).pid, 0), e => e.code === 'ESRCH');
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('rereview 2: BOM before comments, blank lines or header produces identical frozen review inputs', async t => {
  for (const prefix of ['# 全体注記\r\n', '\r\n# 全体注記\r\n', '']) {
    const f = prepare(t), headerAndRows = 'file\tissue\tdecision\r\nsrc/math_ops.py\t負数除算\tfloor\r\nsrc/text_ops.py\t別の行\t除外\r\n';
    write(f, 'migration/inventory.tsv', '\uFEFF' + prefix + headerAndRows);
    const expected = (prefix + 'file\tissue\tdecision\r\nsrc/math_ops.py\t負数除算\tfloor\r\n').replaceAll('\r\n', '\n');
    assert.equal(inventorySlice(f.root, [f.units[0].source]), expected);
    await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'BOM fixture');
    const snapshots = [];
    const output = await translate(f.root, f.config, args => { if (args.reviewInput) snapshots.push(args.reviewInput); return fake(args); });
    assert.equal(output.done, 1); assert.equal(snapshots.length, 2); assert.equal(snapshots[0], snapshots[1]);
    assert.equal(JSON.parse(snapshots[0]).files.find(p => p.path === 'migration/inventory.tsv').content, expected);
  }
});

test('rereview 2: a BOM away from the start is not stripped to disguise an invalid header', t => {
  const f = prepare(t); write(f, 'migration/inventory.tsv', '# note\n\uFEFFfile\tissue\n');
  assert.throws(() => inventorySlice(f.root, [f.units[0].source]), /Inventory header/);
});

test('rereview 3: stock Python repo-root edges convert without doubled package prefixes or kit enumeration', async t => {
  const f = prepare(t);
  fs.cpSync(path.join(kitRoot, 'fixtures/python/pkg'), safePath(f.root, 'pkg'), { recursive: true });
  write(f, 'pkg/isolated.py', 'VALUE = "孤立"\n');
  write(f, 'tests/import_pkg.py', 'from pkg import a\n');
  const parser = await runProcess(python, [path.join(kitRoot, 'scripts/depmap_python.py'), '--root', f.root, '--out', safePath(f.root, 'migration/depmap')]);
  assert.equal(parser.code, 0, parser.stderr);
  assert.match(fs.readFileSync(safePath(f.root, edges), 'utf8'), /pkg\/a\.py\tpkg\/b\.py/);
  // Exercise the installed CLI entrypoint and its --depmap-root option.
  const converted = await runProcess(process.execPath, [safePath(f.root, 'migration-kit/scripts/make_review_dependencies.mjs'), '--root', f.root,
    '--source-root', 'pkg', '--depmap-root', '.', '--edges', edges]);
  assert.equal(converted.code, 0, converted.stderr);
  const report = JSON.parse(converted.stdout), deps = readJSON(safePath(f.root, report.out)).dependencies;
  assert.deepEqual(deps, {
    'pkg/__init__.py': ['pkg/c.py'], 'pkg/a.py': ['pkg/__init__.py', 'pkg/b.py'], 'pkg/b.py': [], 'pkg/c.py': ['pkg/a.py'], 'pkg/isolated.py': []
  });
  assert.ok(report.ignoredEdges.some(e => e.from === 'tests/import_pkg.py' && e.to === 'pkg/a.py'));
  assert.equal(report.ignoredEdgeCount, report.ignoredEdges.length);
  f.config.sourceRoots = ['pkg']; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  assert.deepEqual(loadReviewDependencies(f.root, f.config), deps);
  assert.deepEqual(reviewSources(f.root, f.config, 'pkg/a.py'), ['pkg/__init__.py', 'pkg/a.py', 'pkg/b.py', 'pkg/c.py']);
});

test('rereview 3: multiple source roots retain cross-package dependencies; missing scope fails atomically', async t => {
  const f = prepare(t);
  write(f, 'pkg/a.py', 'from shared import helper\n'); write(f, 'shared/helper.py', 'VALUE = 1\n');
  write(f, edges, 'from\tto\npkg/a.py\tshared/helper.py\ntests/judge.py\tpkg/a.py\n');
  const existing = fs.readFileSync(safePath(f.root, 'migration/review-dependencies.json'), 'utf8');
  assert.throws(() => makeReviewDependencies(f.root, { sourceRoot: 'pkg', depmapRoot: '.', edges }), /outside source-roots.*shared\/helper/);
  assert.equal(fs.readFileSync(safePath(f.root, 'migration/review-dependencies.json'), 'utf8'), existing);
  const converted = await runProcess(process.execPath, [safePath(f.root, 'migration-kit/scripts/make_review_dependencies.mjs'), '--root', f.root,
    '--source-roots', 'pkg,shared', '--depmap-root', '.', '--edges', edges]);
  assert.equal(converted.code, 0, converted.stderr);
  const report = JSON.parse(converted.stdout);
  assert.deepEqual(report.ignoredEdges, [{ from: 'tests/judge.py', to: 'pkg/a.py' }]);
  f.config.sourceRoots = ['pkg', 'shared'];
  assert.deepEqual(loadReviewDependencies(f.root, f.config), { 'pkg/a.py': ['shared/helper.py'], 'shared/helper.py': [] });
});

test('rereview 3: invalid parser roots, metadata roots and unsafe edges never replace an existing map', t => {
  const f = prepare(t); write(f, edges, 'from\tto\nsrc/main.py\tsrc/math_ops.py\n');
  const before = fs.readFileSync(safePath(f.root, 'migration/review-dependencies.json'), 'utf8');
  fs.symlinkSync(safePath(f.root, 'src'), safePath(f.root, 'alias'));
  for (const opts of [
    { sourceRoot: 'src', depmapRoot: '..' }, { sourceRoot: 'src', depmapRoot: '/tmp' }, { sourceRoot: 'src', depmapRoot: 'alias' },
    { sourceRoot: 'src', depmapRoot: 'tests' }, { sourceRoot: '.', depmapRoot: '.' }, { sourceRoot: 'migration-kit', depmapRoot: '.' },
    { sourceRoots: [], depmapRoot: '.' }, { sourceRoots: ['src', 'src'], depmapRoot: '.' }, { sourceRoot: 'src', sourceRoots: ['src'], depmapRoot: '.' }
  ]) {
    assert.throws(() => makeReviewDependencies(f.root, { ...opts, edges }));
    assert.equal(fs.readFileSync(safePath(f.root, 'migration/review-dependencies.json'), 'utf8'), before);
  }
  for (const row of ['src/main.py\t../escape.py', 'tests/judge.py\t../escape.py', 'src/main.py\tsrc/missing.py', 'alias/main.py\tsrc/math_ops.py']) {
    write(f, edges, 'from\tto\n' + row + '\n');
    assert.throws(() => makeReviewDependencies(f.root, { sourceRoot: 'src', depmapRoot: '.', edges }));
    assert.equal(fs.readFileSync(safePath(f.root, 'migration/review-dependencies.json'), 'utf8'), before);
  }
});
