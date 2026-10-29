// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { kitRoot } from '../scripts/install.mjs';
import { auditInterruptions } from '../scripts/audit_interruptions.mjs';

test('the complete interruption source index matches current maintained sources', () => {
  const index = auditInterruptions(kitRoot);
  const saved = JSON.parse(fs.readFileSync(path.join(kitRoot, 'docs/interruption-sources.json'), 'utf8'));
  assert.deepEqual(saved, index, 'regenerate node scripts/audit_interruptions.mjs > docs/interruption-sources.json after reviewing stop changes');
  for (const file of ['lib/process.mjs', 'lib/models.mjs', 'lib/survey.mjs', 'lib/survey-parts.mjs', 'lib/pipeline.mjs', 'lib/build-loop.mjs', 'lib/bench.mjs', 'lib/execution-policy.mjs', 'scripts/copilot_adapter.mjs', 'scripts/run_migration.mjs']) {
    assert.ok(index.files.some(f => f.path === file && f.entries.length > 0), file);
  }
  assert.ok(index.files.some(f => f.path === '.github/workflows/test.yml'), 'development CI limits are included and distinguished');
});

test('runtime process termination is confined to cancellation/error handlers and RPC cleanup; no hidden literal deadlines remain', () => {
  const index = auditInterruptions(kitRoot);
  const kills = index.files.filter(f => f.entries.some(e => e.kind === 'process-termination'));
  assert.deepEqual(kills.map(f => f.path).sort(), ['lib/models.mjs', 'lib/process.mjs']);
  for (const file of index.files.filter(f => /^(lib|scripts)\//.test(f.path))) {
    const source = fs.readFileSync(path.join(kitRoot, file.path), 'utf8');
    assert.doesNotMatch(source, /timeoutMs:\s*[1-9]\d*/, `${file.path}: no implicit per-process deadline`);
    assert.doesNotMatch(source, /process\.cpuUsage\s*\(|os\.loadavg\s*\(/, `${file.path}: CPU observation must never become a kill condition`);
  }
});

test('every distributed parent instruction forbids CPU/time/silence cancellation and implicit finite budgets', () => {
  for (const file of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md',
    '.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md', '.github/copilot-instructions.md', 'docs/PHASE-HANDOFF.md']) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8');
    for (const pattern of [/100%/, /600/, /continuous/, /explicit/]) assert.match(text, pattern, file);
  }
});
