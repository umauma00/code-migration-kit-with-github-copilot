#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, safePath } from '../lib/core.mjs';
import { parseResult } from '../lib/results.mjs';
import { listNativeTasks, claimNativeTask, submitNativeTask, maxNativeResponseBytes } from '../lib/native-workers.mjs';

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), cmd = args._[0], root = fs.realpathSync(path.resolve(args.root ?? '.'));
  let output;
  if (cmd === 'list') output = listNativeTasks(root);
  else if (cmd === 'claim') output = claimNativeTask(root, args.task);
  else if (cmd === 'fail') output = submitNativeTask(root, args.task, args.claim, { error: args.error });
  else if (cmd === 'submit') {
    let content;
    if (!args.file) throw new Error('submit requires --file PATH or --file - for stdin');
    if (args.file === '-') {
      const chunks = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > maxNativeResponseBytes) throw new Error('Native response exceeded limit');
        chunks.push(chunk);
      }
      content = Buffer.concat(chunks).toString('utf8');
    } else {
      const file = safePath(root, args.file);
      if (fs.statSync(file).size > maxNativeResponseBytes) throw new Error('Native response exceeded limit');
      content = fs.readFileSync(file, 'utf8');
    }
    output = submitNativeTask(root, args.task, args.claim, { result: parseResult(content), model: args.model });
  } else throw new Error('Usage: native_workers.mjs list | claim --task ID | submit --task ID --claim TOKEN --model MODEL --file PATH|- | fail --task ID --claim TOKEN --error MESSAGE [--root PATH]');
  console.log(JSON.stringify(output, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
}
