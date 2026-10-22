import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowsLaunch, runProcess, batchCommandLine } from '../lib/process.mjs';

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
  // A shim that is not npm's copilot loader (npm itself, a project script) runs through cmd.exe.
  const other = npmGlobal({ shim: '@"%~dp0\\node.exe" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*' });
  assert.deepEqual(windowsLaunch('copilot', win(other.dir)), { command: 'cmd.exe', prefixArgs: [], batch: path.join(other.dir, 'copilot.cmd') });
  // An .exe on PATH (WinGet, standalone) wins, and non-Windows never changes.
  fs.writeFileSync(path.join(dir, 'copilot.exe'), '');
  assert.deepEqual(windowsLaunch('copilot', win(dir)), { command: path.join(dir, 'copilot.exe'), prefixArgs: [] });
  assert.deepEqual(windowsLaunch('copilot', { ...win(dir), platform: 'linux' }), { command: 'copilot', prefixArgs: [] });
});

test('Windows finds the npm shim through a quoted PATH entry or npm\'s global prefix', () => {
  const { dir, exe } = npmGlobal();
  const empty = path.join(dir, 'empty');
  assert.deepEqual(windowsLaunch('copilot', { ...win(dir), env: { Path: `${empty}; "${dir}" ` } }), { command: exe, prefixArgs: [] });
  // PATH without npm's folder (a terminal opened before the install): npm's own prefix settings.
  assert.deepEqual(windowsLaunch('copilot', { ...win(dir), env: { Path: empty, npm_config_prefix: dir } }), { command: exe, prefixArgs: [] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-home-'));
  fs.writeFileSync(path.join(home, '.npmrc'), `registry=https://registry.npmjs.org/\r\nprefix=${dir}\r\n`);
  assert.deepEqual(windowsLaunch('copilot', { ...win(dir), env: { Path: empty, USERPROFILE: home } }), { command: exe, prefixArgs: [] });
  // npm expands ${VAR} and a leading ~ in .npmrc; the prefix here lives under the user profile.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-profile-'));
  const installed = npmGlobal();
  fs.renameSync(installed.dir, path.join(profile, '.npm-packages'));
  const moved = installed.exe.replace(installed.dir, path.join(profile, '.npm-packages'));
  for (const prefix of ['${USERPROFILE}/.npm-packages', '${userprofile?}/.npm-packages', '"${USERPROFILE}/.npm-packages"', "'~/.npm-packages'",
    '~/.npm-packages ; moved here', `${empty}\nprefix = \${USERPROFILE}/.npm-packages`]) {
    fs.writeFileSync(path.join(profile, '.npmrc'), `prefix=${prefix}\n`);
    assert.deepEqual(windowsLaunch('copilot', { ...win(dir), env: { Path: empty, USERPROFILE: profile } }), { command: moved, prefixArgs: [] }, prefix);
  }
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-appdata-'));
  fs.renameSync(dir, path.join(appData, 'npm'));
  assert.deepEqual(windowsLaunch('copilot', { ...win(dir), env: { Path: empty, APPDATA: appData } }),
    { command: exe.replace(dir, path.join(appData, 'npm')), prefixArgs: [] });
  // ${VAR?} is '' when unset and a variable set to '' expands to '' (both unlike a missing one).
  const run = (rc, extra = {}) => {
    fs.writeFileSync(path.join(profile, '.npmrc'), `${rc}\n`);
    return windowsLaunch('copilot', { ...win(dir), env: { Path: empty, USERPROFILE: profile, ...extra } }).command;
  };
  assert.equal(run('prefix=${USERPROFILE}/.npm-packages${UNSET_SUFFIX?}'), moved);
  assert.equal(run('prefix=${USERPROFILE}/.npm-packages${EMPTY_SUFFIX}', { EMPTY_SUFFIX: '' }), moved);
  assert.equal(run('prefix=${USERPROFILE}/.npm-packages${UNSET_SUFFIX}'), 'copilot');
  assert.equal(run('prefix=\\${USERPROFILE}/.npm-packages'), 'copilot');
  // Quoted values keep ; and #, unquoted ones end at them unless escaped; a [section] prefix is not global.
  const tools = path.join(profile, 'npm #tools;x');
  fs.renameSync(path.join(profile, '.npm-packages'), tools);
  const inTools = moved.replace(path.join(profile, '.npm-packages'), tools);
  for (const rc of ['prefix="${USERPROFILE}/npm #tools;x"', "prefix='${USERPROFILE}/npm #tools;x' ", 'prefix=${USERPROFILE}/npm \\#tools\\;x',
    `prefix="${tools.replaceAll('\\', '\\\\')}"\n[other]\nprefix=${empty}`]) assert.equal(run(rc), inTools, rc);
  assert.equal(run('prefix=${USERPROFILE}/npm #tools;x'), 'copilot');
  fs.renameSync(tools, path.join(profile, '.npm-packages'));
  // An empty prefix line does not take the next line, and a relative prefix never resolves against cwd.
  for (const rc of ['prefix=\r\nregistry=https://registry.npmjs.org/\r\n', 'prefix=.\n']) {
    fs.writeFileSync(path.join(profile, '.npmrc'), rc);
    assert.deepEqual(windowsLaunch('copilot', { ...win(dir), cwd: path.join(profile, '.npm-packages'), env: { Path: empty, USERPROFILE: profile } }), { command: 'copilot', prefixArgs: [] }, rc);
  }
  // Still nothing found: the bare name is left for spawn to report.
  assert.deepEqual(windowsLaunch('copilot', { ...win(dir), env: { Path: empty } }), { command: 'copilot', prefixArgs: [] });
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
    // On real Windows only a real executable spawns: a copy of node runs the -e
    // program that printing() returns; elsewhere a script stands in for it.
    if (process.platform === 'win32') fs.copyFileSync(process.execPath, exe);
    else fs.writeFileSync(exe, `#!${process.execPath}\nconsole.log(${JSON.stringify(`native ${label}`)})\n`, { mode: 0o755 });
  }
  return { ...g, args: ['-e', `console.log(${JSON.stringify(`native ${label}`)})`] };
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
    const r = await asWindows(() => runProcess(path.join('.', 'tools', 'copilot.cmd'), g.args, { cwd: root }));
    assert.equal(r.stdout.trim(), native ? 'native tools-native' : 'loader tools');
    const launch = windowsLaunch(path.join('.', 'tools', 'copilot.cmd'), { cwd: root, platform: 'win32' });
    assert.ok(launch.prefixArgs.concat(launch.command).every(p => !p.includes('copilot') || path.isAbsolute(p)));
  }
});

test('Windows runs other batch files (npx.cmd, gradlew.bat) through cmd.exe with quoted arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-batch-'));
  fs.writeFileSync(path.join(dir, 'npx.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\n');
  const env = { Path: dir, ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  assert.deepEqual(windowsLaunch('npx', { platform: 'win32', env }), { command: env.ComSpec, prefixArgs: [], batch: path.join(dir, 'npx.cmd') });
  assert.deepEqual(windowsLaunch(path.join(dir, 'gradlew.bat'), { platform: 'win32', env }), { command: env.ComSpec, prefixArgs: [], batch: path.join(dir, 'gradlew.bat') });
  assert.deepEqual(windowsLaunch('missing', { platform: 'win32', env }), { command: 'missing', prefixArgs: [] });
  // gradlew.bat in the project folder, named with its extension, is found in the child's cwd
  // (as cmd.exe finds it); a bare name is not, so the repository cannot shadow a PATH tool.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-project-'));
  fs.writeFileSync(path.join(project, 'gradlew.bat'), '@echo off\r\n');
  fs.writeFileSync(path.join(project, 'npm.cmd'), '@echo off\r\n');
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-win-tools-'));
  fs.writeFileSync(path.join(tools, 'npx.cmd'), '@echo off\r\n');
  const bare = { platform: 'win32', env: { Path: tools, ComSpec: env.ComSpec }, cwd: project };
  assert.deepEqual(windowsLaunch('gradlew.bat', bare), { command: env.ComSpec, prefixArgs: [], batch: path.join(project, 'gradlew.bat') });
  assert.deepEqual(windowsLaunch('gradlew', bare), { command: 'gradlew', prefixArgs: [] });
  assert.deepEqual(windowsLaunch('npx', bare), { command: env.ComSpec, prefixArgs: [], batch: path.join(tools, 'npx.cmd') });
  assert.deepEqual(windowsLaunch('npm', bare), { command: 'npm', prefixArgs: [] });
  assert.deepEqual(batchCommandLine('C:\\Program Files\\nodejs\\npx.cmd', ['tsc', 'a b', 'x"y', '100%']),
    ['/d', '/s', '/c', '"C:\\Program^ Files\\nodejs\\npx.cmd ^^^"tsc^^^" ^^^"a^^^ b^^^" ^^^"x\\^^^"y^^^" ^^^"100^^^%^^^""']);
  // A batch file reparses the %* it forwards, so metacharacters are escaped twice.
  assert.equal(batchCommandLine('C:\\p\\node_modules\\.bin\\tsc.cmd', ['a&b'])[3], '"C:\\p\\node_modules\\.bin\\tsc.cmd ^^^"a^^^&b^^^""');
});

test('a batch file receives its arguments unchanged on Windows', { skip: process.platform !== 'win32' && 'needs cmd.exe' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit win batch 日本 '));
  fs.writeFileSync(path.join(dir, 'echo.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(dir, 'echoargs.cmd'), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const args = ['plain', 'a b', 'x"y', '100%', '&|<>^()', 'trailing\\', '日本語'];
  for (const command of [path.join(dir, 'echoargs.cmd'), 'echoargs']) {
    const r = await runProcess(command, args, { cwd: dir, env: { ...process.env, [key]: `${dir};${process.env[key]}` } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args);
  }
  // Named with its extension from the project folder, off PATH (like "build": ["gradlew.bat", "build"]).
  const local = await runProcess('echoargs.cmd', args, { cwd: dir });
  assert.equal(local.code, 0, local.stderr);
  assert.deepEqual(JSON.parse(local.stdout), args);
});
