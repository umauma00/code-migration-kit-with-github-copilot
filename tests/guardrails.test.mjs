import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare } from './helpers.mjs';
import { safePath, writeJSON } from '../lib/core.mjs';
import { deniedRule, guardrailDecision, parseGuardrails, cliFolderTrust, interactiveDecision } from '../lib/guardrails.mjs';
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

test('guardrails see the Windows forms of a denied command (PowerShell, cmd.exe, extensions, py launcher)', () => {
  for (const command of ['GIT push', 'Git.exe push', 'NPM test', 'POWERSHELL -c "git push"', 'npm.cmd test', '& "C:\\Program Files\\nodejs\\npm.cmd" test', 'npx.cmd tsc --noEmit', 'git.exe push',
    'cmd /c "git push"', 'cmd /c git push', 'cmd.exe /d /s /c "npm test"', 'Start-Process git -ArgumentList push',
    'Start-Process -FilePath git.exe -ArgumentList "push","origin"', '.\\gradlew.bat build', 'py -3 -m pytest', 'py -3.12 -m pytest -q',
    // Switches take no value, wherever they stand; values may be attached or abbreviated.
    'Start-Process -Wait git -ArgumentList push', 'Start-Process -NoNewWindow git -ArgumentList push', 'Start-Process git -Wait -ArgumentList push',
    'Start-Process -Wait -NoNewWindow -PassThru -FilePath git -ArgumentList push', 'Start-Process -Wait:$true git push',
    'Start-Process -FilePath:git -ArgumentList:push', 'saps -File git -Arg push', 'Start-Process -WindowStyle Hidden -WorkingDirectory C:\\w git push'])
    assert.ok(deniedRule(command, rules), command);
  for (const command of ['git.exe status', 'npm.cmd run lint', 'cmd /c dir', 'py script.py', 'start notepad', 'Start-Process git -ArgumentList status', 'Start-Process -Wait git -ArgumentList status'])
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

test('guardrails replay keystrokes typed into a running shell (write_bash, and write_powershell on Windows)', t => {
  const f = prepare(t);
  writeJSON(safePath(f.root, 'migration/guardrails.json'), template);
  const typed = (toolName, input) => guardrailDecision({ toolName, toolArgs: { shellId: '1', input }, cwd: f.root });
  for (const tool of ['write_bash', 'write_powershell']) {
    assert.match(typed(tool, 'git push{enter}'), /"git push" is denied/, tool);
    assert.match(typed(tool, 'echo ok{enter}npm test{enter}'), /"npm test" is denied/, tool);
    assert.match(typed(tool, 'git pux{backspace}sh{enter}'), /"git push" is denied/, tool);
    assert.match(typed(tool, 'git ush{left}{left}{left}p{enter}'), /"git push" is denied/, tool);
    // A raw newline runs the line too; later edits cannot take it back.
    assert.match(typed(tool, `git push\n${'{backspace}'.repeat(9)}git status{enter}`), /"git push" is denied/, tool);
    assert.match(typed(tool, 'git push\r\n'), /"git push" is denied/, tool);
    assert.equal(typed(tool, 'git status{enter}'), null, tool);
    // What the shell runs is unknown: history, menus, Tab completion, line-editing controls,
    // edits into earlier text, and text left for a later {enter}.
    for (const input of [`git status{enter}{up}${'{backspace}'.repeat(6)}push{enter}`, '{down}{down}{enter}', 'git pu\t{enter}', 'git\tstatus\n', '\x15git status{enter}',
      '\x1b[A{enter}', '{backspace}h{enter}', '{left}x{enter}', 'git pu'])
      assert.match(typed(tool, input), /cannot be checked/, `${tool} ${JSON.stringify(input)}`);
  }
  // Without installed guardrails, keystrokes are not checked.
  fs.rmSync(safePath(f.root, 'migration/guardrails.json'));
  assert.equal(typed('write_powershell', '{up}{enter}'), null);
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
  // Approval confirmations depend on the hook too, so untrusted fails even before guardrails exist.
  assert.deepEqual([(await check()).status, (await check()).ok], ['untrusted', false]);
  writeJSON(safePath(f.root, 'migration/guardrails.json'), template);
  assert.equal((await check()).ok, false);
  trust([path.dirname(f.root)]);
  assert.deepEqual([(await check()).status, (await check()).ok], ['trusted', true]);
  assert.equal((await doctor(f.root, f.config)).checks.find(c => c.check === 'command guardrails').status, 'installed');
});

// Phase 01 on Windows: generating the review dependency map was refused as a
// guardrails.json write because a read on the same line (Test-Path, a listing
// of migration/*, Format-Table *) named the file or a pattern matching it.
test('PowerShell reads beside a kit command are not guardrails writes; the refusal names the matched word', () => {
  const f = prepare();
  const decide = command => interactiveDecision({ toolName: 'run_in_terminal', toolArgs: { command }, cwd: f.root }, f.root);
  const kit = 'C:\\Users\\me\\AppData\\Roaming\\Code\\agentPlugins\\code-migration-kit\\scripts';
  const make = `node "${kit}\\make_review_dependencies.mjs" --source-root src --edges migration/depmap/edges.tsv`;
  for (const command of [make, `${make}; Test-Path migration/guardrails.json`, `${make}; Get-Item migration/* | Select-Object Name`,
    `Set-Location ${f.root}; ${make}; Get-ChildItem | Format-Table *`, `${make}; Get-ChildItem migration -Filter *.json | Select-Object Name, Length`,
    `${make}; Select-String -Path migration/* -Pattern edges`, `${make}; findstr /S /N edges migration\\*`,
    // PowerShell names are case-insensitive; a pipe into a writer with its own named target is checked on that target.
    'Get-Content migration/guardrails.json', 'get-content migration/guardrails.json', 'GET-CONTENT migration/guardrails.json', 'GC migration/guardrails.json',
    'Get-ChildItem migration/* | Out-File migration/file-list.txt',
    // A pipe joins only the commands it connects: a listing of migration/ before ;, &&, || or a newline is not piped (review round 8).
    'Get-ChildItem migration; Get-ChildItem temp | Remove-Item', 'Get-ChildItem migration && Get-ChildItem temp | Remove-Item',
    'gci migration || gci temp | ri', 'Get-ChildItem migration\nGet-ChildItem temp | Remove-Item',
    'Get-Content migration/guardrails.json; Get-ChildItem temp | ForEach-Object { $_.Name }'])
    assert.equal(decide(command), null, command);
  for (const command of ['Set-Content migration/guardrails.json "{}"', 'echo {} > migration/guardrails.json', 'Copy-Item x.json migration/guardrails.json',
    'Remove-Item -Recurse migration', 'Get-ChildItem migration/* | Remove-Item', 'Get-ChildItem migration/* | ForEach-Object { $_.Delete() }',
    'Test-Path migration/guardrails.json > migration/guardrails.json', 'sort -o migration/guardrails.json a.txt', 'cp a.json migration/*',
    // A script block or a pipe into a command that takes its path from the pipeline can change what the reader lists.
    'Get-ChildItem migration/* | Where-Object { Remove-Item -LiteralPath $_.FullName; $true }', 'Get-ChildItem migration/* | Set-Content -Value x',
    'Get-ChildItem migration/* | iex', 'Get-ChildItem migration/* | Out-File migration/guardrails.json',
    // PowerShell names in any letter case, and its aliases.
    'remove-item -Recurse migration', 'REMOVE-ITEM -Recurse migration', 'Move-Item migration backup', 'move-item migration backup', 'mi migration backup',
    'Rename-Item migration old', 'set-location migration; remove-item guardrails.json', 'SET-LOCATION migration; REMOVE-ITEM guardrails.json',
    // A method call on what a reader returns, a listing of migration/ piped into a command that changes it, and -Param:value.
    '(Get-Item migration/guardrails.json).Delete()', '(gi migration/guardrails.json).MoveTo(\'x\')', '(Get-ChildItem migration/*).Delete()',
    'Write-Output (Get-Item migration/guardrails.json).Delete()', '[IO.File]::Delete(\'migration/guardrails.json\')',
    'Get-ChildItem migration | Remove-Item', 'Get-ChildItem migration | del', 'Get-ChildItem -Path migration -Recurse | Remove-Item',
    'gci migration | Where-Object Name -eq guardrails.json | Remove-Item', 'Get-ChildItem . -Recurse -Filter guardrails.json | ri', 'ls migration | xargs rm',
    'Get-ChildItem temp; Get-ChildItem migration | Remove-Item', '(Get-ChildItem migration; Get-ChildItem temp) | Remove-Item',
    'Set-Content -Path:migration/guardrails.json x', 'x | Out-File -FilePath:migration/guardrails.json', 'Remove-Item -Path:migration/guardrails.json']) {
    const d = decide(command);
    assert.equal(d?.decision, 'deny', command);
    assert.match(d.reason, /Matched: `[^`]+`/, command);
  }
  assert.match(decide('cp a.json migration/*').reason, /Matched: `migration\/\*`/);
});
