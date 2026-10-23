// SPDX-License-Identifier: Apache-2.0
// Failure reports, questions and progress as the person sees them: every
// guidance rule keeps the "When a step fails" contract, the kit's own hook
// denials and refused confirmations get their own guidance, phase-order errors
// lead with the phase that phase next reports, and TODO items and doctor do not
// report a normal new project as failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, kitRoot } from '../scripts/install.mjs';
import { mini, prepare } from './helpers.mjs';
import { loadConfig, safePath, atomicWrite, writeJSON } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { migrationStatus, statusTodo, statusChecklist } from '../lib/status.mjs';
import { failureGuidance, guidanceRuleIds, doctorGuidance, guidanceMarkdown } from '../lib/guidance.mjs';
import { interactiveDecision, installGuardrails } from '../lib/guardrails.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { runProcess } from '../lib/process.mjs';
import { doctor } from '../scripts/run_migration.mjs';

// One message per rule, in the words its producer uses. A new rule needs a
// sample here, so it is held to the same contract.
const samples = {
  'cannot-ask': 'Permission denied and could not request permission from user: unable to ask user for confirmation',
  'command-line': 'Unknown option --formt. Options for status: --root PATH, --copilot PATH, --format json|markdown|todo|checklist. Add --help for usage.',
  guardrails: 'Phase 03 requires human-installed command guardrails. Ask the human to install them',
  'guardrail-denied': '"git reset --hard" is denied by migration/guardrails.json during the migration.',
  'guardrails-write': "migration/guardrails.json is the human's decision. Do not write it directly",
  'phase-order': 'Phase 01 is not reviewed for current inputs. Use phase next',
  'runtime-judge': 'Prepare runtime judge inputs and original/mutation/parity commands before phase 00b review',
  'source-plan': 'Source-only judge plan requires scenarios',
  'spec-placeholder': 'Source-derived contracts still contain TODO(spec): migration/source-spec/contracts.md',
  'outside-roots': 'Source outside sourceRoots: tools/gen.py',
  artifact: 'Nonempty phase artifact required: migration/feasibility.md',
  'no-dependencies': 'Review dependency map declares no dependencies between 3 manifest files',
  'template-rules': 'migration/RULEBOOK.md is still the installed template',
  'untrusted-folder': 'Repository hooks are not loaded: the Copilot CLI folder is untrusted',
  'models-unset': 'Set an available model ID for models.implementer',
  'cli-options': 'Copilot CLI is missing required options: --session-id',
  'hook-check': 'Hook check failed: node hook.mjs took 9000 ms (timeout 5 s)',
  'profile-modified': "Worker profile is not the kit's: migration-implementer",
  'waiting-dependency': 'Waiting on unfinished dependencies (ported/a.mjs); review blocked upstream receipts',
  'circuit-breaker': 'Stopped dispatching after 3 consecutive unit failures',
  'survey-result': 'Invalid survey result for scope 2',
  'survey-incomplete': 'Survey incomplete: 2 of 5 scopes have no current result',
  'survey-census': 'The inventory survey needs a mechanical site census: --sites migration/PATH.tsv',
  manifest: 'Manifest is empty',
  'review-deps': 'Review dependency map: Required review dependency map missing: migration/review-dependencies.json',
  'copilot-missing': 'spawn copilot ENOENT',
  'copilot-auth': 'Copilot implementer failed (exit 1): To authenticate, you can use any of the following methods',
  agents: 'No such agent: migration-implementer',
  typecheck: 'Unit typecheck failed; inspect receipt',
  'fix-limit': 'Fix-round limit reached; review recurring problems and propose a rule amendment',
  'call-limit': 'Agent call limit reached; resume with a new run after reviewing usage',
  'input-budget': 'Run input budget (maxRunInputBytes) reached; resume',
  'file-limit': 'Too many open files: the hard descriptor limit is 256',
  'rate-limit': 'Copilot implementer failed (exit 1): session.error rate_limit 429',
  credits: 'Copilot implementer failed (exit 1): Your AI Credits budget has been exhausted',
  lock: 'Migration locked by pid 4242',
  'inputs-changed': 'Translation approval is stale: inputs changed',
  approval: 'No build approval for the current outputs',
  'build-failed': 'Build failed (exit 2)',
  timeout: 'Copilot reviewer timed out after 600 s',
  'worker-output': 'Invalid review result for src/login.py',
  'credential-candidate': 'Local scan: the /P argument is still a literal credential candidate',
  'credential-clear': 'Secret scan: 0 matches',
  unknown: 'something nobody anticipated'
};
const recommended = { ja: '（推奨）', en: ' (recommended)' };
function assertContract(g, where, language) {
  assert.ok(g.cause && g.impact, `${where}: cause and impact`);
  assert.ok(g.options.filter(o => o.id !== 'pause').length >= 2, `${where}: at least two choices besides pause`);
  assert.equal(g.options.at(-1).id, 'pause', `${where}: pause last`);
  assert.deepEqual(g.options.map(o => o.recommended), g.options.map((o, i) => i === 0), `${where}: one recommendation, first`);
  assert.equal(g.recommended, g.options[0].id, where);
  assert.ok(g.options.every(o => o.label && o.reason), `${where}: label and reason on every option`);
  assert.deepEqual(g.choices, g.options.map((o, i) => i ? o.label : `${o.label}${recommended[language]}`), `${where}: choices for the question tool`);
  // A command runs as written: outside quotes no pipe, redirection or separator
  // may turn a placeholder such as a|b into other commands (&& chains are explicit).
  for (const o of g.options.filter(x => x.command))
    assert.doesNotMatch(o.command.replace(/"[^"]*"|'[^']*'/g, '').replaceAll('&&', ''), /[|<>;]/, `${where}: ${o.id} command is one command line`);
}
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double' });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  return root;
}

test('every failure rule offers two choices plus pause, the recommendation first, in both languages', () => {
  assert.deepEqual(Object.keys(samples).sort(), [...guidanceRuleIds, 'unknown'].sort(), 'one sample message per rule');
  for (const [id, message] of Object.entries(samples)) for (const language of ['ja', 'en']) {
    const g = failureGuidance(message, { language });
    assert.equal(g.id, id, `${id} (${language}) is matched by another rule`);
    assertContract(g, `${id} (${language})`, language);
  }
  // Phase-specific and preference-specific variants keep the contract too.
  for (const message of ['Phase 00 is not reviewed for current inputs', 'Phase 03 is not reviewed for current inputs', 'Phase 05c is not reviewed for current inputs',
    '"npm test" is denied by migration/guardrails.json during the migration.'])
    assertContract(failureGuidance(message, { language: 'en' }), message, 'en');
});

// A Windows phase 00 run stopped twice: a host's own scan took a /P switch for a
// password, then read the guidance it asked for as a second failure.
test('guidance --message explains a message, and a credential suspicion stops no phase', async t => {
  const id = message => failureGuidance(message, { language: 'en' }).id;
  for (const message of [samples['credential-candidate'], '再開時の検査で /P 引数が資格情報候補と判定されました', 'Possible hardcoded password in deploy.bat',
    'secret scan found 1 match', 'Secret scan found 2 matches', '1 credential candidate found; no other matches', 'credential candidate at src/run.bat line 5',
    'ハードコードされたパスワードを検知しました', '認証情報が見つかりました', 'シークレットが見つかりました'])
    assert.equal(id(message), 'credential-candidate', message);
  // A clean result needs no question, though it names a credential and "detected".
  for (const message of ['No credentials detected', 'No secret candidates found', 'Secret scan: 0 matches', 'Secret scan: none', 'secret scan complete, nothing found',
    '資格情報は検出されませんでした', 'シークレットは見つかりませんでした', '秘密情報の検査: 0件'])
    assert.equal(id(message), 'credential-clear', message);
  for (const message of ['Bad credentials', 'Copilot implementer failed (exit 1): To authenticate, you can use any of the following methods'])
    assert.equal(id(message), 'copilot-auth', message);
  const g = failureGuidance(samples['credential-candidate'], { language: 'en' });
  assert.deepEqual(g.options.map(o => o.id), ['check-line', 'skip-line', 'move-secret', 'pause']);
  assert.ok(!g.options.some(o => o.command), 'no command runs on a suspected credential');
  assert.match(g.cause, /no phase stops on one/);
  assert.equal(failureGuidance('No credentials detected', { language: 'en' }).recommended, 'continue');
  // A finding in any clause wins over a clean clause in the same message, and
  // its value never reaches the output.
  for (const message of ['Secret scan: 0 matches\nPotential hardcoded password at src/config.bat:17',
    'No credentials detected, but possible hardcoded password: sqlcmd -P ExampleSecret123',
    '資格情報は検出されませんでした。しかし、ハードコードされたパスワードを検知しました: schtasks /U admin /P ExampleSecret123',
    // In one clause, however they are joined.
    'No credentials detected but possible hardcoded password value ExampleSecret123', 'Secret scan: 0 matches but potential leaked token value ExampleSecret123',
    '資格情報は検出されませんでしたがハードコードされたパスワードを検知しました ExampleSecret123',
    // Names a credential but is neither clean nor a known finding: unsure is never clean.
    'credential check returned ExampleSecret123']) {
    const result = failureGuidance(message, { language: 'en', explain: true });
    assert.equal(result.id, 'credential-candidate', message);
    assert.doesNotMatch(JSON.stringify(result) + guidanceMarkdown(result, 'en'), /ExampleSecret123/, message);
  }
  // Outside the credential rules, a value after a password switch is masked; -p is not one.
  assert.equal(failureGuidance('sqlcmd -S db -U sa -P ExampleSecret123 failed', { explain: true }).message, 'sqlcmd -S db -U sa -P *** failed');
  assert.equal(failureGuidance('mkdir -p migration/x failed', { explain: true }).message, 'mkdir -p migration/x failed');
  for (const message of ['token expired for user', 'Found 2 matches in src']) assert.equal(id(message), 'unknown', message);
  // A clean result only informs: no question, in either language.
  for (const language of ['en', 'ja']) {
    const clear = failureGuidance('No credentials detected', { language, explain: true });
    assert.equal(clear.actionRequired, false);
    assert.doesNotMatch(guidanceMarkdown(clear, language), /Choose how to proceed|どれで進めるか/);
  }
  assert.equal(g.actionRequired, true);
  const root = project(t), script = safePath(root, 'migration-kit/scripts/run_migration.mjs');
  for (const [message, cause] of [[samples['credential-candidate'], /suspected a literal credential/], ['something nobody anticipated', /kit has no entry for this message/]]) {
    const out = await runProcess(process.execPath, [script, 'guidance', '--message', message], { cwd: root });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^## What to do about this message\n- Note: the guidance command succeeded\./);
    assert.doesNotMatch(out.stdout, /did not succeed|did not complete/);
    assert.match(out.stdout, cause);
    assert.match(out.stdout, /- Message: `/);
  }
  // A candidate's text may carry the value: neither output repeats it, and any
  // other message has an assigned value masked.
  const secret = 'ExampleSecret123';
  for (const [message, format] of [[`Possible hardcoded password: sqlcmd -P ${secret}`, 'markdown'], [`Possible hardcoded password: sqlcmd -P ${secret}`, 'json'],
    [`ハードコードされたパスワードを検知しました: schtasks /U admin /P ${secret}`, 'json'], [`deploy failed: password=${secret}`, 'markdown'], [`deploy failed: token: "${secret}"`, 'json']]) {
    const out = await runProcess(process.execPath, [script, 'guidance', '--message', message, '--format', format], { cwd: root });
    assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(secret), `${format}: ${message}`);
  }
  setPreferences(root, { language: 'ja' });
  const ja = await runProcess(process.execPath, [script, 'guidance', '--message', 'something nobody anticipated', '--format', 'json'], { cwd: root });
  assert.equal(JSON.parse(ja.stdout).explained, true);
  // A runner error keeps its failure heading.
  assert.match((await runProcess(process.execPath, [script, 'phase', 'start', '04'], { cwd: root })).stderr, /## うまくいきませんでした/);
});

test('a survey command names the kind the error reports, or none when it is unknown', () => {
  const named = failureGuidance('Survey incomplete: 2 of 5 scopes have no current result (s1, s2); resume survey run --kind inventory', { language: 'en' });
  assert.match(named.options.find(o => o.id === 'survey-status').command, /survey status --kind inventory$/);
  const unnamed = failureGuidance(samples['survey-incomplete'], { language: 'en' });
  assert.equal(unnamed.options.find(o => o.id === 'survey-status').command, undefined);
});

test('a refused confirmation or an automatic reply is never taken as the answer', () => {
  for (const message of [samples['cannot-ask'],
    'The user is not available to respond and will review your work later. Work autonomously and make good decisions.']) {
    const g = failureGuidance(message, { language: 'en' });
    assert.equal(g.id, 'cannot-ask', message);
    assert.equal(g.recommended, 'interactive');
    assert.ok(!g.options.some(o => o.command), 'no command runs on an automatic reply');
  }
  // The refusal wins even when it carries a gate command that other rules match.
  assert.equal(failureGuidance('node migration-kit/scripts/run_migration.mjs approve translation --note x: unable to ask user for confirmation').id, 'cannot-ask');
  // A worker CLI that stopped on its own permission prompt is a worker failure, not the parent's.
  assert.equal(failureGuidance('Copilot implementer failed (exit 1): Permission denied: unable to ask user for confirmation').id, 'worker-output');
});

test("the kit's own hook denials are explained as the design working, in the person's language", t => {
  const f = prepare(t);
  installGuardrails(f.root, kitRoot, {});
  for (const language of ['en', 'ja']) {
    setPreferences(f.root, { language });
    // Version control that rewrites history: keep it; builds and tests: the runner runs them.
    const denied = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'git reset --hard' }, cwd: f.root }, f.root);
    assert.equal(denied?.decision, 'deny');
    const g = failureGuidance(denied.reason, { root: f.root, language });
    assert.equal(g.id, 'guardrail-denied', denied.reason);
    assert.equal(g.recommended, 'keep-history');
    assert.equal(g.options[0].command, 'git status --short');
    assert.ok(!g.options.some(o => o.id === 'use-runner'), 'a git denial is not a build to run');
    assert.match(g.options.find(o => o.id === 'revise-guardrails').command, /guardrails show$/, 'the list is shown before any change');
    const build = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'npm test' }, cwd: f.root }, f.root);
    assert.equal(failureGuidance(build.reason, { root: f.root, language }).recommended, 'use-runner', build.reason);
    const write = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'cp migration-kit/templates/guardrails.json migration/guardrails.json' }, cwd: f.root }, f.root);
    assert.equal(failureGuidance(write.reason, { root: f.root, language }).id, 'guardrails-write', write.reason);
  }
});

test('phase-order guidance leads with the first incomplete phase that phase next reports', async t => {
  const root = project(t);
  phaseCommand(root, loadConfig(root), 'init');
  // Starting 04 on a new project names only 03; recording 03 would fail the same way.
  const script = safePath(root, 'migration-kit/scripts/run_migration.mjs');
  const skipped = await runProcess(process.execPath, [script, 'phase', 'start', '04'], { cwd: root });
  assert.equal(skipped.code, 1);
  assert.match(skipped.stderr, /^ERROR: Phase 03 is not reviewed/);
  assert.match(skipped.stderr, /1\. \*\*Go back to the first incomplete phase, 00, and continue in order\*\* \(recommended\)[\s\S]*phase next`/);
  const first = failureGuidance('Phase 03 is not reviewed for current inputs.', { root, language: 'en' });
  assert.deepEqual(first.options.map(o => o.id), ['go-first', 'review-previous', 'pause']);
  assert.match(first.options[1].command, /phase complete 00 --note "<確認した内容 \/ what you reviewed>"$/);
  assert.match(first.cause, /Phase 00, before 03, is not complete/);
  // After 00 the guidance moves on with phase next.
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Three Python files; structural port.\n');
  phaseCommand(root, loadConfig(root), 'complete', '00', { note: 'User reviewed feasibility' });
  assert.equal(migrationStatus(root).workflow.next, '00b');
  const second = failureGuidance('Phase 03 is not reviewed for current inputs.', { root, language: 'en' });
  assert.match(second.options[0].label, /phase, 00b,/);
  assert.match(second.options[1].command, /phase complete 00b --note/);
  // When the named phase is the first incomplete one, the guidance acts on it.
  const named = failureGuidance('Phase 00b is not reviewed for current inputs.', { root, language: 'en' });
  assert.deepEqual(named.options.map(o => o.id), ['review-previous', 'redo-phase', 'pause']);
  assert.match(named.options[0].command, /phase complete 00b --note/);
});

test('TODO descriptions follow the report language while JSON keeps the recorded status', t => {
  const root = project(t);
  phaseCommand(root, loadConfig(root), 'init');
  const report = migrationStatus(root);
  assert.equal(report.phases.find(p => p.id === '00').status, 'pending review');
  assert.equal(statusTodo(report, 'ja').todoList[0].description, '確認・記録待ち');
  assert.equal(statusTodo(report, 'ja').todoList[5].description, '未完了');
  assert.equal(statusTodo(report, 'en').todoList[0].description, 'pending review');
  // Waiting for the person's review is not work in progress: not-started, state
  // in the title, and still the current phase in TODO and chat.
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Three Python files; structural port.\n');
  const waiting = migrationStatus(root), todo = statusTodo(waiting, 'ja');
  assert.equal(waiting.currentState, 'awaiting-review');
  assert.deepEqual([todo.todoList[0].status, todo.todoList[0].title], ['not-started', '00 事前調査【確認待ち】']);
  assert.equal(todo.current.state, 'awaiting-review');
  assert.match(statusChecklist(waiting, 'ja'), /▶ 00 事前調査【確認待ち】　← いまここ/);
});

test('doctor shows the review dependency map as pending until phase 01 is recorded', async t => {
  const root = project(t);
  const mapCheck = async () => (await doctor(root, loadConfig(root))).checks.find(c => c.check === 'review dependency map');
  const pending = await mapCheck();
  assert.equal(pending.ok, true);
  assert.equal(pending.status, 'pending');
  // Once phase 01 is recorded a missing declaration fails again, and the
  // guidance points at phase 01 until a dependency map exists to generate from.
  atomicWrite(safePath(root, 'migration/phases/01.json'), '{}\n');
  const report = await doctor(root, loadConfig(root));
  assert.equal(report.checks.find(c => c.check === 'review dependency map').ok, false);
  const [missing] = doctorGuidance(report, { root, language: 'en' }).filter(g => g.targets.includes('review dependency map'));
  assert.equal(missing.guidance.recommended, 'phase-01');
  assert.ok(!missing.guidance.options.some(o => o.id === 'make-review-deps'));
  atomicWrite(safePath(root, 'migration/depmap/edges.tsv'), 'from\tto\n');
  assert.equal(failureGuidance(missing.guidance.message, { root, language: 'en' }).recommended, 'make-review-deps');
  // Legacy projects without phase records keep failing as before.
  fs.rmSync(safePath(root, 'migration/phases/01.json'));
  writeJSON(safePath(root, 'migration/config.json'), { ...loadConfig(root), phasePolicy: 'legacy' });
  assert.equal((await mapCheck()).ok, false);
});
