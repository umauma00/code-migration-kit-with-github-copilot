// SPDX-License-Identifier: Apache-2.0
// A local sandbox (2026-10-29 report): phase 03 could not write comparison B
// outside the repository, and doctor's reviewer-hook check could not use
// loopback, so the run stopped at 03 with a question about the sandbox. The
// kit now finds this during setup and asks once, before phase 00.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { install, kitRoot } from '../scripts/install.mjs';
import { prepare, modelCatalogCli } from './helpers.mjs';
import { readJSON, writeJSON, safePath } from '../lib/core.mjs';
import { localSandboxProbe, sandboxCheck, sandboxCheckName, sandboxQuestion, outsideDirs } from '../lib/sandbox.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { doctorGuidance } from '../lib/guidance.mjs';
import { runSettingsFile } from '../lib/run-settings.mjs';

// A path below a regular file cannot hold a directory on any platform.
function blockedDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'file'), '');
  return path.join(dir, 'file', 'below');
}

test('the probe passes where commands may write the temporary directory and use loopback, and leaves nothing behind', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-own-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = await localSandboxProbe({ dirs: [dir] });
  assert.deepEqual(probe, { ok: true, blocked: [] });
  assert.ok(outsideDirs().includes(path.resolve(os.tmpdir())));
  assert.deepEqual(fs.readdirSync(dir), [], 'the probe directory is removed');
  assert.deepEqual(sandboxCheck(probe), { check: sandboxCheckName, ok: true });
});

test('a blocked write or loopback is reported with where and why', async t => {
  const dir = blockedDir(t);
  const probe = await localSandboxProbe({ dirs: [os.tmpdir(), dir], host: '256.0.0.1', timeoutMs: 2000 });
  assert.equal(probe.ok, false);
  assert.deepEqual(probe.blocked.map(b => b.access), ['write', 'loopback']);
  assert.equal(probe.blocked[0].path, dir);
  const check = sandboxCheck(probe);
  assert.equal(check.ok, false);
  assert.match(check.detail, /^write .*below: \w+; loopback 256\.0\.0\.1: /);
  assert.match(check.note, /\/sandbox off/);
});

test('the setup question names what is blocked, recommends /sandbox off and never has the AI change the setting', () => {
  const probe = { ok: false, blocked: [{ access: 'write', path: '/tmp', error: 'EPERM' }, { access: 'loopback', host: '127.0.0.1', error: 'EPERM' }] };
  const ja = sandboxQuestion(probe, 'ja'), en = sandboxQuestion(probe, 'en');
  for (const q of [ja, en]) {
    assert.deepEqual(q.choices.map(c => c.value), ['off', 'allow', 'keep']);
    assert.match(q.choices[0].label, /\/sandbox off/);
    assert.match(q.question, /\/tmp/);
    assert.match(q.question, /127\.0\.0\.1/);
  }
  assert.match(ja.choices[0].label, /推奨/);
  assert.match(ja.question, /AI は変えません/);
  assert.match(en.choices[0].label, /recommended/);
  // Only the parts that are blocked are named, in the question and the allow choice.
  const loopbackOnly = { ok: false, blocked: [probe.blocked[1]] };
  assert.doesNotMatch(sandboxQuestion(loopbackOnly, 'ja').question, /書き込み/);
  assert.doesNotMatch(sandboxQuestion(loopbackOnly, 'ja').choices[1].label, /フォルダ/);
  assert.doesNotMatch(sandboxQuestion(loopbackOnly, 'en').choices[1].label, /folders/);
});

test('doctor reports a sandboxed session as a failed check with sandbox guidance, without --check-cli', async t => {
  const f = prepare(t);
  const dir = blockedDir(t);
  const report = await doctor(f.root, f.config, { sandboxProbe: () => localSandboxProbe({ dirs: [dir], timeoutMs: 2000 }) });
  const check = report.checks.find(c => c.check === sandboxCheckName);
  assert.equal(check.ok, false);
  assert.equal(report.ok, false);
  const [entry] = doctorGuidance(report, { root: f.root, language: 'ja' }).filter(g => g.targets.includes(sandboxCheckName));
  assert.equal(entry.guidance.id, 'local-sandbox');
  assert.equal(entry.guidance.options[0].id, 'sandbox-off');
  assert.equal(entry.guidance.options[0].command, '/sandbox off');
  const passing = await doctor(f.root, f.config);
  assert.equal(passing.checks.find(c => c.check === sandboxCheckName).ok, true, 'an unrestricted session passes');
});

test('a reviewer-hook check failed by blocked loopback is explained as the sandbox, not the CLI', () => {
  const report = { checks: [{ check: 'tool-assisted reviewer hook loads in prompt mode', ok: false, cause: 'local-sandbox', detail: 'Loopback is blocked' },
    { check: 'tool-assisted reviewer hook loads in prompt mode', ok: false, detail: 'The worker hook did not deny' }] };
  const [sandboxed, cli] = doctorGuidance(report, { language: 'en' });
  assert.equal(sandboxed.guidance.id, 'local-sandbox');
  assert.notEqual(cli.guidance.id, 'local-sandbox');
});

function setupProject(t, phaseMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, layout: 'repository', language: 'ja' });
  for (const dir of ['src', 'tests']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'src/A.cs'), 'class A {}\n');
  const copilot = modelCatalogCli(root, [{ id: 'small-model', name: 'Small Model', supportedReasoningEfforts: ['low', 'medium', 'high'] }]);
  // The temporary directory is where a sandbox blocks writes; point it at a
  // path that cannot be created to stand in for one.
  const blocked = blockedDir(t);
  const run = (env, ...args) => spawnSync(process.execPath, [path.join(kitRoot, 'scripts/run_migration.mjs'), ...args, '--copilot', copilot],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
  const sandboxed = { TMPDIR: blocked, TMP: blocked, TEMP: blocked };
  assert.equal(run({}, 'settings', 'init').status, 0);
  const s = readJSON(safePath(root, runSettingsFile));
  Object.assign(s, { reportLanguage: 'ja', originalRuntime: 'available', sourceLanguage: 'C#', targetLanguage: 'TypeScript' });
  for (const role of Object.keys(s.models)) if (role !== 'surveyor') s.models[role] = { model: 'small-model', effort: 'default' };
  s.phaseMode = phaseMode;
  writeJSON(safePath(root, runSettingsFile), s);
  return { root, run, sandboxed };
}
test('settings apply asks the sandbox question during setup, and not once phase 00 started', t => {
  const { run, sandboxed } = setupProject(t, 'normal');
  let out = run(sandboxed, 'settings', 'apply');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  let result = JSON.parse(out.stdout);
  assert.equal(result.applied, true);
  assert.equal(result.sandbox.ok, false);
  assert.deepEqual(result.sandboxQuestion.choices.map(c => c.value), ['off', 'allow', 'keep']);
  assert.match(result.next, /^The local sandbox check failed\. Before anything else/);
  out = run({}, 'settings', 'apply');
  result = JSON.parse(out.stdout);
  assert.equal(result.sandboxQuestion, undefined, 'an unrestricted session is not asked');
  assert.equal(run({}, 'phase', 'init').status, 0);
  assert.equal(run({}, 'phase', 'start', '00').status, 0);
  result = JSON.parse(run(sandboxed, 'settings', 'apply').stdout);
  assert.equal(result.sandboxQuestion, undefined, 'after setup, doctor and phase 03 report it instead');
});

test('in auto mode the sandbox question comes before the autopilot handoff', t => {
  const { run, sandboxed } = setupProject(t, 'auto');
  const out = run(sandboxed, 'settings', 'apply');
  const result = JSON.parse(out.stdout);
  assert.equal(result.applied, true, out.stdout + out.stderr);
  assert.ok(result.autoHandoff, 'the handoff is still shown');
  assert.ok(result.sandboxQuestion);
  assert.match(result.next, /before autoHandoff[\s\S]* Then: Show autoHandoff/);
});
