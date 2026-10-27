// SPDX-License-Identifier: Apache-2.0
// Regressions for the 2026-10-27 review of 0.6.0. None of these adds a stop
// based on time, CPU or output volume: continuous execution stays continuous.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kitRoot } from '../scripts/install.mjs';
import { atomicWrite, safePath, writeJSON, readJSON } from '../lib/core.mjs';
import { ignoredLimits } from '../lib/execution-policy.mjs';
import { runProcess, processOutputLines, relativeProcessOutput } from '../lib/process.mjs';
import { translate, runStage, approve, runCommand } from '../lib/pipeline.mjs';
import { buildLoop } from '../lib/build-loop.mjs';
import { runSurvey, surveyStatus } from '../lib/survey.mjs';
import { surveyRequests } from '../lib/survey-parts.mjs';
import { moduleSpecifiers } from '../scripts/depmap_js_scan.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { createCopilotAdapter } from '../scripts/copilot_adapter.mjs';
import { prepare, fake, python } from './helpers.mjs';

test('limits written in a continuous configuration are named, not silently ignored', async t => {
  const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/migration-config.json'), 'utf8'));
  assert.deepEqual(ignoredLimits(template), [], 'the template defaults are not reported');
  const legacy = { ...template, maxAgentCalls: 40, maxAiCreditsPerCall: 30, maxRunInputBytes: 5000000, commandTimeoutSeconds: 600 };
  delete legacy.executionMode;
  assert.deepEqual(ignoredLimits(legacy), ['maxAgentCalls', 'commandTimeoutSeconds', 'maxRunInputBytes', 'maxAiCreditsPerCall']);
  assert.deepEqual(ignoredLimits({ ...legacy, executionMode: 'bounded' }), []);
  const f = prepare(t, { executionMode: 'continuous' });
  f.config.maxAiCreditsPerCall = 30;
  const report = await doctor(f.root, f.config);
  const check = report.checks.find(c => c.check === 'execution limits');
  assert.equal(check.ok, true, 'a warning, never a failed check or a stop');
  assert.ok(check.ignored.includes('maxAiCreditsPerCall'));
  assert.match(check.note, /"executionMode": "bounded"/);
});

test('a continuous build-loop records a stalled error count and keeps going until clean', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  f.config.commands.build = [process.execPath, '-e', `
const fs = require('node:fs'), file = 'migration/build-count.txt';
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(file, String(n));
if (n < 5) { console.error('ported/math_ops.mjs:1:1: error: still broken'); process.exit(1); }
`];
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture until clean');
  await translate(f.root, f.config, fake);
  const progress = [];
  const report = await buildLoop(f.root, f.config, fake, { note: 'Fixture authorizes repairs until clean', onProgress: p => progress.push(p.stage) });
  assert.equal(report.stopped, 'clean'); assert.equal(report.rounds.length, 5);
  assert.equal(report.stalled.sinceRound, 1); assert.equal(report.stalled.latestRound, 4);
  assert.match(report.stalled.next, /rulebook amendment/);
  assert.equal(report.stalled.resolvedRound, 5, 'a loop that went clean marks the stall resolved');
  assert.ok(progress.some(s => /error count not falling since round 1; continuing/.test(s)));
});

test('an explicit --max-rounds still ends a continuous build-loop', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  f.config.commands.build = [process.execPath, '-e', "console.error('ported/math_ops.mjs:1:1: error: broken'); process.exit(1)"];
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture with two rounds');
  await translate(f.root, f.config, fake);
  const report = await buildLoop(f.root, f.config, fake, { note: 'Fixture authorizes two rounds', maxRounds: 2 });
  assert.equal(report.stopped, 'round-limit'); assert.equal(report.rounds.length, 2);
});

test('spilled process output is recorded relative to the root and still readable after the checkout moves', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-relative-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'a');
  fs.mkdirSync(root);
  const r = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000) + '\\nlast line\\n')"],
    { cwd: root, maxBytes: 1024, outputDir: path.join(root, 'migration/runs/process-output') });
  const recorded = relativeProcessOutput(r, root);
  assert.ok(recorded.outputSpooled);
  assert.match(recorded.stdoutFile, /^migration\/runs\/process-output\/migration-process-[^/]+\/stdout\.log$/);
  assert.ok(!recorded.stdoutFile.includes(base), 'no local path in the record');
  const moved = path.join(base, 'b');
  fs.renameSync(root, moved);
  assert.equal([...processOutputLines(recorded, 'stdout', moved)].filter(Boolean).at(-1), 'last line');
  // Records written by 0.6.0 hold absolute paths; they still read in place.
  const legacy = { ...recorded, stdoutFile: path.join(moved, recorded.stdoutFile) };
  assert.equal([...processOutputLines(legacy, 'stdout', moved)].filter(Boolean).at(-1), 'last line');
});

test('a worker that fails after spilling its output records the log relative to the root', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const file = safePath(f.root, 'failing-cli.mjs');
  fs.writeFileSync(file, `
if (process.argv.includes('--version')) { console.log('1.0.103'); process.exit(0); }
for await (const chunk of process.stdin) {}
const line = JSON.stringify({type:'progress', data:'x'.repeat(1000)}) + '\\n';
for (let i=0;i<18000;i++) process.stdout.write(line);
process.exitCode = 3;
`);
  const error = await createCopilotAdapter({ command: process.execPath, prefixArgs: [file] })({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0] }).catch(e => e);
  assert.match(error.message, /exit 3/);
  assert.ok(error.result.outputSpooled);
  assert.match(error.result.stdoutFile, /^migration\/runs\/process-output\//);
  assert.ok(fs.existsSync(path.join(f.root, error.result.stdoutFile)));
});

test('a worker cancelled after spilling its output records the log relative to the root', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  const file = safePath(f.root, 'slow-cli.mjs'), controller = new AbortController();
  fs.writeFileSync(file, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.0.103'); process.exit(0); }
for await (const chunk of process.stdin) {}
const line = JSON.stringify({type:'progress', data:'x'.repeat(1000)}) + '\\n';
for (let i=0;i<18000;i++) process.stdout.write(line);
process.stdout.write('', () => fs.writeFileSync('migration/written.flag', ''));
setInterval(() => {}, 1000);
`);
  const flag = safePath(f.root, 'migration/written.flag');
  const watcher = setInterval(() => { if (fs.existsSync(flag)) { clearInterval(watcher); controller.abort(); } }, 50);
  t.after(() => clearInterval(watcher));
  const error = await createCopilotAdapter({ command: process.execPath, prefixArgs: [file] })({ root: f.root, config: f.config, role: 'implementer', unit: f.units[0], signal: controller.signal }).catch(e => e);
  assert.ok(error.result?.outputSpooled, error.message);
  assert.match(error.result.stdoutFile, /^migration\/runs\/process-output\//);
  assert.ok(fs.existsSync(path.join(f.root, error.result.stdoutFile)));
});

test('a 0.6.0 absolute log record reads through a symlinked root', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-symlink-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, 'real'), link = path.join(base, 'link');
  fs.mkdirSync(real); fs.symlinkSync(real, link);
  const r = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000) + '\\nlast line\\n')"],
    { cwd: real, maxBytes: 1024, outputDir: path.join(real, 'migration/runs/process-output') });
  assert.equal([...processOutputLines(r, 'stdout', link)].filter(Boolean).at(-1), 'last line');
  assert.equal(relativeProcessOutput(r, link).stdoutFile.startsWith('migration/'), true);
});

test('runCommand keeps a small result unchanged', async t => {
  const f = prepare(t, { executionMode: 'continuous' });
  f.config.commands.build = [process.execPath, '-e', "console.log('ok')"];
  const r = await runCommand(f.root, f.config, 'build');
  assert.equal(r.code, 0); assert.equal(r.outputSpooled, undefined); assert.match(r.stdout, /ok/);
});

test('ordinary evidence text with host:port or numbers is not a foreign citation; a foreign source file still is', async t => {
  const f = prepare(t);
  f.config.sourceRoots = ['case']; f.config.concurrency = 1; f.config.maxAgentCalls = 1;
  atomicWrite(safePath(f.root, 'case/A.cs'), 'class A {}\n// calls api.example.com:8443\n');
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const answer = extra => async args => {
    const input = JSON.parse(args.reviewInput);
    return { result: { schemaVersion: 1, kind: 'survey', survey: 'contracts', target: args.unit.target,
      items: input.files.map(file => ({ file: file.path, publicInterface: 'class A', inputsOutputsErrors: 'none',
        edgeCases: 'unknown', evidence: `${file.path}:2 calls api.example.com:8443, example.rs:8080 and https://example.sh:443 via self.r:5; ratio 0.5:3${extra}`, unknowns: 'unknown' })) } };
  };
  // A foreign citation is never accepted: after one correction the row is
  // finished as uncited/unknown, and the foreign line is not kept as evidence.
  for (const foreign of [' and other/File.cs:5', ' and include/other.h:9', ' and Form1.frm:3', ' and src/lib.rs:3', ' and Lib.adb:3', ' and /home/u/proj/Other.java:5']) {
    fs.rmSync(safePath(f.root, 'migration/surveys'), { recursive: true, force: true });
    const report = await runSurvey(f.root, f.config, 'contracts', answer(foreign));
    assert.equal(report.done, 1);
    const item = readJSON(safePath(f.root, 'migration/surveys/contracts/001-case.json')).items[0];
    assert.equal(item.uncited, true); assert.ok(!item.evidence.includes(foreign.trim().slice(4)));
  }
  fs.rmSync(safePath(f.root, 'migration/surveys'), { recursive: true, force: true });
  const report = await runSurvey(f.root, f.config, 'contracts', answer(''));
  assert.equal(report.done, 1);
  assert.equal(surveyStatus(f.root, f.config, 'contracts').complete, true);
});

test('an oversized inventory request still surveys a file that has no census sites', () => {
  const content = Array.from({ length: 200 }, (_, i) => `${i + 1}|const value${i} = ${i};`).join('\n');
  const file = { path: 'src/big.js', firstLine: 1, lastLine: 200, content };
  const other = { path: 'src/small.js', firstLine: 1, lastLine: 1, content: '1|x()' };
  const site = { file: 'src/small.js', symbol: 'x', source_construct: 'call', line: 1 };
  const data = { kind: 'inventory', files: [file, other], sites: [site] };
  const request = { scope: { id: '001', files: [file.path, other.path] }, input: { text: JSON.stringify(data), sites: [site] } };
  const parts = surveyRequests('inventory', request, 2000);
  assert.ok(parts.some(p => p.scope.files[0] === 'src/big.js'), 'the site-less file is not dropped');
  assert.ok(parts.every(p => Buffer.byteLength(p.input.text) <= 2000));
  assert.ok(parts.filter(p => p.scope.files[0] === 'src/small.js').length >= 1);
});

test('a stray apostrophe in a C directive cannot expose a commented-out #include', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depmap-c-quote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src'), out = path.join(root, 'out');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'main.c'), "#error don't use\n/*\n#include \"b.h\"\n*/\n#include \"c.h\"\nchar q = '\\'';\n");
  fs.writeFileSync(path.join(src, 'b.h'), ''); fs.writeFileSync(path.join(src, 'c.h'), '');
  const r = await runProcess(python, ['-I', path.join(kitRoot, 'scripts/depmap_c.py'), '--root', src, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'edges.tsv'), 'utf8'), 'from\tto\nmain.c\tc.h\n');
});

test('a regex literal after a closing brace does not swallow later imports', () => {
  const specs = moduleSpecifiers("if (x) {}\n/'/.test(s);\nimport a from './a';\n").map(s => s.specifier ?? s);
  assert.ok(specs.includes('./a'), JSON.stringify(specs));
});
