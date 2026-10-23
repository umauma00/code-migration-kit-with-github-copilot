// SPDX-License-Identifier: Apache-2.0
// Steps 00-02 as a new project meets them: doctor runs before the person has
// chosen the worker models, model IDs are offered as choices in a Japanese
// question, a Windows drive-letter case does not make a trusted folder look
// untrusted, and phase check reports what phase complete would refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare } from './helpers.mjs';
import { loadConfig, safePath, writeJSON, readJSON } from '../lib/core.mjs';
import { interactiveDecision, cliFolderTrust } from '../lib/guardrails.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { doctorGuidance } from '../lib/guidance.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { doctor } from '../scripts/run_migration.mjs';

test('doctor reports unchosen worker models as a check and still runs the rest', async t => {
  const f = prepare(t);
  const config = readJSON(safePath(f.root, 'migration/config.json'));
  config.models.implementer = 'SELECT_MODEL';
  writeJSON(safePath(f.root, 'migration/config.json'), config);
  assert.throws(() => loadConfig(f.root), /Set an available model ID for models\.implementer/);
  const loaded = loadConfig(f.root, { requireModels: false });
  const report = await doctor(f.root, loaded);
  const check = report.checks.find(c => c.check === 'worker models chosen');
  assert.deepEqual([check.ok, check.missing], [false, ['implementer']]);
  assert.ok(report.checks.some(c => c.check === 'worker hook installed'), 'the other checks still run');
  const [guidance] = doctorGuidance(report, { root: f.root, language: 'ja' }).filter(g => g.targets.includes('worker models chosen'));
  assert.equal(guidance.guidance.id, 'models-unset');
  assert.match(guidance.guidance.options[0].command, /models list --format markdown$/);
});

test('a Japanese question may offer model IDs as choices', t => {
  const f = prepare(t);
  setPreferences(f.root, { language: 'ja' });
  const ask = choices => interactiveDecision({ toolName: 'ask_user', cwd: f.root, toolArgs: { question: '実装担当のモデルを選んでください', choices } }, f.root);
  assert.equal(ask(['gpt-5-mini', 'claude-sonnet-4', 'o3', 'gpt-5.1-codex-max', '既定']), null);
  // English prose is still sent back for rewriting.
  assert.equal(ask(['same for all'])?.decision, 'deny');
});

test('folder trust compares Windows paths without regard to case', { skip: process.platform !== 'win32' && 'Windows paths only' }, t => {
  const f = prepare(t), home = safePath(f.root, 'cli-home');
  fs.mkdirSync(home);
  const parent = path.dirname(fs.realpathSync(f.root));
  for (const folder of [parent.toUpperCase(), parent.toLowerCase()]) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ trustedFolders: [folder] }));
    assert.equal(cliFolderTrust(f.root, home), 'trusted', folder);
  }
});

test('phase check reports what phase complete would refuse', t => {
  const f = prepare(t);
  fs.writeFileSync(safePath(f.root, 'migration/gap-report.md'), '# Gaps\nReviewed.\n');
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'templates', 'RULEBOOK.md'), safePath(f.root, 'migration/RULEBOOK.md'));
  // Without strict sequencing only the phase's own artifacts are checked.
  assert.throws(() => phaseCommand(f.root, f.config, 'check', '02'), /RULEBOOK\.md is still the installed template/);
  fs.rmSync(safePath(f.root, 'migration/feasibility.md'));
  assert.throws(() => phaseCommand(f.root, f.config, 'check', '00'), /Nonempty phase artifact required: migration\/feasibility\.md/);
});
