import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsLaunch, runProcess } from '../lib/process.mjs';

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

// End to end through runProcess with the Windows branch on: the loader and the
// "native binary" are scripts that print which copy ran.
async function asWindows(fn) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', platform); }
}
function printing(label, { native = false } = {}) {
  const g = npmGlobal({ native: false });
  fs.writeFileSync(path.join(g.pkg, 'npm-loader.js'), `console.log(${JSON.stringify(`loader ${label}`)})`);
  if (native) {
    const exe = path.join(g.pkg, 'node_modules', '@github', `copilot-win32-${process.arch}`, 'copilot.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, `#!${process.execPath}\nconsole.log(${JSON.stringify(`native ${label}`)})\n`, { mode: 0o755 });
  }
  return g;
}

test('Windows lookup uses the PATH given to the child, not the parent PATH', async () => {
  const parent = printing('parent'), child = printing('child');
  const saved = process.env.PATH;
  process.env.PATH = `${parent.dir}${path.delimiter}${saved}`;
  try {
    const r = await asWindows(() => runProcess('copilot', [], { env: { PATH: child.dir } }));
    assert.equal(r.stdout.trim(), 'loader child');
  } finally { process.env.PATH = saved; }
});

test('Windows resolves a relative shim against the child cwd and runs it from there', async () => {
  for (const native of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-root-'));
    const g = printing(native ? 'tools-native' : 'tools', { native });
    fs.renameSync(g.dir, path.join(root, 'tools'));
    // The parent cwd has no tools/ folder; only the child's cwd does.
    const r = await asWindows(() => runProcess(path.join('.', 'tools', 'copilot.cmd'), [], { cwd: root }));
    assert.equal(r.stdout.trim(), native ? 'native tools-native' : 'loader tools');
    const launch = windowsLaunch(path.join('.', 'tools', 'copilot.cmd'), { cwd: root, platform: 'win32' });
    assert.ok(launch.prefixArgs.concat(launch.command).every(p => !p.includes('copilot') || path.isAbsolute(p)));
  }
});
