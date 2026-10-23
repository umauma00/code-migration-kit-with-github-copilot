#!/usr/bin/env node
// Explicit offline simulation. Never used by the production Copilot adapter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, fake } from '../tests/helpers.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { safePath, writeJSON, atomicWrite } from '../lib/core.mjs';
import { parseCommandLine, specs, usageText } from '../lib/cli.mjs';
const args = parseCommandLine(process.argv.slice(2), specs.demo);
if (args.help) { console.log(usageText(specs.demo)); process.exit(0); }
const root = args.target ? path.resolve(args.target) : fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-migration-demo-'));
if (args.target) {
  if (fs.existsSync(root)) throw new Error('--target must be a new directory');
  fs.mkdirSync(root, { recursive: true });
}
if (args._[0] === 'setup' && !args.model) throw new Error('setup requires --model MODEL_ID');
const { config } = prepare(null, { root, count: 3, realCommands: true, model: args.model ?? 'test-double' });
// prepare() validates the model. For offline demos pass a clearly synthetic ID.
console.log(JSON.stringify({ root, simulation: args._[0] !== 'setup', message: args._[0] === 'setup' ? 'Draft source/judge/config inputs only; no commands, model calls or approvals executed.' : 'Canned worker results; Python and Node commands execute for real.' }));
if (args._[0] === 'setup') {
  // Live setup uses the actual new-project policy, not the offline helper bypass.
  config.phasePolicy = 'strict'; config.markerPolicy = 'todo-lines-v1';
  writeJSON(safePath(root, 'migration/config.json'), config);
  fs.rmSync(safePath(root, 'migration/stress-test/report.md'));
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) {
    atomicWrite(safePath(root, name), '# Draft live-check preparation\nInspect the fixture evidence and perform the applicable independent audits before recording review. This is not a completed review.\n');
  }
  const rules = safePath(root, 'migration/RULEBOOK.md');
  atomicWrite(rules, fs.readFileSync(rules, 'utf8') + '\nMarker policy todo-lines-v1: count literal TODO(port) lines. Finish with exactly one PORT STATUS: confidence=high|medium|low todos=N trailer matching that count.\n');
  console.log('Setup only. Review artifacts, configure your real model and follow docs/LIVE-SMOKE.md. No approvals or model calls were made.');
} else {
  await runStage(root, config, 'judge');
  approve(root, config, 'translation', 'Offline demonstration using canned worker results');
  console.log(JSON.stringify(await translate(root, config, fake), null, 2));
  for (const stage of ['build', 'smoke', 'parity']) {
    approve(root, config, stage, 'Offline demonstration: inspect previous fixture command results');
    const run = await runStage(root, config, stage);
    console.log(JSON.stringify({ stage, success: run.success, output: run.commands.map(c => c.stdout.trim()) }));
  }
}
