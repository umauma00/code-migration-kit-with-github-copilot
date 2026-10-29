// SPDX-License-Identifier: Apache-2.0
// Long runner commands show their progress the same way (2026-10-29): a pilot
// run piped into Out-String showed "No output yet" for over an hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, ready, fake } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { writeJSON, safePath, atomicWrite } from '../lib/core.mjs';
import { runSurvey } from '../lib/survey.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { hiddenLongRun, humanGate, interactiveDecision } from '../lib/guardrails.mjs';
import { progressLine } from '../lib/command-progress.mjs';
import { setPreferences } from '../lib/preferences.mjs';

const kit = 'node migration-kit/scripts/run_migration.mjs';

test('progress lines share one format: time, finished/total, unit, stage, calls', () => {
  const at = new Date(2026, 9, 29, 9, 5, 7);
  assert.equal(progressLine({ unit: 'out/a.ts', stage: 'review', calls: 14, done: 3, total: 12 }, at), '09:05:07 [3/12] out/a.ts: review (agent calls 14)');
  assert.equal(progressLine({ unit: '(build-loop)', stage: 'build' }, at), '09:05:07 (build-loop): build');
  assert.equal(progressLine({ unit: 'u', stage: 'done', total: 0, done: 0 }, at), '09:05:07 u: done');
});

test('a piped or file-redirected long runner command is detected, the plain form is not', () => {
  const hidden = {
    // The reported command: the runner path held in a PowerShell variable.
    [`$r='C:\\Users\\me\\kit\\scripts\\run_migration.mjs'; node $r pilot run --root 'C:\\work\\pilot-03' 2>&1 | Out-String`]: 'pilot run',
    [`${kit} translate 2>&1 | tail -20`]: 'translate',
    [`${kit} translate > translate.log`]: 'translate',
    [`${kit} survey run --kind inventory | Select-Object -Last 5`]: 'survey run',
    [`${kit} build-loop --note "go" | tee loop.log`]: 'build-loop',
    [`node C:\\kit\\scripts\\run_migration.mjs repair-round | Out-File r.txt`]: 'repair-round',
    [`${kit} repair --target out/a.ts --evidence migration/x.txt | Out-String`]: 'repair',
    [`$r='C:\\kit\\scripts\\run_migration.mjs'; & $r pilot run --root X 2>&1 | Out-String`]: 'pilot run',
    [`$r='C:\\kit\\scripts\\run_migration.mjs'; node \${r} pilot run --root X | Out-String`]: 'pilot run',
    [`$r='C:\\kit\\scripts\\run_migration.mjs'; node $r pilot run \`\n  --root X | Out-String`]: 'pilot run',
    [`${kit} translate \\\n  --root X | tail -5`]: 'translate',
    ['R=$HOME/kit/scripts/run_migration.mjs; node "$R" translate | tee log']: 'translate',
    [`$script:r='C:\\k\\run_migration.mjs'; node $script:r translate | Out-String`]: 'translate',
    [`$log = (${kit} translate 2>&1 | Out-String)`]: 'translate',
    ['node /x/run_migration.mjs translate --root "$ROOT"\\\n  2>&1 | tee log']: 'translate',
    [`& node "$r" pilot run --root p | Out-String`]: null, // no runner path anywhere in the command
  };
  for (const [command, name] of Object.entries(hidden)) assert.equal(hiddenLongRun(command), name, command);
  for (const command of [
    `${kit} translate`, `${kit} translate 2>&1`, `${kit} translate *>&1`, `${kit} pilot run --root /tmp/p`,
    `$r='C:\\kit\\scripts\\run_migration.mjs'; node $r pilot run --root 'C:\\p' 2>&1`,
    `${kit} status --wait 600 --format markdown | Out-String`, `${kit} pilot prepare --target /x | Out-String`,
    `${kit} build-loop --note "a | b > c"`, `${kit} translate --root $(git rev-parse --show-toplevel | head -1)`,
    `$r='C:\\kit\\scripts\\run_migration.mjs'; & $r pilot run --root X 2>&1`,
    `${kit} translate --root $(git -C (pwd) rev-parse --show-toplevel | head -1)`,
    `$r='C:\\kit\\scripts\\run_migration.mjs'; & $r pilot run --note a\`|b --root X`,
    `$x translate > out.txt; ${kit} status`,
    `$r='C:\\k\\scripts\\run_migration.mjs'; node $r translate --root (Get-Item $root | Select-Object -ExpandProperty FullName) 2>&1`,
    `$r='C:\\k\\scripts\\run_migration.mjs'; node $r translate --root (Split-Path $r | Split-Path) 2>&1`, `node C:\\kit\\scripts\\run_migration.mjs translate --root C:\\p\\\nGet-Date | Out-Null`, `${kit} translate --help | head`, `${kit} translate || echo failed`,
  ]) assert.equal(hiddenLongRun(command), null, command);
});

test('the hook denies a hidden long run with the unified way to run it, in the chosen language', t => {
  const f = prepare(t);
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const decide = command => interactiveDecision({ toolName: 'powershell', toolArgs: { command }, cwd: f.root }, f.root);
  const piped = `$r='C:\\kit\\scripts\\run_migration.mjs'; node $r pilot run --root 'C:\\p' 2>&1 | Out-String`;
  let d = decide(piped);
  assert.equal(d?.decision, 'deny');
  assert.match(d.reason, /pilot run/); assert.match(d.reason, /status --root TARGET --wait 600/); assert.match(d.reason, /background/);
  setPreferences(f.root, { language: 'ja' });
  d = decide(piped);
  assert.equal(d?.decision, 'deny'); assert.match(d.reason, /バックグラウンド/);
  assert.equal(decide(`${kit} translate`), null);
  assert.equal(decide(`${kit} status --root p --wait 600 --format markdown`), null);
  // A piped build-loop is still a gate when unpiped: the deny comes first, the gate stays.
  assert.equal(decide(`${kit} build-loop --note "go" | Out-String`)?.decision, 'deny');
  assert.equal(decide(`${kit} build-loop --note "go"`)?.decision, 'ask');
  assert.equal(humanGate(`${kit} build-loop --note "go" | Out-String`), 'build-loop');
});

test('translate progress events count this run\'s finished units out of its pending units', async t => {
  const f = await ready(t, { count: 3 });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Counting fixture');
  const events = [];
  await translate(f.root, f.config, fake, { onProgress: e => events.push(e) });
  assert.ok(events.length && events.every(e => e.total === 3), JSON.stringify(events.slice(0, 3)));
  assert.deepEqual(events.filter(e => e.stage === 'done').map(e => e.done).sort(), [1, 2, 3]);
  const last = events.at(-1);
  assert.equal(last.done, 3);
  assert.match(progressLine(last), /\[3\/3\] .+: done \(agent calls \d+\)$/);
});

test('a blocked unit shows in the progress lines at once', async t => {
  const f = await ready(t, { count: 1 });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Blocked fixture');
  const events = [];
  await assert.rejects(translate(f.root, f.config, async call => { if (call.role === 'implementer') throw new Error('Worker returned malformed JSON'); return fake(call); },
    { onProgress: e => events.push(e) }));
  assert.equal(events.at(-1).stage, 'blocked');
  assert.equal(events.at(-1).done, 0); assert.equal(events.at(-1).total, 1);
});

test('survey run progress events count finished scopes out of planned scopes', async t => {
  const f = prepare(t);
  f.config.sourceRoots = ['case']; f.config.concurrency = 1;
  atomicWrite(safePath(f.root, 'case/A.cs'), 'class A {}\n');
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const events = [];
  const report = await runSurvey(f.root, f.config, 'contracts', async args => {
    const input = JSON.parse(args.reviewInput);
    return { result: { schemaVersion: 1, kind: 'survey', survey: input.kind, target: args.unit.target,
      items: input.files.map(x => ({ file: x.path, publicInterface: 'i', inputsOutputsErrors: 'unknown', edgeCases: 'unknown', evidence: `${x.path}:1`, unknowns: 'unknown' })) } };
  }, { onProgress: e => events.push(e) });
  assert.equal(report.done, 1);
  assert.ok(events.length && events.every(e => e.total === 1));
  assert.equal(events.at(-1).stage, 'done'); assert.equal(events.at(-1).done, 1);
});

test('every runner command prints progress through the one formatter, and every instruction copy names the same rule', () => {
  const read = p => fs.readFileSync(path.join(kitRoot, p), 'utf8');
  const runner = read('scripts/run_migration.mjs');
  const handlers = runner.match(/onProgress: [^,}]+/g);
  assert.ok(handlers.length >= 5);
  for (const h of handlers) assert.equal(h.trim(), 'onProgress: event => console.error(progressLine(event))');
  for (const p of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = read(p);
    assert.match(text, /Long runner commands \(`translate`, `repair`, `repair-round`, `build-loop`,\s+`pilot run`, `survey run`\) all run the same way/, p);
    assert.match(text, /\| Out-String/, p);
  }
  for (const p of ['.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md'])
    assert.match(read(p), /pilot run, survey run\)[\s\S]{0,120}never piped or redirected|never piped\s+or redirected/, p);
});
