// SPDX-License-Identifier: Apache-2.0
// The kit is driven from AI chat only: every human act is a chat answer or a
// host confirmation of an exact command the agent runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, readJSON } from '../lib/core.mjs';
import { humanGate, interactiveDecision, installGuardrails, guardrailsProposal, requireGuardrails } from '../lib/guardrails.mjs';
import { runProcess } from '../lib/process.mjs';

const runner = (f, args) => runProcess(process.execPath, [safePath(f.root, 'migration-kit/scripts/run_migration.mjs'), ...args], { cwd: f.root });

test('guardrails install is a host-confirmed human gate; direct writes stay denied', t => {
  const f = prepare(t);
  const install = 'node migration-kit/scripts/run_migration.mjs guardrails install --add "npm run build,pnpm test" --remove "cargo run"';
  assert.equal(humanGate(install), 'guardrails install');
  assert.equal(humanGate('node migration-kit/scripts/run_migration.mjs guardrails show'), null);
  const decision = interactiveDecision({ toolName: 'bash', toolArgs: { command: install }, cwd: f.root }, f.root);
  assert.equal(decision.decision, 'ask');
  assert.match(decision.reason, /deny list \(or waiver\) you agreed in chat/);
  const direct = interactiveDecision({ toolName: 'bash', toolArgs: { command: 'cp migration-kit/templates/guardrails.json migration/guardrails.json' }, cwd: f.root }, f.root);
  assert.equal(direct.decision, 'deny');
});

test('guardrails install writes the agreed list once and records waivers', t => {
  const f = prepare(t);
  assert.throws(() => requireGuardrails(f.root, '03'), /guardrails install/);
  const proposal = guardrailsProposal(f.root, kitRoot, f.config);
  assert.equal(proposal.installed, null); assert.ok(proposal.template.includes('git reset'));
  const result = installGuardrails(f.root, kitRoot, { add: 'npm run build, pnpm test', remove: 'cargo run' });
  const written = readJSON(safePath(f.root, 'migration/guardrails.json'));
  assert.deepEqual(written, result.written);
  assert.ok(written.denyCommands.includes('npm run build') && written.denyCommands.includes('pnpm test') && !written.denyCommands.includes('cargo run'));
  assert.equal(requireGuardrails(f.root, '03').denyCommands.length, written.denyCommands.length);
  assert.throws(() => installGuardrails(f.root, kitRoot, { add: 'x' }), /already exists; pass --replace/);
  assert.throws(() => installGuardrails(f.root, kitRoot, { replace: true, remove: 'not-there' }), /not in the deny list/);
  assert.throws(() => installGuardrails(f.root, kitRoot, { replace: true, waiver: 'x', add: 'y' }), /not both/);
  installGuardrails(f.root, kitRoot, { replace: true, waiver: 'Disposable sandbox; builds are cheap' });
  assert.equal(readJSON(safePath(f.root, 'migration/guardrails.json')).waiver.note, 'Disposable sandbox; builds are cheap');
});

test('the installed runner exposes guardrails show/install', async t => {
  const f = prepare(t);
  const shown = await runner(f, ['guardrails', 'show']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).file, 'migration/guardrails.json');
  const installed = await runner(f, ['guardrails', 'install', '--add', 'pytest -q']);
  assert.equal(installed.code, 0, installed.stderr);
  assert.ok(readJSON(safePath(f.root, 'migration/guardrails.json')).denyCommands.includes('pytest -q'));
  const again = await runner(f, ['guardrails', 'install']);
  assert.notEqual(again.code, 0);
});

test('chat-only entry points never ask the person to run commands themselves', () => {
  for (const file of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8');
    assert.match(text, /npm install -g @github\/copilot/);
    assert.match(text, /copilot login/);
    assert.match(text, /guardrails install/);
    assert.doesNotMatch(text, /native/i, `${file} still describes the removed native backend`);
  }
});
