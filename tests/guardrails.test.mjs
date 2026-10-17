import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare } from './helpers.mjs';
import { safePath, writeJSON } from '../lib/core.mjs';
import { deniedRule, guardrailDecision, parseGuardrails, cliFolderTrust } from '../lib/guardrails.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { kitRoot } from '../scripts/install.mjs';

const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/guardrails.json'), 'utf8'));
const rules = parseGuardrails(template).denyCommands;

test('guardrail matching follows upstream deny prefixes across pipelines, wrappers and paths', () => {
  for (const command of ['git reset --hard', 'echo ok && git push origin main', 'FOO=1 sudo /usr/bin/make all',
    'cd ported; cargo check', 'python3 -m pytest -q', 'ls | xargs; npx tsc --noEmit', '(git clean -fdx)', 'out=$(mvn -q test)'])
    assert.ok(deniedRule(command, rules), command);
  for (const command of ['git status', 'git diff HEAD', 'git log -1', 'gitea reset', 'python3 -m http.server',
    'node migration-kit/scripts/run_migration.mjs build', 'grep -rn make src', 'npm run lint'])
    assert.equal(deniedRule(command, rules), null, command);
});

test('guardrails apply to interactive sessions only when the human installed them', t => {
  const f = prepare(t), event = { toolName: 'bash', toolArgs: JSON.stringify({ command: 'git reset --hard' }), cwd: f.root };
  assert.equal(guardrailDecision(event), null);
  writeJSON(safePath(f.root, 'migration/guardrails.json'), template);
  assert.match(guardrailDecision(event), /"git reset" is denied/);
  assert.match(guardrailDecision({ ...event, cwd: safePath(f.root, 'src') }), /denied/);
  assert.equal(guardrailDecision({ toolName: 'view', toolArgs: { path: 'src' }, cwd: f.root }), null);
  assert.equal(guardrailDecision({ ...event, toolArgs: { command: 'git status' } }), null);
  fs.writeFileSync(safePath(f.root, 'migration/guardrails.json'), '{broken');
  assert.match(guardrailDecision(event), /invalid/);
});

test('the installed hook denies guarded commands in Copilot CLI and VS Code Local payloads', t => {
  const f = prepare(t), hook = safePath(f.root, 'migration-kit/scripts/migration_hook.mjs');
  writeJSON(safePath(f.root, 'migration/guardrails.json'), template);
  const run = (event, args = [], env = {}) => {
    const r = spawnSync(process.execPath, [hook, ...args], { cwd: f.root, input: JSON.stringify(event), encoding: 'utf8',
      env: { ...process.env, MIGRATION_KIT_ROLE: '', ...env } });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  assert.equal(run({ toolName: 'bash', toolArgs: JSON.stringify({ command: 'cargo build' }), cwd: f.root }).permissionDecision, 'deny');
  const local = run({ tool_name: 'run_in_terminal', tool_input: { command: 'make -j8' } }, ['--vscode']);
  assert.equal(local.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(run({ toolName: 'bash', toolArgs: JSON.stringify({ command: 'git status' }), cwd: f.root }), {});
  // Workers keep their stricter role contract.
  assert.match(run({ toolName: 'bash', toolArgs: '{}' }, [], { MIGRATION_KIT_ROLE: 'implementer' }).permissionDecisionReason, /read-only/);
});

test('doctor fails when installed guardrails would be silently ignored in an untrusted CLI folder', async t => {
  const f = prepare(t), home = safePath(f.root, 'cli-home'), saved = process.env.COPILOT_HOME;
  fs.mkdirSync(home);
  const trust = folders => fs.writeFileSync(path.join(home, 'config.json'), '// User settings belong in settings.json.\n' + JSON.stringify({ trustedFolders: folders }));
  process.env.COPILOT_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = saved; });
  const check = async () => (await doctor(f.root, f.config)).checks.find(c => c.check === 'repository hooks load in Copilot CLI');
  assert.equal(cliFolderTrust(f.root), 'unknown');
  trust(['/elsewhere']);
  assert.deepEqual([(await check()).status, (await check()).ok], ['untrusted', true]);
  writeJSON(safePath(f.root, 'migration/guardrails.json'), template);
  assert.equal((await check()).ok, false);
  trust([path.dirname(f.root)]);
  assert.deepEqual([(await check()).status, (await check()).ok], ['trusted', true]);
  assert.equal((await doctor(f.root, f.config)).checks.find(c => c.check === 'command guardrails').status, 'installed');
});
