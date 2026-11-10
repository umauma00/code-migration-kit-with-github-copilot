// SPDX-License-Identifier: Apache-2.0
// On 2026-11-09 a company PC reset the user's environment from time to time:
// PowerShell's PATH lost npm's folder, `copilot` was not found there, and the
// agent offered to install the CLI again. The kit now remembers where a
// Copilot CLI answered and runs it from there when PATH has none, passes over
// VS Code's copilot shims, also looks in the installers' folders, and offers
// `run_migration.mjs cli` (also before initialization) so the agent checks the
// CLI through the kit instead of its own terminal (0.49.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// Every record this file writes goes to a home of its own (the record sits beside it).
const privateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-copilot-record-home-'));
process.env.COPILOT_HOME = privateHome;
const { windowsLocate, windowsLaunch, posixLocate, rememberCopilot, copilotInstallDirs, copilotSearchPlaces } = await import('../lib/process.mjs');
const { copilotRecordFile, readCopilotRecord, writeCopilotRecord, namesCopilot, isVSCodeShim, terminalCommands } = await import('../lib/copilot-location.mjs');
const { stressBCommand, cliPlaces } = await import('../scripts/copilot_adapter.mjs');
const { failureGuidance } = await import('../lib/guidance.mjs');
const { doctor } = await import('../scripts/run_migration.mjs');
const { prepare } = await import('./helpers.mjs');
const { kitRoot } = await import('../scripts/install.mjs');

const posix = process.platform !== 'win32';
const temps = [privateHome, `${privateHome}-migration-kit`];
process.on('exit', () => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = (prefix = 'kit-copilot-') => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
const marker = 'VSCODE_COPILOT_RUST_SHIM_V1';
// VS Code 1.143's shim: a binary that holds the marker (here a stand-in).
const nativeShim = dir => { const file = path.join(dir, 'copilot.exe'); fs.writeFileSync(file, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096), Buffer.from(marker), Buffer.alloc(64)])); return file; };
// The extension's legacy wrappers, as VS Code wrote them.
const legacyBat = dir => `@echo off\r\npowershell -ExecutionPolicy Bypass -File "${path.join(dir, 'copilot.ps1')}" %*\r\n`;
const legacyLauncher = dir => `#!/bin/sh\nunset NODE_OPTIONS\nELECTRON_RUN_AS_NODE=1 "/opt/VS Code/code" "${dir}/copilotCLIShim.js" "$@"`;
const gitBashWrapper = '#!/bin/sh\nexec "$(dirname "$0")/copilot.bat" "$@"\n';
// A global npm install on Windows (tests/windows-launch.test.mjs).
const npmShim = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n)';
function npmGlobal(dir = tmp('kit-copilot-npm-')) {
  const pkg = path.join(dir, 'node_modules', '@github', 'copilot');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'npm-loader.js'), '');
  fs.writeFileSync(path.join(dir, 'copilot.cmd'), npmShim);
  const exe = path.join(pkg, 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'MZ the real CLI');
  return { dir, exe, cmd: path.join(dir, 'copilot.cmd') };
}
const win = (env, extra = {}) => ({ platform: 'win32', arch: 'x64', env, remembered: () => null, ...extra });

test('the record of a working CLI belongs to the person, beside their Copilot home', () => {
  const home = tmp();
  assert.equal(copilotRecordFile({ COPILOT_HOME: home }), path.join(`${path.resolve(home)}-migration-kit`, 'copilot-cli.json'));
  // A relative COPILOT_HOME (as the CLI reads it) does not move it into a project.
  for (const env of [{}, { COPILOT_HOME: 'relative/home' }]) assert.equal(copilotRecordFile(env), path.join(os.homedir(), '.copilot-migration-kit', 'copilot-cli.json'));
  assert.equal(copilotRecordFile(), path.join(`${privateHome}-migration-kit`, 'copilot-cli.json'));
});

test('a record is written only when the place changes, and a broken one reads as none', () => {
  const recordFile = path.join(tmp(), 'nested', 'copilot-cli.json'), now = new Date('2026-11-10T00:00:00Z');
  const first = path.join(tmp(), 'A', 'copilot.exe');
  const written = writeCopilotRecord(first, { via: 'path', version: '1.0.108', recordFile, platform: 'win32', now });
  assert.deepEqual(written, { recorded: true, file: recordFile, path: first });
  const record = readCopilotRecord(recordFile);
  assert.deepEqual({ ...record, note: undefined }, { path: first, foundIn: 'path', version: '1.0.108', recordedAt: '2026-11-10T00:00:00.000Z', note: undefined });
  assert.match(record.note, /Delete this file to forget it/);
  const before = fs.statSync(recordFile).mtimeMs;
  // Windows names a file in any case: the same place is not written again.
  assert.deepEqual(writeCopilotRecord(first.toUpperCase().replace(/COPILOT\.EXE$/, 'copilot.EXE'), { recordFile, platform: 'win32' }).unchanged, true);
  assert.equal(fs.statSync(recordFile).mtimeMs, before);
  const second = path.join(tmp(), 'B', 'copilot.exe');
  assert.deepEqual(writeCopilotRecord(second, { via: 'npm', recordFile, platform: 'win32', now }), { recorded: true, file: recordFile, path: second, replaced: first });
  assert.equal(readCopilotRecord(recordFile).path, second);
  assert.deepEqual(fs.readdirSync(path.dirname(recordFile)), ['copilot-cli.json'], 'no temporary file is left');
  // An editor's byte order mark is read; anything else broken is no record.
  fs.writeFileSync(recordFile, `\uFEFF${JSON.stringify({ path: second })}`);
  assert.equal(readCopilotRecord(recordFile).path, second);
  for (const text of ['{', '[]', 'null', JSON.stringify({ path: 'relative/copilot' }), JSON.stringify({ path: 42 })]) {
    fs.writeFileSync(recordFile, text);
    assert.equal(readCopilotRecord(recordFile), null, text);
  }
  assert.equal(readCopilotRecord(path.join(tmp(), 'missing.json')), null);
});

test('only the copilot command itself is looked up in the remembered place and recorded', () => {
  for (const name of ['copilot', '/usr/local/bin/copilot']) assert.equal(namesCopilot(name, 'linux'), true, name);
  for (const name of ['copilot.exe', 'copilot.mjs', 'node', '/opt/copilot/cli.mjs', '', undefined]) assert.equal(namesCopilot(name, 'linux'), false, String(name));
  for (const name of ['copilot', 'C:\\npm\\copilot.cmd', 'COPILOT.EXE', 'c:/tools/copilot.bat']) assert.equal(namesCopilot(name, 'win32'), true, name);
  // copilot.ps1 is never run; a CLI double run through node is not the CLI.
  for (const name of ['C:\\npm\\copilot.ps1', 'copilot-models.mjs.cmd', 'node.exe']) assert.equal(namesCopilot(name, 'win32'), false, name);
});

test('VS Code\'s copilot shims are told by their content, the way VS Code tells them', () => {
  const dir = tmp();
  const file = (name, content) => { fs.writeFileSync(path.join(dir, name), content); return path.join(dir, name); };
  assert.equal(isVSCodeShim(nativeShim(dir)), true, 'the native shim of VS Code 1.143');
  assert.equal(isVSCodeShim(file('copilot.bat', legacyBat(dir))), true, 'the legacy batch wrapper');
  assert.equal(isVSCodeShim(file('copilot', legacyLauncher(dir))), true, 'the legacy POSIX launcher');
  assert.equal(isVSCodeShim(file('git-bash', gitBashWrapper)), true, 'the legacy Git Bash wrapper');
  assert.equal(isVSCodeShim(file('bom.bat', `\uFEFF${legacyBat(dir)}`)), true, 'with a byte order mark');
  // The real CLI and npm's shim are not; a folder or a missing file is not either.
  for (const [name, content] of [['npm.cmd', npmShim], ['real.exe', 'MZ the real CLI'], ['other.bat', '@echo off\r\necho copilot.ps1\r\n'], ['sh', '#!/bin/sh\nexec copilot "$@"\n']])
    assert.equal(isVSCodeShim(file(name, content)), false, name);
  assert.equal(isVSCodeShim(dir), false);
  assert.equal(isVSCodeShim(path.join(dir, 'missing.exe')), false);
  // A file larger than any shim build is never read (the real CLI is about 150 MB).
  const big = path.join(dir, 'big.exe');
  fs.writeFileSync(big, marker); fs.truncateSync(big, 17 * 1024 * 1024);
  assert.equal(isVSCodeShim(big), false);
  // A file that changes is read again.
  const changing = file('changing.exe', 'MZ the real CLI');
  assert.equal(isVSCodeShim(changing), false);
  fs.writeFileSync(changing, Buffer.concat([Buffer.from('MZ'), Buffer.from(marker), Buffer.alloc(10)]));
  assert.equal(isVSCodeShim(changing), true);
});

test('Windows passes over VS Code\'s copilot shims on PATH for the Copilot CLI after them', () => {
  const npm = npmGlobal(), native = tmp(), legacy = tmp();
  nativeShim(native);
  fs.writeFileSync(path.join(legacy, 'copilot.bat'), legacyBat(legacy));
  fs.writeFileSync(path.join(legacy, 'copilot.ps1'), '# Windows GitHub Copilot CLI bootstrapper\n$PackageName = "@github/copilot"\n');
  const real = { launch: { command: npm.exe, prefixArgs: [] }, file: npm.cmd, via: 'path' };
  assert.deepEqual(windowsLocate('copilot', win({ Path: `${legacy};${native};${npm.dir}` })), real);
  assert.deepEqual(windowsLaunch('copilot', win({ Path: `${native};${npm.dir}` })), real.launch);
  // A shim is still run when there is nothing else: it may find a CLI of its own.
  assert.deepEqual(windowsLocate('copilot', win({ Path: native })), { launch: { command: path.join(native, 'copilot.exe'), prefixArgs: [] }, file: path.join(native, 'copilot.exe'), via: 'shim' });
  assert.deepEqual(windowsLocate('copilot', win({ Path: legacy })).via, 'shim');
  // Other commands are not checked for shims, nor looked for anywhere new.
  assert.deepEqual(windowsLocate('npm', win({ Path: tmp() }, { remembered: () => npm.cmd })), { launch: { command: 'npm', prefixArgs: [] }, file: null, via: null });
});

test('Windows runs the Copilot CLI it remembered when PATH lost it, before npm\'s folder, the installers\' and a shim', () => {
  const npm = npmGlobal(), native = tmp(), empty = tmp();
  nativeShim(native);
  // PATH lost npm's folder; the shim VS Code put there remains.
  assert.deepEqual(windowsLocate('copilot', win({ Path: `${empty};${native}` }, { remembered: () => npm.cmd })), { launch: { command: npm.exe, prefixArgs: [] }, file: npm.cmd, via: 'remembered' });
  // A remembered place that is gone, or one that is a shim, is passed over.
  const local = tmp(), msi = path.join(local, 'GitHubCopilotCLI', 'copilot.exe');
  fs.mkdirSync(path.dirname(msi), { recursive: true }); fs.writeFileSync(msi, 'MZ the real CLI');
  for (const gone of [path.join(empty, 'gone', 'copilot.exe'), path.join(native, 'copilot.exe'), 'relative\\copilot.exe', path.join(npm.dir, 'node.exe')])
    assert.deepEqual(windowsLocate('copilot', win({ Path: native, LOCALAPPDATA: local }, { remembered: () => gone })), { launch: { command: msi, prefixArgs: [] }, file: msi, via: 'installer' }, gone);
  // The remembered place comes before npm's folder; npm's before the installers'.
  const appData = tmp(), roaming = npmGlobal(path.join(appData, 'npm'));
  assert.equal(windowsLocate('copilot', win({ Path: empty, APPDATA: appData, LOCALAPPDATA: local }, { remembered: () => npm.cmd })).via, 'remembered');
  assert.deepEqual(windowsLocate('copilot', win({ Path: empty, APPDATA: appData, LOCALAPPDATA: local })), { launch: { command: roaming.exe, prefixArgs: [] }, file: roaming.cmd, via: 'npm' });
  // WinGet's Links (its portable packages) is an installer's folder too.
  const links = tmp(), linked = path.join(links, 'Microsoft', 'WinGet', 'Links', 'copilot.exe');
  fs.mkdirSync(path.dirname(linked), { recursive: true }); fs.writeFileSync(linked, '');
  assert.equal(windowsLocate('copilot', win({ Path: empty, LOCALAPPDATA: links })).file, linked);
  assert.deepEqual(copilotInstallDirs({ LOCALAPPDATA: local }, 'win32'), [path.join(local, 'GitHubCopilotCLI'), path.join(local, 'Microsoft', 'WinGet', 'Links')]);
  assert.deepEqual(copilotInstallDirs({ LOCALAPPDATA: 'relative' }, 'win32'), []);
  // Nothing anywhere: the command is left for spawn to report, as before.
  assert.deepEqual(windowsLocate('copilot', win({ Path: empty })), { launch: { command: 'copilot', prefixArgs: [] }, file: null, via: null });
});

// A POSIX copilot: an executable script.
function executable(dir, body, name = 'copilot') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 }); fs.chmodSync(file, 0o755);
  return file;
}
test('elsewhere the bare copilot passes over a shim and falls back to the remembered place and ~/.local/bin', { skip: !posix }, () => {
  const bin = tmp(), shimDir = tmp(), home = tmp(), empty = tmp();
  const real = executable(bin, '#!/bin/sh\necho 1.0.108\n'), shim = executable(shimDir, legacyLauncher(shimDir));
  const none = { remembered: () => null };
  // PATH's own CLI is left to spawn, unless a shim comes before it.
  assert.deepEqual(posixLocate('copilot', { env: { PATH: bin }, ...none }), { launch: { command: 'copilot', prefixArgs: [] }, file: real, via: 'path' });
  assert.deepEqual(posixLocate('copilot', { env: { PATH: `${shimDir}:${bin}` }, ...none }), { launch: { command: real, prefixArgs: [] }, file: real, via: 'path' });
  assert.deepEqual(posixLocate('copilot', { env: { PATH: shimDir }, remembered: () => real }), { launch: { command: real, prefixArgs: [] }, file: real, via: 'remembered' });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const local = executable(path.join(home, '.local', 'bin'), '#!/bin/sh\n');
  assert.deepEqual(posixLocate('copilot', { env: { PATH: shimDir, HOME: home }, ...none }), { launch: { command: local, prefixArgs: [] }, file: local, via: 'installer' });
  assert.deepEqual(posixLocate('copilot', { env: { PATH: shimDir, HOME: empty }, ...none }), { launch: { command: shim, prefixArgs: [] }, file: shim, via: 'shim' });
  assert.deepEqual(posixLocate('copilot', { env: { PATH: empty, HOME: empty }, ...none }), { launch: { command: 'copilot', prefixArgs: [] }, file: null, via: null });
  // A remembered npm install runs its loader with this node: PATH may have lost node with it.
  const prefix = tmp(), loader = path.join(prefix, 'lib', 'node_modules', '@github', 'copilot', 'npm-loader.js');
  fs.mkdirSync(path.dirname(loader), { recursive: true }); fs.writeFileSync(loader, '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, 'bin')); fs.symlinkSync(loader, path.join(prefix, 'bin', 'copilot'));
  assert.deepEqual(posixLocate('copilot', { env: { PATH: empty, HOME: empty }, remembered: () => path.join(prefix, 'bin', 'copilot') }).launch, { command: process.execPath, prefixArgs: [fs.realpathSync(loader)] });
  // Not remembered: a file that cannot run, a relative path, another name; nor looked up for another command.
  for (const bad of [path.join(empty, 'copilot'), 'copilot', path.join(bin, 'other')]) assert.equal(posixLocate('copilot', { env: { PATH: empty, HOME: empty }, remembered: () => bad }).via, null, bad);
  assert.deepEqual(posixLocate('node', { env: { PATH: empty }, remembered: () => real }), { launch: { command: 'node', prefixArgs: [] }, file: null, via: null });
  assert.deepEqual(posixLocate(real, { env: { PATH: empty } }), { launch: { command: real, prefixArgs: [] }, file: real, via: 'given' });
  // No PATH at all: spawn searches its default folders, never the project.
  const project = tmp(); executable(project, '#!/bin/sh\n');
  assert.equal(posixLocate('copilot', { cwd: project, env: { HOME: empty }, ...none }).via, null);
});

test('a CLI is remembered when PATH, a given path, npm or an installer named it, never a shim or a file in the project', { skip: !posix }, () => {
  const recordFile = path.join(tmp(), 'copilot-cli.json'), bin = tmp(), project = tmp(), home = tmp();
  const real = executable(bin, '#!/bin/sh\n');
  const options = extra => ({ cwd: project, recordFile, version: '1.0.108', ...extra });
  // The lookup reads this file's own record too: none, here.
  fs.rmSync(copilotRecordFile(), { force: true });
  assert.deepEqual(rememberCopilot('copilot', options({ env: { PATH: bin, HOME: home } })), { recorded: true, file: recordFile, path: real, via: 'path' });
  assert.equal(readCopilotRecord(recordFile).version, '1.0.108');
  assert.equal(rememberCopilot(real, options({ env: { PATH: bin } })).unchanged, true);
  // Run through node and a script, it is not the CLI's own command.
  assert.deepEqual(rememberCopilot(process.execPath, options({ env: { PATH: bin } })), { recorded: false, reason: 'not the copilot command' });
  // Found at the place remembered: not written again; a shim: never written.
  const shimDir = tmp(); executable(shimDir, legacyLauncher(shimDir));
  fs.rmSync(recordFile);
  assert.deepEqual(rememberCopilot('copilot', options({ env: { PATH: shimDir, HOME: home } })), { recorded: false, reason: 'found as shim' });
  assert.equal(fs.existsSync(recordFile), false);
  // A copilot inside the project (an empty PATH entry, a relative path) is not a CLI for every project.
  executable(project, '#!/bin/sh\n');
  assert.deepEqual(rememberCopilot('copilot', options({ env: { PATH: `:${bin}` } })), { recorded: false, reason: 'inside the project' });
  assert.deepEqual(rememberCopilot('./copilot', options({ env: { PATH: bin } })), { recorded: false, reason: 'inside the project' });
  assert.equal(fs.existsSync(recordFile), false);
  // A record that cannot be written fails nothing: the error comes back.
  const blocked = path.join(tmp(), 'file');
  fs.writeFileSync(blocked, '');
  assert.match(rememberCopilot(real, options({ env: { PATH: bin }, recordFile: path.join(blocked, 'copilot-cli.json') })).error, /EEXIST|ENOTDIR|EACCES/);
});

test('the commands to run the CLI from a terminal quote each shell\'s way', () => {
  const user = 'C:\\Users\\Taro O\'Yamada\\AppData\\Roaming\\npm';
  const cmd = `${user}\\copilot.cmd`;
  // npm's extensionless shell shim beside copilot.cmd is what Git Bash runs.
  assert.deepEqual(terminalCommands(cmd, ['--version'], { platform: 'win32', exists: f => f === `${user}\\copilot` }),
    { powershell: `& 'C:\\Users\\Taro O''Yamada\\AppData\\Roaming\\npm\\copilot.cmd' '--version'`, bash: `'/c/Users/Taro O'\\''Yamada/AppData/Roaming/npm/copilot' --version` });
  assert.equal(terminalCommands(cmd, [], { platform: 'win32', exists: () => false }).bash, `'/c/Users/Taro O'\\''Yamada/AppData/Roaming/npm/copilot.cmd'`);
  assert.deepEqual(terminalCommands('/opt/my tools/copilot', ['login'], { platform: 'linux' }), { powershell: `& '/opt/my tools/copilot' 'login'`, bash: `'/opt/my tools/copilot' login` });
  // Curly quotes end a PowerShell string too.
  assert.equal(terminalCommands('C:\\O\u2019Brien\\copilot.exe', [], { platform: 'win32' }).powershell, `& 'C:\\O\u2019\u2019Brien\\copilot.exe'`);
});

test('comparison B\'s command names the CLI the kit runs when copilot is not on PATH', () => {
  const plain = stressBCommand({ model: 'm', dir: '/tmp/b', targetLanguage: 'Java', tools: ['view', 'edit'] });
  assert.match(plain.bash, /^cd \/tmp\/b && copilot -p /);
  assert.match(plain.powershell, /^Set-Location \/tmp\/b; & copilot -p /);
  const located = stressBCommand({ located: '/opt/my tools/copilot', model: 'm', dir: '/tmp/b', targetLanguage: 'Java', tools: ['view', 'edit'] });
  assert.match(located.bash, /^cd \/tmp\/b && '\/opt\/my tools\/copilot' -p /);
  assert.match(located.powershell, /^Set-Location \/tmp\/b; & '\/opt\/my tools\/copilot' -p /);
  assert.equal(located.bash.replace(/^cd \/tmp\/b && '\/opt\/my tools\/copilot'/, ''), plain.bash.replace(/^cd \/tmp\/b && copilot/, ''), 'the arguments are the same');
});

test('the guidance for a missing CLI looks for it first unless the kit already did, and signs in through the kit', () => {
  const ids = message => failureGuidance(message, { language: 'en' }).options.map(o => o.id);
  // A terminal's or a VS Code shim's own words: the kit has not looked yet.
  for (const message of ["copilot : The term 'copilot' is not recognized as the name of a cmdlet, function, script file, or operable program.",
    "'copilot' is not recognized as an internal or external command,\r\noperable program or batch file.", 'bash: copilot: command not found',
    'GitHub Copilot CLI was not found. Run copilot in a terminal to install it, or see https://gh.io/copilot-install',
    'Cannot find GitHub Copilot CLI (https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)']) {
    assert.equal(failureGuidance(message).id, 'copilot-missing', message);
    assert.deepEqual(ids(message), ['find-cli', 'install-cli', 'cli-path', 'pause'], message);
  }
  // The kit's own lookup failed: installing comes first, and looking again is not offered.
  for (const message of ['spawn copilot ENOENT', 'Cannot read the Copilot CLI version (exit 127): GitHub Copilot CLI was not found. Run copilot in a terminal to install it',
    'No Copilot CLI was found (spawn copilot ENOENT)'])
    assert.deepEqual(ids(message), ['install-cli', 'cli-path', 'pause'], message);
  const g = failureGuidance("The term 'copilot' is not recognized", { language: 'ja' });
  assert.equal(g.options[0].command, 'node migration-kit/scripts/run_migration.mjs cli');
  assert.match(g.cause, /PATH から外れただけ/);
  assert.equal(g.options.find(o => o.id === 'install-cli').command, 'npm install -g @github/copilot && node migration-kit/scripts/run_migration.mjs cli --login');
  assert.equal(g.options.find(o => o.id === 'cli-path').command, 'node migration-kit/scripts/run_migration.mjs cli --copilot /path/to/copilot');
  // Signing in goes through the kit, which finds the CLI when PATH lost it.
  for (const message of ['Copilot implementer failed (exit 1): To authenticate, you can use any of the following methods', 'Set an available model ID for models.implementer']) {
    const login = failureGuidance(message, { language: 'en' }).options.find(o => ['login', 'login-first'].includes(o.id));
    assert.equal(login.command, 'node migration-kit/scripts/run_migration.mjs cli --login', message);
  }
});

test('the skill and the orchestrator check the CLI through the kit, never with copilot in the agent\'s terminal', () => {
  for (const file of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8').replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /check `copilot --version`/, file);
    assert.match(text, /Check the CLI with `run_migration\.mjs cli` .* never by running `copilot` in your terminal/, file);
    assert.match(text, /never with a PATH change in front/, file);
    assert.match(text, /Only when `cli` reports that no Copilot CLI was found, .* run `npm install -g @github\/copilot`/, file);
    assert.match(text, /run `run_migration\.mjs cli --login` \(copilot login with the CLI the kit finds\) in a background terminal/, file);
    assert.match(text, /start copilot login first with `run_migration\.mjs cli --login`/, file);
  }
  for (const file of ['.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md']) {
    const text = fs.readFileSync(path.join(kitRoot, file), 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /Check the CLI with `run_migration\.mjs cli`, never by running `copilot` in your terminal/, file);
    assert.match(text, /only when `cli` finds none/, file);
  }
});

// The real thing through the runner: a CLI double named copilot, in a folder
// of its own, and a terminal whose PATH holds no copilot.
function fakeCopilot(dir) {
  const script = path.join(dir, 'fake-copilot.mjs');
  fs.writeFileSync(script, `const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('GitHub Copilot CLI 1.0.108.'); process.exit(0); }
if (args[0] === 'login') { console.log('To sign in, open https://github.com/login/device and enter ABCD-1234'); process.exit(Number(process.env.FAKE_LOGIN_EXIT ?? 0)); }
process.exit(2);
`);
  if (!posix) { fs.writeFileSync(path.join(dir, 'copilot.cmd'), `@"${process.execPath}" "${script}" %*\r\n`); return path.join(dir, 'copilot.cmd'); }
  return executable(dir, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script.replace(/'/g, `'\\''`)}' "$@"\n`);
}
// No PATH entry, npm folder or installer folder of this machine reaches the child.
function terminal(home, { bin = tmp(), extra = {} } = {}) {
  const kept = Object.entries(process.env).filter(([k]) => !/^(path|home|userprofile|appdata|localappdata|npm_config_prefix|npm_config_userconfig|copilot_home)$/i.test(k));
  const homes = { HOME: tmp(), USERPROFILE: tmp(), APPDATA: tmp(), LOCALAPPDATA: tmp() };
  return { ...Object.fromEntries(kept), ...homes, [posix ? 'PATH' : 'Path']: bin, COPILOT_HOME: home, ...extra };
}
function runner(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(kitRoot, 'scripts', 'run_migration.mjs'), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { return null; } })() }));
  });
}

test('run_migration.mjs cli works before initialization, remembers the CLI it was given, and finds it again after PATH lost it', async () => {
  const home = tmp(), cliDir = tmp(), project = tmp(), fake = fakeCopilot(cliDir), env = terminal(home);
  const given = await runner(['cli', '--copilot', fake], { cwd: project, env });
  assert.equal(given.code, 0, given.stderr);
  assert.equal(fs.existsSync(path.join(project, 'migration')), false, 'nothing is initialized');
  const record = path.join(`${home}-migration-kit`, 'copilot-cli.json');
  assert.deepEqual({ ok: given.json.ok, version: given.json.version, path: given.json.path, foundIn: given.json.foundIn, record: given.json.record },
    { ok: true, version: '1.0.108', path: fake, foundIn: cliPlaces.given, record: { file: record, path: fake, updated: true } });
  assert.match(given.json.next, /The kit remembered it, so its commands find it when copilot is not on PATH: run them as they are, without --copilot/);
  assert.equal(readCopilotRecord(record).path, fake);
  // The terminal's PATH has no copilot: the kit runs the one it remembered.
  const bare = await runner(['cli'], { cwd: project, env });
  assert.equal(bare.code, 0, bare.stderr);
  assert.equal(bare.json.foundIn, cliPlaces.remembered);
  assert.equal(bare.json.onPath, false);
  assert.equal(bare.json.record.updated, undefined, 'the same place is not written again');
  assert.match(bare.json.next, /Do not install it\. Run the kit's commands as they are, each on its own: the kit finds the CLI itself, so never put a PATH change in front of them/);
  assert.match(bare.json.next, /run_migration\.mjs cli --login/);
  assert.equal(bare.json.run.powershell, terminalCommands(fake).powershell);
  // copilot login runs with that CLI, in this terminal.
  const login = await runner(['cli', '--login'], { cwd: project, env });
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stdout, /^To sign in, open https:\/\/github\.com\/login\/device and enter ABCD-1234/);
  assert.equal(login.json.login.exitCode, 0);
  assert.equal(login.json.ok, true);
  const refused = await runner(['cli', '--login'], { cwd: project, env: { ...env, FAKE_LOGIN_EXIT: '3' } });
  assert.equal(refused.code, 1);
  assert.equal(refused.json.login.exitCode, 3);
  assert.match(refused.json.login.next, /copilot login exited 3: show the person what it printed/);
  // Forgotten (the file deleted) and nowhere else: exit 1, and the guidance installs first.
  fs.rmSync(record);
  const missing = await runner(['cli', '--login'], { cwd: project, env });
  assert.equal(missing.code, 1);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.login, undefined, 'no sign-in without a CLI');
  assert.deepEqual(missing.json.searched.map(s => s.place), posix ? ['PATH', 'remembered', 'installer'] : ['PATH', 'remembered', 'npm', 'installer']);
  assert.match(missing.json.next, /No Copilot CLI was found: the kit looked on PATH, at the place it remembered.* Install only after a yes/);
  assert.match(missing.stderr, /1\. \*\*Let the AI install the Copilot CLI and start sign-in\*\* \(recommended\)/);
  assert.doesNotMatch(missing.stderr, /look for the installed Copilot CLI/);
});

test('run_migration.mjs cli runs the remembered CLI before VS Code\'s shim on PATH, and reports a shim alone as no CLI', { skip: !posix }, async () => {
  const home = tmp(), cliDir = tmp(), project = tmp(), shimDir = tmp(), fake = fakeCopilot(cliDir);
  // The legacy POSIX launcher's words, answering as the native shim does without a terminal.
  executable(shimDir, `#!/bin/sh\nunset NODE_OPTIONS\n# ELECTRON_RUN_AS_NODE=1 copilotCLIShim.js "$@"\necho 'GitHub Copilot CLI was not found. Run copilot in a terminal to install it, or see https://gh.io/copilot-install' >&2\nexit 127\n`);
  const env = terminal(home, { bin: shimDir });
  const alone = await runner(['cli'], { cwd: project, env });
  assert.equal(alone.code, 1);
  assert.equal(alone.json.foundIn, cliPlaces.shim);
  assert.match(alone.json.next, /only VS Code's copilot shim/);
  assert.match(alone.stderr, /Let the AI install the Copilot CLI and start sign-in\*\* \(recommended\)/);
  assert.equal(fs.existsSync(path.join(`${home}-migration-kit`, 'copilot-cli.json')), false, 'a shim is never remembered');
  writeCopilotRecord(fake, { via: 'path', recordFile: path.join(`${home}-migration-kit`, 'copilot-cli.json') });
  const remembered = await runner(['cli'], { cwd: project, env });
  assert.equal(remembered.code, 0, remembered.stderr);
  assert.equal(remembered.json.path, fake);
  assert.equal(remembered.json.foundIn, cliPlaces.remembered);
});

test('doctor says where it found the CLI and remembers one outside the project', async t => {
  const f = prepare(t), cliDir = tmp(), fake = fakeCopilot(cliDir), record = copilotRecordFile();
  fs.rmSync(record, { force: true });
  const report = await doctor(f.root, f.config, { checkCLI: true, command: fake, probeTimeoutMs: 20000 });
  const check = report.checks.find(c => c.check === 'Copilot executable');
  assert.equal(check.ok, true);
  assert.equal(check.path, fake);
  assert.equal(check.foundIn, cliPlaces.given);
  assert.equal(check.note, undefined, 'a path given is not news');
  assert.equal(readCopilotRecord(record).path, fake);
  // A CLI double inside the project is not remembered.
  fs.rmSync(record);
  const tools = path.join(f.root, 'tools');
  fs.mkdirSync(tools);
  const inside = fakeCopilot(tools);
  await doctor(f.root, f.config, { checkCLI: true, command: inside, probeTimeoutMs: 20000 });
  assert.equal(fs.existsSync(record), false);
});

test('the places searched are listed for a CLI not found', () => {
  const recordFile = path.join(tmp(), 'copilot-cli.json');
  assert.deepEqual(copilotSearchPlaces({ env: { HOME: '/home/u' }, platform: 'linux', recordFile }), [{ place: 'PATH' }, { place: 'remembered', record: recordFile, path: null }, { place: 'installer', folders: [path.join('/home/u', '.local', 'bin')] }]);
  const appData = tmp(), local = tmp();
  const places = copilotSearchPlaces({ env: { APPDATA: appData, LOCALAPPDATA: local }, platform: 'win32', recordFile, read: () => '' });
  assert.deepEqual(places.map(p => p.place), ['PATH', 'remembered', 'npm', 'installer']);
  assert.deepEqual(places[2].folders, [path.join(appData, 'npm')]);
});
