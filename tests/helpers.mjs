import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, kitRoot } from '../scripts/install.mjs';
import { loadConfig, roles, writeJSON, safePath, atomicWrite, readManifest } from '../lib/core.mjs';
import { approve, runStage } from '../lib/pipeline.mjs';

export const mini = path.join(kitRoot, 'fixtures/mini');
export function prepare(t, { realCommands = false, count = 1, model = 'test-double', root, workflow = false } = {}) {
  root ??= fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-migration-test-'));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model, withWorkflow: workflow });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  fs.cpSync(path.join(mini, 'tests'), path.join(root, 'tests'), { recursive: true });
  const config = loadConfig(root);
  config.concurrency = 2;
  for (const name of ['original', 'mutation', 'build', 'smoke', 'parity']) {
    config.commands[name] = realCommands ? ['python3', '-B', 'tests/judge.py', name] : [process.execPath, '-e', 'console.log("test command OK")'];
  }
  config.commands.typecheck = ['node', '--check', '{target}'];
  writeJSON(safePath(root, 'migration/config.json'), config);
  const names = ['math_ops', 'text_ops', 'main'].slice(0, count);
  atomicWrite(safePath(root, 'migration/manifest.tsv'), 'source\ttarget\n' + names.map(n => `src/${n}.py\tported/${n}.mjs\n`).join(''));
  atomicWrite(safePath(root, 'migration/RULEBOOK.md'), '# Fixture rules\nPreserve floor division, remainder signs, zero-division errors and Unicode code-point lengths. Keep one-to-one filenames; use .mjs imports. Inputs are safe-range integers and Unicode strings. End each file with a PORT STATUS comment.\n');
  atomicWrite(safePath(root, 'migration/inventory.tsv'), 'source\tissue\tdecision\nsrc/math_ops.py\tnegative division\tfloor, not truncate\nsrc/text_ops.py\tUnicode length\tcode points\n');
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Fixture only: three files, finite integer/string contract; no architecture redesign.\n');
  atomicWrite(safePath(root, 'migration/stress-test/report.md'), 'TEST FIXTURE: numeric boundaries and Unicode cases are checked by tests/judge.py. This canned setup is not an AI bakeoff or a production approval.\n');
  return { root, config, units: readManifest(root, config) };
}
export async function ready(t, options) {
  const fixture = prepare(t, options);
  await runStage(fixture.root, fixture.config, 'judge');
  approve(fixture.root, fixture.config, 'translation', 'Automated fixture approval for tests only');
  return fixture;
}
export function result(role, unit, { findings = [], decisions = [], content } = {}) {
  const common = { schemaVersion: 1, target: unit.target };
  if (role === 'implementer' || role === 'fixer') return { ...common, kind: 'implementation', content: content ?? fs.readFileSync(path.join(mini, 'expected', path.basename(unit.target)), 'utf8'), summary: 'Canned test implementation, not AI output' };
  if (role === 'arbiter') return { ...common, kind: 'arbitration', decisions };
  return { ...common, kind: 'review', verdict: findings.length ? 'changes' : 'pass', findings };
}
export const finding = { id: 'F1', message: 'Wrong division rounding', evidence: 'src/math_ops.py:4 uses floor division', rule: 'Fixture rules: preserve negative division' };
export const fake = async ({ role, unit, extra }) => ({ result: result(role, unit,
  role === 'arbiter' ? { decisions: extra.findings.map(f => ({ finding: f.reference, confirmed: true, reason: f.evidence })) } : {}),
  requestedModel: 'test-double', observedModel: null, tokens: null, aiCredits: null });
