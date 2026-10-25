// SPDX-License-Identifier: Apache-2.0
// The fold benchmark (lib/bench.mjs, docs/REVIEW-BENCHMARK.md) with canned
// workers: scoring, call bounds, refusals, and the seeded fixtures themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, mini } from './helpers.mjs';
import { safePath } from '../lib/core.mjs';
import { runProcess } from '../lib/process.mjs';
import { benchDir, loadCases, benchPlan, catches, runBenchmark } from '../lib/bench.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';

function bench(t) {
  const f = prepare(t, { count: 3 });
  f.config.reviewFocus = 'shared';
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-out-')), 'run');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  return { ...f, out };
}
const targetOf = (reviewInput, unit) => JSON.parse(reviewInput).files.find(x => x.path === unit.target).content;
// Semantics sees division and length defects; rules sees the trailer and the
// import. One shared reviewer played by the semantics double misses the rules
// defects, which is the kind of change the report must show per case.
function adapter({ fixerFixes = true, implementerFixes = false, calls = [] } = {}) {
  return async ({ root, role, unit, extra, reviewInput }) => {
    calls.push(role);
    const common = { schemaVersion: 1, target: unit.target };
    if (role.startsWith('reviewer-')) {
      const text = targetOf(reviewInput, unit), findings = [];
      const add = (evidence, message) => findings.push({ id: `F${findings.length + 1}`, message, evidence, rule: 'Fixture rules' });
      if (role === 'reviewer-semantics') {
        if (text.includes('Math.trunc')) add(`${unit.target}:${text.split('\n').findIndex(l => l.includes('Math.trunc')) + 1} truncates`, 'quotient rounds the wrong way');
        if (unit.target.endsWith('math_ops.mjs') && !text.includes('b === 0')) add('src/math_ops.py:2 raises', 'missing error for b == 0');
        if (text.includes('a % b')) add('src/math_ops.py:4 Python remainder', 'remainder sign differs');
        if (text.includes('name.length')) add(`${unit.target}:2`, 'UTF-16 units, not code points');
      } else {
        if (!text.includes('PORT STATUS')) add(`${unit.target}:3`, 'no PORT STATUS trailer');
        if (text.includes("math_ops.js'")) add(`${unit.target}:2`, 'wrong import extension');
      }
      return { result: { ...common, kind: 'review', verdict: findings.length ? 'changes' : 'pass', findings }, tokens: 10, observedModel: 'canned' };
    }
    if (role === 'arbiter') return { result: { ...common, kind: 'arbitration', decisions: extra.findings.map(f => ({ finding: f.reference, confirmed: true, reason: 'canned' })) }, tokens: 5 };
    const fixes = role === 'fixer' ? fixerFixes : implementerFixes;
    assert.ok(Array.isArray(extra.confirmedFindings) && extra.confirmedFindings.length);
    const content = fixes ? fs.readFileSync(path.join(mini, 'expected', path.basename(unit.target)), 'utf8') : fs.readFileSync(safePath(root, unit.target), 'utf8');
    return { result: { ...common, kind: 'implementation', content, summary: 'canned' }, tokens: 20 };
  };
}

test('every seeded case fails its check and every control passes it', async () => {
  for (const c of loadCases()) {
    const run = await runProcess(process.execPath, [path.join(benchDir, c.check), path.join(benchDir, c.file)], { cwd: os.tmpdir(), timeoutMs: 20000 });
    assert.equal(run.code === 0, !c.defects.length, `${c.id}: ${run.stderr}`);
  }
  for (const name of ['math_ops', 'text_ops', 'main']) {
    const run = await runProcess(process.execPath, [path.join(benchDir, 'checks', `${name}.mjs`), path.join(mini, 'expected', `${name}.mjs`)], { cwd: os.tmpdir(), timeoutMs: 20000 });
    assert.equal(run.code, 0, run.stderr);
  }
});

test('a finding catches a defect by a cited line within one line or by its pattern', () => {
  const defect = { anchors: ['ported/math_ops.mjs:3', 'src/math_ops.py:4'], pattern: 'trunc' };
  assert.ok(catches({ message: 'x', evidence: 'ported/math_ops.mjs:4 wrong' }, defect));
  assert.ok(catches({ message: 'x', evidence: 'see src/math_ops.py:4' }, defect));
  assert.ok(!catches({ message: 'x', evidence: 'ported/math_ops.mjs:6 wrong' }, defect));
  assert.ok(!catches({ message: 'x', evidence: 'ported/text_ops.mjs:3 wrong' }, defect));
  assert.ok(catches({ message: 'Math.trunc rounds toward zero', evidence: 'no line' }, defect));
});

test('the plan bounds calls, and run refuses a lower --max-calls before any call', async t => {
  const f = bench(t), cases = loadCases(), calls = [];
  const plan = benchPlan(cases, { runs: 2 });
  const seeded = cases.filter(c => c.defects.length).length;
  assert.equal(plan.total, cases.length * 2 * 5 + seeded * 2 * 2);
  assert.equal(benchPlan(cases, { runs: 2, part: 'review' }).total, cases.length * 2 * 5);
  await assert.rejects(runBenchmark(f.root, f.config, adapter({ calls }), { cases, runs: 2, out: f.out, maxCalls: plan.total - 1 }), /--max-calls \d+/);
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(f.out));
});

test('the benchmark requires shared review focus so the single reviewer checks both lenses', async t => {
  const f = bench(t);
  delete f.config.reviewFocus;
  await assert.rejects(runBenchmark(f.root, f.config, adapter(), { cases: loadCases(), runs: 1, out: f.out, maxCalls: 1000 }), /reviewFocus "shared"/);
});

test('review and fix variants are scored per case, and changed cases are listed', async t => {
  const f = bench(t), cases = loadCases(), calls = [];
  const s = await runBenchmark(f.root, f.config, adapter({ calls }), { cases, runs: 2, out: f.out, maxCalls: 1000 });
  assert.equal(s.calls, calls.length);
  assert.ok(s.calls <= benchPlan(cases, { runs: 2 }).total);
  // Dual catches everything seeded; the semantics-only double misses the trailer and import.
  assert.equal(s.review.dual.missedConfirmed, 0);
  assert.equal(s.review.single.missedConfirmed, 4);
  assert.equal(s.review.single.seededDefectRuns, 16);
  assert.equal(s.review.single.missRateConfirmed, 0.25);
  assert.deepEqual(s.reviewChanges.map(c => `${c.case}:${c.defect}`).sort(), ['main-import:import', 'text-trailer:trailer']);
  assert.equal(s.review.dual.falseFindings, 0);
  // The fixer fixes; the implementer double returns the seeded file unchanged.
  assert.equal(s.fix.fixer.passRate, 1);
  assert.equal(s.fix.implementer.pass, 0);
  assert.equal(s.fixChanges.length, 7);
  assert.equal(s.review.dual.tokens, 2 * (9 * 2 * 10) + 5 * 2 * 7);
  const report = fs.readFileSync(path.join(f.out, 'report.md'), 'utf8');
  assert.match(report, /miss rate after arbiter \| 0% \(0\/16\) \| 25% \(4\/16\)/);
  assert.match(report, /text-trailer trailer: dual 2 confirmed/);
  const lines = fs.readFileSync(path.join(f.out, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 9 * 2 * 2 + 7 * 2 * 2);
  // The seeded target never stays behind in the benchmark root.
  for (const c of cases) assert.ok(!fs.existsSync(safePath(f.root, c.target)));
});

test('a first call that fails stops the run instead of scoring a miss', async t => {
  const f = bench(t);
  const failing = async () => { throw new Error('not logged in'); };
  await assert.rejects(runBenchmark(f.root, f.config, failing, { cases: loadCases(), runs: 1, out: f.out, maxCalls: 1000 }), /First .* call failed; nothing was measured: not logged in/);
});

test('the implementer is told to apply findings only when the fold benchmark hands them over', () => {
  const unit = { source: 'src/math_ops.py', target: 'ported/math_ops.mjs' };
  assert.doesNotMatch(agentPrompt({ role: 'implementer', unit, extra: { designInputs: [] } }), /confirmedFindings/);
  assert.match(agentPrompt({ role: 'implementer', unit, extra: { confirmedFindings: [], designInputs: [] } }), /apply ONLY extra\.confirmedFindings/);
});
