#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = new URL('../tests/', import.meta.url);
const tests = fs.readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort();
if (!tests.length) throw new Error('No test files found; refusing an empty successful test run');
// Hermetic Copilot home: the developer's ~/.copilot (trusted folders, agents,
// installed plugins) must not change doctor results inside the suite.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-copilot-home-'));
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...tests.map(name => `tests/${name}`)], { cwd: root, stdio: 'inherit', shell: false,
  env: { ...process.env, COPILOT_HOME: home } });
// Tests that choose workerCopilotHome "separate" make a sibling worker home (lib/worker-home.mjs).
child.once('close', () => { for (const dir of [home, `${home}-migration-kit-workers`]) fs.rmSync(dir, { recursive: true, force: true }); });
child.once('error', e => { console.error(e.message); process.exitCode = 1; });
child.once('close', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
