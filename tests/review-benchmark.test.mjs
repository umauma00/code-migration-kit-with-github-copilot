// SPDX-License-Identifier: Apache-2.0
// The fold benchmark (lib/bench.mjs, docs/REVIEW-BENCHMARK.md) with canned
// workers: scoring, call bounds, refusals, and the seeded fixtures themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, mini } from './helpers.mjs';
import { safePath, writeJSON, atomicWrite } from '../lib/core.mjs';
import { runProcess } from '../lib/process.mjs';
import { benchDir, loadCases, benchPlan, catches, creditedDefect, runBenchmark, benchMarker, answerLeaks, answerLines } from '../lib/bench.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';

function bench(t) {
  const f = prepare(t, { count: 3 });
  f.config.reviewFocus = 'shared';
  writeJSON(safePath(f.root, benchMarker), { schemaVersion: 1, kind: 'review-benchmark-root' });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-out-')), 'run');
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
  return { ...f, out };
}
const targetOf = (reviewInput, unit) => JSON.parse(reviewInput).files.find(x => x.path === unit.target).content;
// Semantics sees division and length defects; rules sees the trailer and the
// import. One shared reviewer played by the semantics double misses the rules
// defects, which is the kind of change the report must show per case.
function adapter({ fixerFixes = true, implementerFixes = false, calls = [], focus = [], fixedContent } = {}) {
  return async ({ root, config, role, unit, extra, reviewInput }) => {
    calls.push(role);
    if (role.startsWith('reviewer-')) focus.push(config.reviewFocus);
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
    const content = fixes && fixedContent ? fixedContent(unit) : fixes ? fs.readFileSync(path.join(mini, 'expected', path.basename(unit.target)), 'utf8') : fs.readFileSync(safePath(root, unit.target), 'utf8');
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

test('a finding catches a defect by an exact cited line or by its pattern', () => {
  const defect = { anchors: ['ported/math_ops.mjs:3', 'src/math_ops.py:4'], pattern: 'trunc' };
  assert.ok(catches({ message: 'x', evidence: 'ported/math_ops.mjs:3 wrong' }, defect));
  assert.ok(catches({ message: 'x', evidence: 'see src/math_ops.py:4' }, defect));
  assert.ok(!catches({ message: 'x', evidence: 'ported/math_ops.mjs:4 wrong' }, defect));
  assert.ok(!catches({ message: 'x', evidence: 'ported/text_ops.mjs:3 wrong' }, defect));
  assert.ok(catches({ message: 'Math.trunc rounds toward zero', evidence: 'no line' }, defect));
});

test('a finding about one seeded defect is not credited to its neighbor', () => {
  const [trunc, zero] = loadCases().find(c => c.id === 'math-double').defects;
  const truncFinding = { message: 'Quotient rounds toward zero instead of flooring', evidence: 'ported/math_ops.mjs:2 uses Math.trunc', rule: 'floor division' };
  assert.deepEqual(creditedDefect(truncFinding, [trunc, zero]), { defect: 'trunc' });
  assert.ok(!catches(truncFinding, zero));
  const zeroFinding = { message: 'No error for b == 0', evidence: 'src/math_ops.py:2 raises ValueError', rule: 'zero-division errors' };
  assert.deepEqual(creditedDefect(zeroFinding, [trunc, zero]), { defect: 'zero' });
  // Words naming both, no line: credited to neither and marked ambiguous.
  assert.deepEqual(creditedDefect({ message: 'Math.trunc and no ValueError', evidence: 'see file' }, [trunc, zero]), { defect: null, ambiguous: ['trunc', 'zero'] });
  // On the remainder case, a finding on the floor line is not the remainder defect.
  const [remainder] = loadCases().find(c => c.id === 'math-remainder').defects;
  assert.ok(!catches({ message: 'quotient looks fine', evidence: 'ported/math_ops.mjs:3' }, remainder));
  // The original's line 4 holds both // and %: citing it credits neither by line.
  const [trunc1] = loadCases(undefined, 'math-trunc')[0].defects;
  assert.ok(!catches({ message: 'sign looks wrong', evidence: 'src/math_ops.py:4' }, trunc1));
  assert.ok(!catches({ message: 'Math.floor differs from //', evidence: 'src/math_ops.py:4' }, remainder));
});

test('setup leaves no correct fixture code where workers can read it', async t => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-setup-')), 'root');
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  const run = await runProcess(process.execPath, [path.join(kitRoot, 'scripts/review_benchmark.mjs'), 'setup', '--target', root, '--model', 'test-double'], { cwd: kitRoot, timeoutMs: 60000 });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(answerLeaks(root), []);
  assert.ok(fs.existsSync(path.join(root, benchMarker)));
  assert.ok(!fs.existsSync(path.join(root, 'migration-kit/docs/REVIEW-BENCHMARK.md')));
  // The check itself finds a leak.
  fs.writeFileSync(path.join(root, 'migration/leak.md'), 'const quotient = Math.floor(a / b);\n');
  assert.deepEqual(answerLeaks(root), ['migration/leak.md']);
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
  await assert.rejects(runBenchmark(f.root, f.config, failing, { cases: loadCases(), runs: 1, out: f.out, maxCalls: 1000 }), /First 3 calls failed; nothing was measured: not logged in/);
});

test('run refuses a root setup did not make, a target already present, and output inside the root', async t => {
  const f = bench(t), cases = loadCases(undefined, 'math-trunc'), calls = [];
  const run = (options = {}) => runBenchmark(f.root, f.config, adapter({ calls }), { cases, runs: 1, out: f.out, maxCalls: 100, ...options });
  atomicWrite(safePath(f.root, 'ported/math_ops.mjs'), 'export const real = 1;\n');
  await assert.rejects(run(), /already exists in the benchmark root/);
  assert.equal(fs.readFileSync(safePath(f.root, 'ported/math_ops.mjs'), 'utf8'), 'export const real = 1;\n');
  fs.rmSync(safePath(f.root, 'ported/math_ops.mjs'));
  await assert.rejects(run({ out: path.join(f.root, 'results') }), /outside the benchmark root/);
  // Through a symlinked parent too.
  const link = path.join(path.dirname(f.out), 'link');
  fs.mkdirSync(safePath(f.root, 'sub'));
  fs.symlinkSync(safePath(f.root, 'sub'), link, 'junction');
  await assert.rejects(run({ out: path.join(link, 'results') }), /outside the benchmark root/);
  assert.ok(!fs.existsSync(safePath(f.root, 'sub/results')));
  fs.rmSync(safePath(f.root, benchMarker));
  await assert.rejects(run(), /Not a benchmark root/);
  assert.deepEqual(calls, []);
});

test('the single reviewer is told it is the only one; dual reviewers keep the shared contract', async t => {
  const f = bench(t), focus = [];
  await runBenchmark(f.root, f.config, adapter({ focus }), { cases: loadCases(undefined, 'control-math'), runs: 1, part: 'review', out: f.out, maxCalls: 100 });
  assert.deepEqual(focus.sort(), ['shared', 'shared', 'single']);
  const unit = { source: 'src/math_ops.py', target: 'ported/math_ops.mjs' };
  assert.match(agentPrompt({ role: 'reviewer-semantics', unit, reviewInput: '{}', reviewFocus: 'single' }), /You are the only reviewer: report every defect/);
  assert.match(agentPrompt({ role: 'reviewer-semantics', unit, reviewInput: '{}', reviewFocus: 'shared' }), /one of two independent full reviewers/);
});

test('after a failure no further jobs start, and the seeded target is removed', async t => {
  const f = bench(t);
  f.config.concurrency = 2;
  let n = 0;
  const failing = async () => { n++; throw new Error('not logged in'); };
  await assert.rejects(runBenchmark(f.root, f.config, failing, { cases: loadCases(), runs: 3, out: f.out, maxCalls: 1000 }), /First/);
  // Two jobs at most were in flight, two reviewers each.
  assert.ok(n <= 4, `calls after failure: ${n}`);
  assert.ok(!fs.existsSync(safePath(f.root, 'ported/math_ops.mjs')));
  assert.ok(!fs.existsSync(safePath(f.root, 'ported')));
  assert.ok(!fs.existsSync(f.out));
});

test('nothing is written to the output until the run ends', async t => {
  const f = bench(t), base = adapter();
  const watch = async options => { assert.ok(!fs.existsSync(f.out), 'output written mid-run'); return base(options); };
  await runBenchmark(f.root, f.config, watch, { cases: loadCases(undefined, 'math-trunc'), runs: 1, out: f.out, maxCalls: 100 });
  assert.ok(fs.existsSync(path.join(f.out, 'fixes/math-trunc-fixer-0/math_ops.mjs')));
});

test('Ctrl-C reads as interrupted, not as failing calls', async t => {
  const f = bench(t), controller = new AbortController();
  const hang = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('killed')), { once: true }));
  f.config.concurrency = 4;
  const run = runBenchmark(f.root, f.config, hang, { cases: loadCases(), runs: 2, out: f.out, maxCalls: 1000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(run, /^Error: Interrupted$/);
});

test('answer lines are every correct line some seeded case lacks', () => {
  const lines = answerLines();
  for (const line of ["if (b === 0) throw new Error('division by zero');", 'const quotient = Math.floor(a / b);', "import { divide } from './math_ops.mjs';", '// PORT STATUS: complete; count Unicode code points, including astral characters.']) assert.ok(lines.includes(line), line);
  // Lines every seeded case shares are not answers.
  assert.ok(!lines.includes('export function divide(a, b) {'));
});

test('one malformed first answer is a failed run, not a stop', async t => {
  const f = bench(t), base = adapter();
  let first = true;
  const once = async options => {
    if (first) { first = false; throw new Error('Invalid review JSON'); }
    return base(options);
  };
  f.config.concurrency = 1;
  const s = await runBenchmark(f.root, f.config, once, { cases: loadCases(undefined, 'control-math'), runs: 2, part: 'review', out: f.out, maxCalls: 100 });
  assert.equal(s.review.dual.failed, 1);
  assert.equal(s.review.dual.runs + s.review.single.runs, 3);
});

test('a reviewer failure after other successes counts both calls of that run', async t => {
  const f = bench(t), base = adapter();
  let rules = 0;
  const flaky = async options => {
    if (options.role === 'reviewer-rules' && ++rules === 2) throw new Error('rate limited');
    return base(options);
  };
  f.config.concurrency = 1;
  const s = await runBenchmark(f.root, f.config, flaky, { cases: loadCases(undefined, 'control-math'), runs: 2, part: 'review', out: f.out, maxCalls: 100 });
  assert.equal(s.review.dual.failed, 1);
  assert.equal(s.review.dual.calls, 4);
  assert.equal(s.calls, 6);
});

test('behavior checks run without this shell\'s environment', async t => {
  const f = bench(t);
  process.env.BENCH_TEST_SECRET = 'x';
  t.after(() => { delete process.env.BENCH_TEST_SECRET; });
  const leaky = unit => `${fs.readFileSync(path.join(mini, 'expected', path.basename(unit.target)), 'utf8')}if (process.env.BENCH_TEST_SECRET) throw new Error('environment leaked');\n`;
  const s = await runBenchmark(f.root, f.config, adapter({ fixedContent: leaky }), { cases: loadCases(undefined, 'math-trunc'), runs: 1, part: 'fix', out: f.out, maxCalls: 100 });
  assert.equal(s.fix.fixer.pass, 1);
});

test('the implementer is told to apply findings only when the fold benchmark hands them over', () => {
  const unit = { source: 'src/math_ops.py', target: 'ported/math_ops.mjs' };
  assert.doesNotMatch(agentPrompt({ role: 'implementer', unit, extra: { designInputs: [] } }), /confirmedFindings/);
  assert.match(agentPrompt({ role: 'implementer', unit, extra: { confirmedFindings: [], designInputs: [] } }), /apply ONLY extra\.confirmedFindings/);
});
