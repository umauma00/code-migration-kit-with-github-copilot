import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, ready, fake, result, finding, cliOutput } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, loadConfig, readManifest, contextHash, done, roles } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { runProcess } from '../lib/process.mjs';
import { copilotArgs } from '../scripts/copilot_adapter.mjs';
import { doctor } from '../scripts/run_migration.mjs';

const write = (f, name, content) => atomicWrite(safePath(f.root, name), content);
const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);

// Model directory aliases without requiring a particular host filesystem.
// Real-filesystem coverage for the same assertions is still needed on macOS.
function aliasDirectory(t, root, from, to, enabled = () => true, canonical = true) {
  const alias = path.join(root, from), original = path.join(root, to);
  const resolve = value => enabled() && typeof value === 'string' &&
    (value === alias || value.startsWith(`${alias}${path.sep}`)) ? original + value.slice(alias.length) : value;
  for (const method of ['existsSync', 'lstatSync', 'statSync', 'realpathSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'rmSync', 'readdirSync', 'renameSync', 'openSync']) {
    const originalMethod = fs[method];
    t.mock.method(fs, method, (...args) => {
      const requested = args[0];
      args[0] = resolve(args[0]);
      if (method === 'renameSync') args[1] = resolve(args[1]);
      const value = originalMethod(...args);
      // Some platforms preserve the requested spelling in realpath output.
      return method === 'realpathSync' && !canonical && requested !== args[0] ? requested : value;
    });
  }
}

test('output aliases of protected roots are rejected, including absent descendants', t => {
  const f = prepare(t), before = fs.readFileSync(safePath(f.root, 'src/math_ops.py'), 'utf8');
  for (const [alias, original] of [['SRC', 'src'], ['TESTS', 'tests'], ['MIGRATION', 'migration']]) {
    for (const canonical of [true, false]) {
      aliasDirectory(t, f.root, alias, original, undefined, canonical);
      try {
        for (const output of [alias, `${alias}/new/deeper`]) {
          f.config.outputRoots = [output]; persist(f);
          assert.throws(() => loadConfig(f.root), /Output root overlaps protected path/, output);
        }
      } finally { t.mock.restoreAll(); }
    }
  }
  assert.equal(fs.readFileSync(safePath(f.root, 'src/math_ops.py'), 'utf8'), before);
});

test('distinct directories on a case-sensitive filesystem remain usable', t => {
  const f = prepare(t);
  if (fs.existsSync(path.join(f.root, 'SRC'))) { t.skip('Requires a case-sensitive filesystem'); return; }
  fs.mkdirSync(path.join(f.root, 'SRC'));
  f.config.outputRoots = ['SRC/new']; persist(f);
  assert.deepEqual(loadConfig(f.root).outputRoots, ['SRC/new']);
});

test('manifest rejects an aliased destination even when supplied config was not reloaded', t => {
  const f = prepare(t);
  f.config.outputRoots = ['SRC'];
  write(f, 'migration/manifest.tsv', 'source\ttarget\nsrc/math_ops.py\tSRC/math_ops.py\n');
  aliasDirectory(t, f.root, 'SRC', 'src');
  try { assert.throws(() => readManifest(f.root, f.config), /overlaps protected/); }
  finally { t.mock.restoreAll(); }
});

test('manifest rejects source and destination referring to the same file through hard links', t => {
  const f = prepare(t), source = safePath(f.root, f.units[0].source), target = safePath(f.root, f.units[0].target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.linkSync(source, target);
  assert.throws(() => readManifest(f.root, f.config), /overlaps protected/);
});

test('a destination alias introduced during fixing is rejected before writing the original', async t => {
  const f = prepare(t), source = safePath(f.root, f.units[0].source), before = fs.readFileSync(source, 'utf8');
  f.config.commands.typecheck = null; persist(f);
  write(f, 'migration/manifest.tsv', 'source\ttarget\nsrc/math_ops.py\tported/math_ops.py\n');
  write(f, 'ported/math_ops.py', before);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Disposable alias regression fixture');
  let aliased = false;
  aliasDirectory(t, f.root, 'ported', 'src', () => aliased);
  try {
    await assert.rejects(translate(f.root, f.config, async args => {
      if (args.role === 'reviewer-semantics' && !aliased) return { result: result(args.role, args.unit, { findings: [finding] }) };
      if (args.role === 'fixer') {
        aliased = true;
        return { result: result(args.role, args.unit, { content: 'export const overwritten = true;\n' }) };
      }
      return fake(args);
    }), /overlaps protected/);
    assert.equal(aliased, true, 'The change must reach the write guard');
    assert.equal(fs.readFileSync(source, 'utf8'), before);
    assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  } finally { t.mock.restoreAll(); }
});

test('normal CLI resume fails if a previously completed output changes while another unit is reviewed', async t => {
  const f = prepare(t, { count: 2 });
  f.config.concurrency = 1; persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Disposable resume regression fixture');
  await assert.rejects(translate(f.root, f.config, args => {
    if (args.unit.target === f.units[1].target && args.role === 'reviewer-semantics') throw new Error('Transient reviewer failure');
    return fake(args);
  }), /Transient reviewer failure/);
  const context = contextHash(f.root, f.config);
  assert.equal(done(f.root, f.units[0], context), true);
  assert.equal(done(f.root, f.units[1], context), false);
  const command = safePath(f.root, 'resume-cli.mjs');
  write(f, 'resume-cli.mjs', `#!/usr/bin/env node
import fs from 'node:fs';
for await (const chunk of process.stdin) {}
fs.writeFileSync('review-started', 'ready');
const deadline = Date.now() + 10000;
while (!fs.existsSync('editor-saved') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
if (!fs.existsSync('editor-saved')) process.exit(2);
const responses = ${JSON.stringify(Object.fromEntries(['reviewer-semantics', 'reviewer-rules'].map(role => [role, cliOutput(result(role, f.units[1]))])))};
console.log(responses[process.env.MIGRATION_KIT_ROLE]);
`);
  fs.chmodSync(command, 0o755);
  const controller = new AbortController();
  const running = runProcess(process.execPath, [safePath(f.root, 'migration-kit/scripts/run_migration.mjs'), 'translate', '--root', f.root, '--copilot', command],
    { cwd: f.root, signal: controller.signal, timeoutMs: 15000 });
  let outcome;
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(safePath(f.root, 'review-started')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(safePath(f.root, 'review-started')), 'CLI must begin the resumed review');
    fs.appendFileSync(safePath(f.root, f.units[0].target), '\n// External editor save during resume\n');
    write(f, 'editor-saved', 'saved');
    outcome = await running;
  } finally { controller.abort(); await running; }
  assert.equal(outcome.code, 1, outcome.stderr);
  assert.match(outcome.stderr, /Reviewed receipts incomplete/);
  assert.equal(contextHash(f.root, f.config), context);
  assert.equal(done(f.root, f.units[0], context), false);
  assert.equal(done(f.root, f.units[1], context), true);
  const summaries = fs.readdirSync(safePath(f.root, 'migration/runs')).map(run => readJSON(safePath(f.root, `migration/runs/${run}/summary.json`)));
  const last = summaries.find(run => !run.errors.length);
  assert.equal(last.done, 1); assert.equal(last.total, 2);
  assert.throws(() => approve(f.root, f.config, 'build', 'Must reject changed output'), /current reviewed receipts/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('repair may complete its selected target while other translation units remain pending', async t => {
  const f = await ready(t, { count: 2 });
  write(f, f.units[0].target, result('implementer', f.units[0]).content);
  write(f, 'migration/diagnostic.txt', 'Review only the selected fixture target.');
  const report = await translate(f.root, f.config, fake, { onlyTarget: f.units[0].target, evidence: 'migration/diagnostic.txt' });
  assert.equal(report.done, 1); assert.equal(report.total, 2);
  assert.equal(fs.existsSync(safePath(f.root, f.units[1].target)), false);
});

test('doctor rejects every required worker flag missing from help, including short flags', async t => {
  const f = prepare(t), command = safePath(f.root, 'help-cli');
  const flags = [...new Set(roles.flatMap(role => copilotArgs(role, 'test-double').filter(arg => arg.startsWith('-'))))];
  for (const missing of [null, ...flags]) {
    const help = flags.filter(flag => flag !== missing).join(' ') + (missing ? ` ${missing}-unsupported` : '');
    write(f, 'help-cli', `#!/bin/sh\nprintf '%s\\n' '${help}'\n`);
    fs.chmodSync(command, 0o755);
    const report = await doctor(f.root, f.config, { checkCLI: true, command });
    const check = report.checks.find(item => item.check === 'required flags');
    assert.equal(check.ok, missing === null, String(missing));
    assert.deepEqual(check.missing, missing ? [missing] : []);
  }
});
