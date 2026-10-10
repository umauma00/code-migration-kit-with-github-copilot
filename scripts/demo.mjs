#!/usr/bin/env node
// Explicit offline simulation. Never used by the production Copilot adapter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, fake } from '../tests/helpers.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { parseArgs } from '../lib/core.mjs';
const args = parseArgs(process.argv.slice(2));
const root = args.target ? path.resolve(args.target) : fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-migration-demo-'));
if (args.target) {
  if (fs.existsSync(root)) throw new Error('--target must be a new directory');
  fs.mkdirSync(root, { recursive: true });
}
if (args._[0] === 'setup' && !args.model) throw new Error('setup requires --model MODEL_ID');
const { config } = prepare(null, { root, count: 3, realCommands: true, model: args.model ?? 'test-double' });
// prepare() validates the model. For offline demos pass a clearly synthetic ID.
console.log(JSON.stringify({ root, simulation: args._[0] !== 'setup', message: 'Canned worker results; Python and Node commands execute for real.' }));
if (args._[0] === 'setup') {
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
