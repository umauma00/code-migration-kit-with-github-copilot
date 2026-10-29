#!/usr/bin/env node
// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
// Copilot adaptation: reviewed, hash-bound receipts determine completion.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, readManifest, contextHash, done } from '../lib/core.mjs';
import { parseCommandLine, specs, usageText } from '../lib/cli.mjs';
try {
  const args = parseCommandLine(process.argv.slice(2), specs.queue_runner);
  if (args.help) { console.log(usageText(specs.queue_runner)); process.exit(0); }
  const root = fs.realpathSync(path.resolve(args.root ?? '.'));
  if (args.manifest && args.manifest !== 'migration/manifest.tsv') throw new Error('Use migration/manifest.tsv; receipts are bound to the canonical manifest');
  const config = loadConfig(root), units = readManifest(root, config, args.manifest ?? 'migration/manifest.tsv');
  const context = contextHash(root, config), completed = units.filter(u => done(root, u, context));
  const command = args._[0] ?? 'status';
  if (command === 'status') console.log(`${completed.length}/${units.length} done (reviewed and hash-verified)`);
  else if (command === 'next') {
    const count = Number(args.batch ?? 100);
    if (!Number.isInteger(count) || count < 1) throw new Error('--batch must be a positive integer');
    console.log(JSON.stringify(units.filter(u => !done(root, u, context)).slice(0, count).map(({source, target}) => ({source, target})), null, 2));
  } else if (command === 'verify') {
    if (!units.length || completed.length !== units.length) throw new Error(`Only ${completed.length}/${units.length} units have current reviewed receipts`);
    console.log(`OK: ${units.length} reviewed outputs verified`);
  } else throw new Error('Use status | next | verify');
} catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
