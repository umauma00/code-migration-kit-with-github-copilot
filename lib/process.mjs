// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';

// On Windows, `npm install -g @github/copilot` puts a copilot.cmd shim on PATH.
// Node starts only real executables without a shell (a bare name gives ENOENT,
// an explicit .cmd gives EINVAL), and the kit never uses a shell. So a command
// that names the npm shim runs the platform binary npm installed beside it, or
// node with the package's loader. Another .cmd/.bat (npm, npx, mvn, gradlew.bat)
// runs through cmd.exe with escaped arguments (batch); anything else is unchanged.
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
  // A batch file named with its extension (gradlew.bat, build.cmd) is found in
  // the child's cwd first, as cmd.exe does. A bare name (npm, gradlew) is not, so
  // a file in the migration repository cannot stand in for a tool on PATH.
  const local = ext === '.cmd' || ext === '.bat' ? ['.'] : [];
  const dirs = (/[\\/]/.test(base) ? [path.dirname(base)] : [...local, ...envValue(env, 'PATH').split(';'), ...npmPrefixDirs(env, read)])
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    .map(dir => path.resolve(cwd ?? process.cwd(), dir));
  const name = path.basename(base);
  for (const dir of dirs) {
    if (!ext && exists(path.join(dir, `${name}.exe`))) return { command: path.join(dir, `${name}.exe`), prefixArgs: [] };
    // A shim that npm wrote for @github/copilot runs its binary or loader directly.
    const pkg = path.join(dir, 'node_modules', '@github', 'copilot'), loader = path.join(pkg, 'npm-loader.js');
    if (['.cmd', '.ps1'].some(e => /@github[\\/]copilot[\\/]npm-loader\.js/.test(read(path.join(dir, `${name}${e}`)))) && exists(loader)) {
      const native = path.join('@github', `copilot-win32-${arch}`, 'copilot.exe');
      for (const modules of [path.join(pkg, 'node_modules'), path.join(dir, 'node_modules')]) {
        if (exists(path.join(modules, native))) return { command: path.join(modules, native), prefixArgs: [] };
      }
      return { command: process.execPath, prefixArgs: [loader] };
    }
    // Any other batch file (npm.cmd, npx.cmd, mvn.cmd, gradlew.bat...) can only
    // run through cmd.exe; batchCommandLine quotes its arguments.
    for (const e of ext === '.cmd' || ext === '.bat' ? [ext] : ext ? [] : ['.cmd', '.bat']) {
      const file = path.join(dir, `${name}${e}`);
      if (exists(file)) return { command: envValue(env, 'ComSpec') || 'cmd.exe', prefixArgs: [], batch: file };
    }
  }
  return { command, prefixArgs: [] };
}

// cmd.exe parses its command line, and a batch file that forwards %* or %1
// (npm.cmd, npx.cmd, node_modules/.bin shims, mvn.cmd, gradlew.bat) parses the
// arguments a second time. So every argument is quoted and its metacharacters
// escaped with ^ twice, as cross-spawn does for npm shims; one pass would let a
// quote inside an argument expose a later | or & to the batch file's parse.
const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;
function cmdArgument(arg) {
  const value = `${arg}`.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  return `"${value}"`.replace(cmdMeta, '^$1').replace(cmdMeta, '^$1');
}
export function batchCommandLine(file, args) {
  return ['/d', '/s', '/c', `"${[file.replace(cmdMeta, '^$1'), ...args.map(cmdArgument)].join(' ')}"`];
}

function envValue(env, name) {
  return envLookup(env, name) ?? '';
}

// Windows environment names are case-insensitive; undefined means not set.
function envLookup(env, name) {
  const key = Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// A value as npm's ini reader (ini 7) returns it: quoted values are taken whole
// (JSON-unescaped), otherwise the first unescaped ; or # starts a comment.
function iniValue(text) {
  const val = text.trim();
  if (val.length > 1 && (val[0] === '"' || val[0] === "'") && val.endsWith(val[0])) {
    const inner = val[0] === "'" ? val.slice(1, -1) : val;
    try { return JSON.parse(inner); } catch { return inner; }
  }
  let out = '', esc = false;
  for (const c of val) {
    if (esc) { out += '\\;#'.includes(c) ? c : `\\${c}`; esc = false; }
    else if (c === ';' || c === '#') break;
    else if (c === '\\') esc = true;
    else out += c;
  }
  return (esc ? `${out}\\` : out).trim();
}

// The top-level prefix of a user .npmrc, read like npm: the last line wins,
// ${VAR} expands (left as is when unset), ${VAR?} expands to '' when unset,
// \${VAR} stays literal, and ~\ or ~/ starts at the user profile.
function npmrcPrefix(text, env, home) {
  let section = null, value;
  for (const line of text.split(/[\r\n]+/)) {
    if (!line || /^\s*[;#]/.test(line) || /^\s*$/.test(line)) continue;
    const m = line.match(/^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/);
    if (!m) continue;
    if (m[1] !== undefined) { section = iniValue(m[1]); continue; }
    if (section === null && iniValue(m[2]) === 'prefix' && m[3]) value = iniValue(m[4]);
  }
  if (typeof value !== 'string') return undefined;
  const expanded = value.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (orig, esc, name, optional) => {
    if (esc.length % 2) return orig.slice((esc.length + 1) / 2);
    return esc.slice(esc.length / 2) + (envLookup(env, name) ?? (optional ? '' : `\${${name}}`));
  });
  return /^~[\\/]/.test(expanded) && home ? path.join(home, expanded.slice(2)) : expanded;
}

// Where `npm install -g` puts its shims on Windows: the prefix itself.
function npmPrefixDirs(env, read) {
  const home = envValue(env, 'USERPROFILE'), appData = envValue(env, 'APPDATA');
  const userConfig = envValue(env, 'NPM_CONFIG_USERCONFIG') || (home && path.join(home, '.npmrc'));
  const fromRc = userConfig ? npmrcPrefix(read(userConfig), env, home) : undefined;
  // Only absolute prefixes: a relative one would resolve against the migration target.
  return [envValue(env, 'NPM_CONFIG_PREFIX'), fromRc, appData && path.join(appData, 'npm')].filter(dir => dir && path.isAbsolute(dir));
}

// maxBytes is a memory threshold, never a reason to terminate a child. Full
// output spills to private files; the result retains bounded tails for display.
// timeoutMs is opt-in. In particular, zero must not schedule a 1 ms timer.
export function runProcess(command, args, { cwd, env = process.env, input, timeoutMs = 0, signal, maxBytes = 16 * 1024 * 1024, outputDir } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid process timeout or output memory threshold');
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    let child, failure, timeout, killTimer, closed = false, terminated = true, settled = false;
    let code = null, exitSignal = null, bytes = 0;
    const streams = Object.fromEntries(['stdout', 'stderr'].map(name => [name, { chunks: [], bytes: 0, total: 0, hasher: createHash('sha256') }]));
    let spooled = false, outputFailed = false;
    const writeAll = (fd, data) => { for (let at = 0; at < data.length;) at += fs.writeSync(fd, data, at, data.length - at); };
    const spill = () => {
      const parent = outputDir ?? os.tmpdir();
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const dir = fs.mkdtempSync(path.join(parent, 'migration-process-'));
      for (const [name, stream] of Object.entries(streams)) {
        stream.file = path.join(dir, `${name}.log`);
        stream.fd = fs.openSync(stream.file, 'wx', 0o600);
        for (const chunk of stream.chunks) writeAll(stream.fd, chunk);
      }
      spooled = true;
    };
    const retainTail = stream => {
      const limit = Math.max(1, Math.floor(maxBytes / 2));
      while (stream.bytes > limit && stream.chunks.length) {
        const first = stream.chunks[0], drop = Math.min(stream.bytes - limit, first.length);
        if (drop === first.length) stream.chunks.shift();
        else stream.chunks[0] = Buffer.from(first.subarray(drop));
        stream.bytes -= drop;
      }
    };
    const finish = () => {
      if (settled || !closed || !terminated) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      for (const stream of Object.values(streams)) if (stream.fd !== undefined) { try { fs.closeSync(stream.fd); } catch (e) { failure ??= e; } }
      // A process the runner killed has no exit status of its own (taskkill /F
      // leaves exit code 1 on Windows, which would read as an ordinary failure).
      const result = { command: [command, ...args], code: failure && child?.pid ? null : code, signal: exitSignal,
        stdout: Buffer.concat(streams.stdout.chunks).toString('utf8'), stderr: Buffer.concat(streams.stderr.chunks).toString('utf8'),
        ...(spooled ? { outputSpooled: true, stdoutFile: streams.stdout.file, stderrFile: streams.stderr.file,
          stdoutBytes: streams.stdout.total, stderrBytes: streams.stderr.total,
          stdoutHash: streams.stdout.hasher.digest('hex'), stderrHash: streams.stderr.hasher.digest('hex') } : {}),
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
    const argv = launch.batch ? batchCommandLine(launch.batch, args) : [...launch.prefixArgs, ...args];
    try { child = spawn(launch.command, argv, { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: Boolean(launch.batch), detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (e) { closed = true; failure = e; finish(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs > 0) timeout = setTimeout(() => fail(new Error(`Process timed out after ${timeoutMs}ms (explicit bounded deadline)`)), timeoutMs);
    const collect = name => data => {
      if (outputFailed) return;
      try {
        if (!spooled && bytes + data.length > maxBytes) spill();
        const stream = streams[name];
        if (spooled) writeAll(stream.fd, data);
        stream.hasher.update(data);
        bytes += data.length; stream.total += data.length;
        stream.chunks.push(data); stream.bytes += data.length;
        if (spooled) for (const s of Object.values(streams)) retainTail(s);
      } catch (e) {
        outputFailed = true;
        if (failure) failure.message += `; Cannot preserve process output: ${e.message}`;
        else fail(new Error(`Cannot preserve process output: ${e.message}`, { cause: e }));
      }
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', e => { failure ??= e; closed = true; finish(); });
    child.once('close', (status, sig) => { code = status; exitSignal = sig; closed = true; finish(); });
    if (input !== undefined) {
      child.stdin.on('error', e => { if (e.code !== 'EPIPE') fail(e); });
      child.stdin.end(input);
    }
    if (signal?.aborted) abort();
  });
}

// Read the full output, including spilled logs, without materializing the log
// as one giant string. Receipts read from disk may reference only runner logs.
export function* processOutputLines(result, name = 'stdout', root) {
  const file = result[`${name}File`];
  if (!file) { yield* String(result[name] ?? '').split(/\r?\n/); return; }
  if (root) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (!relative.startsWith('migration/runs/process-output/') || relative.split('/').includes('..')) throw new Error('Process output file outside runner log directory');
    for (let at = path.resolve(root, 'migration/runs/process-output'); at !== path.resolve(file);) {
      if (fs.lstatSync(at).isSymbolicLink()) throw new Error('Symlink in process output path');
      const next = path.relative(at, file).split(path.sep)[0];
      at = path.join(at, next);
    }
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlink in process output path');
  }
  const fd = fs.openSync(file, 'r'), decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(65536), hasher = createHash('sha256');
  let pending = '';
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hasher.update(buffer.subarray(0, count));
      pending += decoder.write(buffer.subarray(0, count));
      let end;
      while ((end = pending.indexOf('\n')) !== -1) { yield pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1); }
    }
    pending += decoder.end();
    if (pending) yield pending;
    const expected = result[`${name}Hash`];
    if ((root && typeof expected !== 'string') || (expected && hasher.digest('hex') !== expected)) throw new Error('Process output log changed or has no recorded hash; refusing altered diagnostic evidence');
  } finally { fs.closeSync(fd); }
}
