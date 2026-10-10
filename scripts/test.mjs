#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = new URL('../tests/', import.meta.url);
const tests = fs.readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort();
if (!tests.length) throw new Error('No test files found; refusing an empty successful test run');
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...tests.map(name => `tests/${name}`)], { cwd: root, stdio: 'inherit', shell: false });
child.once('error', e => { console.error(e.message); process.exitCode = 1; });
child.once('close', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
