// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// On Windows, `npm install -g @github/copilot` puts a copilot.cmd shim on PATH.
// Node starts only real executables without a shell (a bare name gives ENOENT,
// an explicit .cmd gives EINVAL), and the kit never uses a shell. So a command
// that names the npm shim runs the platform binary npm installed beside it, or
// node with the package's loader. Anything else is returned unchanged.
// Lookup uses the child's PATH and cwd, as spawn would, and returns absolute
// paths so the child's cwd cannot change what runs.
// A bare name that PATH does not resolve (an IDE or agent terminal started
// before npm's folder was added, a quoted PATH entry) is then looked up in npm's
// global prefix: npm_config_prefix, the user .npmrc prefix, or %APPDATA%\npm.
// Unverified on a real Windows machine; the layout follows npm 1.0.101 manifests.
export function windowsLaunch(command, { cwd, platform = process.platform, arch = process.arch, env = process.env, exists = fs.existsSync, read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } } } = {}) {
  if (platform !== 'win32' || typeof command !== 'string') return { command, prefixArgs: [] };
  const ext = path.extname(command).toLowerCase();
  if (ext === '.exe') return { command, prefixArgs: [] };
  const base = ['.cmd', '.ps1', '.bat'].includes(ext) ? command.slice(0, -ext.length) : command;
  const dirs = (/[\\/]/.test(base) ? [path.dirname(base)] : [...envValue(env, 'PATH').split(';'), ...npmPrefixDirs(env, read)])
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    .map(dir => path.resolve(cwd ?? process.cwd(), dir));
  const name = path.basename(base);
  for (const dir of dirs) {
    if (!ext && exists(path.join(dir, `${name}.exe`))) return { command: path.join(dir, `${name}.exe`), prefixArgs: [] };
    // Only a shim that npm wrote for @github/copilot; other shims run unchanged.
    if (!['.cmd', '.ps1'].some(e => /@github[\\/]copilot[\\/]npm-loader\.js/.test(read(path.join(dir, `${name}${e}`))))) continue;
    const pkg = path.join(dir, 'node_modules', '@github', 'copilot');
    const loader = path.join(pkg, 'npm-loader.js');
    if (!exists(loader)) continue;
    const native = path.join('@github', `copilot-win32-${arch}`, 'copilot.exe');
    for (const modules of [path.join(pkg, 'node_modules'), path.join(dir, 'node_modules')]) {
      if (exists(path.join(modules, native))) return { command: path.join(modules, native), prefixArgs: [] };
    }
    return { command: process.execPath, prefixArgs: [loader] };
  }
  return { command, prefixArgs: [] };
}

function envValue(env, name) {
  const key = Object.keys(env).find(k => k.toUpperCase() === name);
  return key === undefined ? '' : env[key] ?? '';
}

// Where `npm install -g` puts its shims on Windows: the prefix itself.
function npmPrefixDirs(env, read) {
  const home = envValue(env, 'USERPROFILE'), appData = envValue(env, 'APPDATA');
  const userConfig = envValue(env, 'NPM_CONFIG_USERCONFIG') || (home && path.join(home, '.npmrc'));
  const raw = userConfig ? read(userConfig).match(/^\s*prefix\s*=\s*(.+?)\s*$/m)?.[1] : undefined;
  // npm expands ${VAR} (and ${VAR?}) in .npmrc values and a leading ~ in path settings.
  const fromRc = raw?.replace(/^"(.*)"$/, '$1').replace(/\$\{([^}?]+)\??\}/g, (all, name) => envValue(env, name.toUpperCase()) || all)
    .replace(/^~(?=$|[\\/])/, () => home || '~');
  return [envValue(env, 'NPM_CONFIG_PREFIX'), fromRc, appData && path.join(appData, 'npm')].filter(Boolean);
}

export function runProcess(command, args, { cwd, env = process.env, input, timeoutMs = 600000, signal, maxBytes = 16 * 1024 * 1024 } = {}) {
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    let child, failure, timeout, killTimer, closed = false, terminated = true, settled = false;
    let code = null, exitSignal = null, bytes = 0;
    const stdout = [], stderr = [];
    const finish = () => {
      if (settled || !closed || !terminated) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      const result = { command: [command, ...args], code, signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
        startedAt, finishedAt: new Date().toISOString(), ...(failure ? { error: failure.message } : {}) };
      if (failure) { failure.result = result; reject(failure); } else resolve(result);
    };
    const fail = error => {
      if (failure || settled) return;
      failure = error; clearTimeout(timeout);
      if (!child?.pid) { closed = true; finish(); return; }
      terminated = false;
      if (process.platform === 'win32') {
        // Kill the tree before its parent can exit and orphan its descendants.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', e => { failure.message += `; taskkill failed: ${e.message}`; child.kill(); terminated = true; finish(); });
        killer.once('close', status => {
          if (status !== 0) { failure.message += `; taskkill exit ${status} (tree termination unconfirmed)`; child.kill(); }
          terminated = true; finish();
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        // Direct-child close must not cancel this escalation or release the
        // caller's lock while a grandchild can still be running.
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') failure.message += `; group kill failed: ${e.message}`; }
          terminated = true; finish();
        }, 1500);
      }
    };
    const abort = () => fail(new Error('Interrupted'));
    if (signal?.aborted) { closed = true; failure = new Error('Interrupted'); finish(); return; }
    const launch = windowsLaunch(command, { cwd, env });
    try { child = spawn(launch.command, [...launch.prefixArgs, ...args], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (e) { closed = true; failure = e; finish(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => fail(new Error(`Process timed out after ${timeoutMs}ms`)), timeoutMs);
    const collect = chunks => data => {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining) chunks.push(data.subarray(0, remaining));
      bytes += data.length;
      if (bytes > maxBytes) fail(new Error('Process output exceeded limit'));
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('error', e => { failure ??= e; closed = true; finish(); });
    child.once('close', (status, sig) => { code = status; exitSignal = sig; closed = true; finish(); });
    if (input !== undefined) {
      child.stdin.on('error', e => { if (e.code !== 'EPIPE') fail(e); });
      child.stdin.end(input);
    }
    if (signal?.aborted) abort();
  });
}
