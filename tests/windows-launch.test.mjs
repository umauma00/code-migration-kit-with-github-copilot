import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsLaunch } from '../lib/process.mjs';

// A global npm install on Windows: copilot.cmd on PATH, the loader in the
// package and the platform binary as its dependency (nested or hoisted).
const npmShim = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n)';
function npmGlobal({ nested = true, native = true, shim = npmShim } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-npm-'));
  const pkg = path.join(dir, 'node_modules', '@github', 'copilot');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'npm-loader.js'), '');
  fs.writeFileSync(path.join(dir, 'copilot.cmd'), shim);
  const exe = path.join(nested ? path.join(pkg, 'node_modules') : path.join(dir, 'node_modules'), '@github', 'copilot-win32-x64', 'copilot.exe');
  if (native) { fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, ''); }
  return { dir, pkg, exe };
}
const win = dir => ({ platform: 'win32', arch: 'x64', env: { Path: `${path.join(dir, 'empty')};${dir}` } });

test('Windows runs the npm copilot shim through the platform binary, nested or hoisted', () => {
  for (const nested of [true, false]) {
    const { dir, exe } = npmGlobal({ nested });
    assert.deepEqual(windowsLaunch('copilot', win(dir)), { command: exe, prefixArgs: [] });
    assert.deepEqual(windowsLaunch(path.join(dir, 'copilot.cmd'), win(dir)), { command: exe, prefixArgs: [] });
  }
});

test('Windows falls back to node and the loader, and leaves other commands alone', () => {
  const { dir, pkg } = npmGlobal({ native: false });
  assert.deepEqual(windowsLaunch('copilot', win(dir)), { command: process.execPath, prefixArgs: [path.join(pkg, 'npm-loader.js')] });
  // A shim that is not npm's copilot loader (npm itself, a project script) is not rewritten.
  const other = npmGlobal({ shim: '@"%~dp0\\node.exe" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*' });
  assert.deepEqual(windowsLaunch('copilot', win(other.dir)), { command: 'copilot', prefixArgs: [] });
  // An .exe on PATH (WinGet, standalone) wins, and non-Windows never changes.
  fs.writeFileSync(path.join(dir, 'copilot.exe'), '');
  assert.deepEqual(windowsLaunch('copilot', win(dir)), { command: path.join(dir, 'copilot.exe'), prefixArgs: [] });
  assert.deepEqual(windowsLaunch('copilot', { ...win(dir), platform: 'linux' }), { command: 'copilot', prefixArgs: [] });
});
