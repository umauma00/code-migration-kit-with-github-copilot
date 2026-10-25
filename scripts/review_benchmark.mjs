#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Seeded-defect benchmark for folding workers together (docs/REVIEW-BENCHMARK.md):
// two reviewers vs one, and the fixer vs the implementer. setup makes a
// throwaway root from fixtures/mini; plan prints the call bound; run makes
// real Copilot CLI calls with the models in that root's migration/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare } from '../tests/helpers.mjs';
import { loadConfig, safePath, writeJSON, stamp } from '../lib/core.mjs';
import { loadCases, benchPlan, runBenchmark, benchMarker } from '../lib/bench.mjs';
import { parseCommandLine, specs, usageText } from '../lib/cli.mjs';
import { createCopilotAdapter } from './copilot_adapter.mjs';

const args = parseCommandLine(process.argv.slice(2), specs.review_benchmark);
if (args.help) { console.log(usageText(specs.review_benchmark)); process.exit(0); }
const command = args._[0];
const runs = () => {
  const n = Number(args.runs ?? 3);
  if (!Number.isInteger(n) || n < 1) throw new Error('--runs must be a positive integer');
  return n;
};
try {
  if (command === 'setup') {
    if (!args.target || !args.model) throw new Error('setup needs --target NEW_DIR --model MODEL_ID');
    const root = path.resolve(args.target);
    if (fs.existsSync(root)) throw new Error('--target must be a new directory');
    fs.mkdirSync(root, { recursive: true });
    const { config } = prepare(null, { root, count: 3, model: args.model });
    // Both variants get full reviewers: dual is the new-install default, and
    // the single reviewer must check both lenses to be a fair fold.
    config.reviewFocus = 'shared';
    writeJSON(safePath(root, 'migration/config.json'), config);
    // Workers read this root with view/grep/glob. Leave out what names the
    // seeded defects or holds correct code: the benchmark's own docs and code,
    // and the fixture judge's mutant and cases. The benchmark runs from the kit.
    for (const name of ['migration-kit/docs/REVIEW-BENCHMARK.md', 'migration-kit/docs/REVIEW-BENCHMARK.en.md', 'migration-kit/lib/bench.mjs', 'migration-kit/scripts/review_benchmark.mjs', 'tests']) {
      fs.rmSync(safePath(root, name), { recursive: true, force: true });
    }
    writeJSON(safePath(root, benchMarker), { schemaVersion: 1, kind: 'review-benchmark-root', createdAt: stamp() });
    console.log(JSON.stringify({ root, models: config.models, next: `Choose models per role if they differ (migration/config.json models), then: node scripts/review_benchmark.mjs plan --root ${root}` }, null, 2));
  } else {
    if (!args.root) throw new Error(`${command} needs --root PATH (a directory made by setup)`);
    const root = path.resolve(args.root), config = loadConfig(root);
    const cases = loadCases(undefined, args.cases);
    const plan = benchPlan(cases, { runs: runs(), part: args.part ?? 'all' });
    if (command === 'plan') console.log(JSON.stringify({ ...plan, models: config.models, reviewFocus: config.reviewFocus }, null, 2));
    else {
      // Outside the root: workers can read the root, and results hold the answers.
      const out = path.resolve(args.out ?? path.join(os.tmpdir(), 'review-bench-results', stamp().replace(/[:.]/g, '-')));
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      const summary = await runBenchmark(root, config, createCopilotAdapter({ command: args.copilot }), {
        cases, runs: plan.runs, part: plan.part, out, maxCalls: Number(args['max-calls']), signal: controller.signal,
        onProgress: e => console.error(`${e.case}: ${e.part} ${e.variant} run ${e.run + 1}`) });
      console.log(JSON.stringify({ out, report: path.join(out, 'report.md'), calls: summary.calls, review: summary.part === 'fix' ? undefined : { dual: summary.review.dual.missRateConfirmed, single: summary.review.single.missRateConfirmed },
        fix: summary.part === 'review' ? undefined : { fixer: summary.fix.fixer.passRate, implementer: summary.fix.implementer.passRate } }, null, 2));
    }
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
