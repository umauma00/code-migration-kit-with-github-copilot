// SPDX-License-Identifier: Apache-2.0
// 2026-11-07 (Windows, GitHub Copilot app): the agent put
// `$env:PATH = 'C:\Users\...\AppData\Roaming\npm;' + $env:PATH;` in front of
// `settings apply`, and the hook asked the person ("Hook approval") although
// the command alone records without asking. A gate that runs unasked alone is
// now sent back to the agent to run alone (deny with the way to do it), so no
// prompt is shown and autopilot does not stop on an ask it cannot show. Every
// other gate keeps its ask, and nothing chained ever runs unasked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare } from './helpers.mjs';
import { safePath, writeJSON } from '../lib/core.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { interactiveDecision } from '../lib/guardrails.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { settingsFile } from '../lib/settings.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { decisionOutput } from '../scripts/migration_hook.mjs';

function fixture(t, { mode, language } = {}) {
  const f = prepare(t);
  Object.assign(f.config, { phasePolicy: 'strict' });
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  fs.copyFileSync(path.join(kitRoot, 'templates/guardrails.json'), safePath(f.root, 'migration/guardrails.json'));
  phaseCommand(f.root, f.config, 'init');
  if (mode) setPreferences(f.root, { phaseMode: mode });
  if (language) setPreferences(f.root, { language });
  return f;
}
// The screenshot's form: PowerShell, a Windows runner path, PATH set first.
const runner = 'node "C:\\Users\\u\\.copilot\\installed-plugins\\kit\\scripts\\run_migration.mjs"';
const pathFirst = "$env:PATH = 'C:\\Users\\u\\AppData\\Roaming\\npm;' + $env:PATH; ";
const decide = (f, command, toolName = 'powershell') => interactiveDecision({ toolName, toolArgs: { command, description: 'Apply verified Maven build settings' }, cwd: f.root }, f.root);
const sentBack = /run the kit command again alone, with nothing before or after it/;

test('settings apply and models set behind $env:PATH or cd are sent back to run alone in every mode, and pass alone', t => {
  for (const mode of [undefined, 'relaxed', 'auto']) {
    const f = fixture(t, { mode });
    for (const [chained, alone] of [
      [`${pathFirst}${runner} settings apply`, `${runner} settings apply`],
      [`cd ${f.root}; ${runner} settings apply`, `${runner} settings apply --root ${f.root}`],
      [`${runner} settings apply && ${runner} status`, `${runner} settings apply`],
      [`${pathFirst}${runner} models set --role all --model gpt-5`, `${runner} models set --role all --model gpt-5`],
      [`${runner} settings apply \`\n  2>&1`, `${runner} settings apply 2>&1`]]) {
      const d = decide(f, chained);
      assert.equal(d?.decision, 'deny', `${mode}: ${chained}`);
      assert.match(d.reason, sentBack, `${mode}: ${chained}`);
      assert.match(d.reason, /records without asking in every mode/);
      assert.match(d.reason, /if a setting such as PATH is still needed, run that setting alone first, as a separate call/);
      // What the reason asks for passes without a prompt.
      assert.equal(decide(f, alone), null, `${mode}: ${alone}`);
    }
    // bash spelling of the same.
    assert.equal(decide(f, 'PATH="$HOME/.npm-global/bin:$PATH" node migration-kit/scripts/run_migration.mjs settings apply', 'bash')?.decision, 'deny', `${mode}: PATH=... prefix`);
    assert.equal(decide(f, 'export PATH=/opt/npm/bin:$PATH && node migration-kit/scripts/run_migration.mjs settings apply', 'bash')?.decision, 'deny', `${mode}: export`);
  }
});

test('a settings command that would still ask alone keeps its ask when chained', t => {
  for (const mode of [undefined, 'auto']) {
    const f = fixture(t, { mode });
    const other = fixture(t);
    for (const command of [`${pathFirst}${runner} settings apply --copilot ./fake`, `${pathFirst}${runner} models set --role all --model gpt-5 --copilot=./fake`,
      `${pathFirst}${runner} settings apply --root ${other.root}`, `${pathFirst}${runner} settings apply --root . --root ${other.root}`])
      assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
    // The switch to auto mode through the file always asks the person, chained or not.
    if (mode !== 'auto') {
      writeJSON(safePath(f.root, settingsFile), { schemaVersion: 1, phaseMode: 'auto' });
      for (const command of [`${runner} settings apply`, `${pathFirst}${runner} settings apply`]) {
        const d = decide(f, command);
        assert.equal(d?.decision, 'ask', `${mode}: ${command}`);
        assert.match(d.reason, /switches to auto mode/);
      }
    }
  }
});

test('approvals and completions: sent back in auto mode, asked in normal and relaxed mode, chained or not', t => {
  const gates = [`approve translation --note 'Reviewed'`, `phase complete 02 --note 'Reviewed'`, `phase waive 03 --note 'shape first'`, `build-loop --note 'go'`,
    `pilot prepare --note 'x'`, `source-spec init --apply`, `approve translation --complete-phase 03 --note 'Reviewed'`];
  for (const mode of [undefined, 'relaxed', 'auto']) {
    const f = fixture(t, { mode });
    for (const gate of gates) {
      const alone = decide(f, `${runner} ${gate}`), chained = decide(f, `${pathFirst}${runner} ${gate}`);
      if (mode === 'auto') {
        assert.equal(alone, null, `${mode}: ${gate}`);
        assert.equal(chained?.decision, 'deny', `${mode}: ${gate}`);
        assert.match(chained.reason, /records without asking in auto mode/);
        assert.match(chained.reason, sentBack);
      } else {
        assert.equal(alone?.decision, 'ask', `${mode}: ${gate}`);
        assert.equal(chained?.decision, 'ask', `${mode}: ${gate}`);
      }
    }
    // A note in double quotes with $ expands: sent back (auto) to quote it with '...'.
    const dollar = decide(f, `${runner} approve translation --note "costs $5"`);
    assert.equal(dollar?.decision, mode === 'auto' ? 'deny' : 'ask', `${mode}: note with $`);
    if (mode === 'auto') {
      assert.match(dollar.reason, /Quote --note with '\.\.\.'/);
      assert.equal(decide(f, `${runner} approve translation --note 'costs $5'`), null);
    }
  }
});

test('gates that ask in every mode keep asking chained, and nothing chained runs unasked', t => {
  for (const mode of [undefined, 'auto']) {
    const f = fixture(t, { mode });
    for (const command of [`${pathFirst}${runner} sessions prune`, `${runner} sessions prune; ${runner} settings apply`,
      `${pathFirst}${runner} preferences --phase-mode auto`, `${pathFirst}${runner} guardrails install --deny 'git push'`,
      `bash -c "${runner.replaceAll('"', '')} approve build --note x; ${runner.replaceAll('"', '')} settings apply"`])
      assert.equal(decide(f, command)?.decision, 'ask', `${mode}: ${command}`);
    // Whatever the first gate, a chained command never passes without a decision.
    for (const first of ['settings apply', 'models set --role all --model m', "approve build --note 'x'", "phase complete 02 --note 'x'"])
      for (const then of ['sessions prune', 'preferences --phase-mode auto', "approve translation --note 'x'", 'status'])
        assert.notEqual(decide(f, `${runner} ${first}; ${runner} ${then}`), null, `${mode}: ${first}; ${then}`);
  }
});

test('the reason follows the report language, and the hook answers deny in both the CLI and the VS Code shape', t => {
  const f = fixture(t, { language: 'ja' });
  const d = decide(f, `${pathFirst}${runner} settings apply`);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /「settings apply」はこの案件に対して単独で実行すれば、どのモードでも確認なしで記録されます。/);
  assert.match(d.reason, /利用者には聞かず、キットのコマンドだけを前後に何も付けずに実行し直してください/);
  assert.match(d.reason, /PATH などの設定がどうしても要るときは、その設定だけを先に別の実行で行ってください/);
  const out = decisionOutput(d.reason);
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  // The hook script itself, as the host runs it (stdin JSON, stdout JSON).
  const event = { toolName: 'powershell', toolArgs: JSON.stringify({ command: `${pathFirst}${runner} settings apply` }), cwd: f.root };
  const run = spawnSync(process.execPath, [path.join(kitRoot, 'scripts/migration_hook.mjs')], { input: JSON.stringify(event), encoding: 'utf8', cwd: f.root });
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout);
  assert.equal(answer.permissionDecision, 'deny');
  assert.match(answer.permissionDecisionReason, /前後に何も付けずに実行し直してください/);
  const plain = JSON.parse(spawnSync(process.execPath, [path.join(kitRoot, 'scripts/migration_hook.mjs')],
    { input: JSON.stringify({ ...event, toolArgs: JSON.stringify({ command: `${runner} settings apply` }) }), encoding: 'utf8', cwd: f.root }).stdout);
  assert.deepEqual(plain, {}, 'alone: no decision, so no prompt');
});
