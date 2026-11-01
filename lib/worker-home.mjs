// SPDX-License-Identifier: Apache-2.0
// The Copilot CLI home that worker calls run with.
//
// Every CLI process writes its conversation into the home's session-state and
// indexes it in one SQLite file (session-store.db) shared by every CLI process
// that uses that home. A migration starts thousands of worker sessions, and
// on 2026-10-31 a person's shared home held 2,959 sessions and a 192 MB index;
// its log said "Session store tracking backlog limit reached; live indexing
// paused" while workers failed with "session host did not complete the ...
// event within 120s". So by default workers run in a home of their own, next
// to the person's (".copilot" -> ".copilot-migration-kit-workers"), which
// holds only the kit's sessions. The CLI finds its session-state, index and
// logs only through COPILOT_HOME (checked on 1.0.105), so nothing else moves.
//
// The worker home carries the person's sign-in and settings, not their
// records or the CLI's own state: two settings files (config.json, which the
// CLI manages and which names the signed-in account and the trusted folders,
// and settings.json) are copied when they changed, once per process, and the
// folders the CLI loads plugins, agents, skills, hooks and extensions from are
// linked (a junction on Windows). Nothing else is brought over. On 2026-11-01
// (CLI 1.0.105, Windows) the 0.34.0 worker home, which copied every top-level
// file, held a copy of the CLI's MCP ownership storage (mcp-installations.json
// and a "-writer.binding" file bound to the person's home); every worker then
// failed while starting its MCP servers, before the prompt. Workers need no
// MCP server of the person's (mcp-config.json stays behind): every worker runs
// with --available-tools limited to the kit's own tools, so no MCP tool reaches
// one. The CLI builds its own storage in the worker home. A worker home made before that is emptied once, records
// excepted (see workerHomeLayout). The person's session-state, index, logs,
// command history, caches and downloaded builds stay where they are. Sign-in
// tokens live in the system credential store, keyed by account, not by home.
// A CLI that still says it is not signed in there, or that cannot start its
// MCP servers or protected storage there, makes the adapter repeat the call
// in the person's home, and stay there for the rest of that command once that
// works (see copilot_adapter.mjs). workerCopilotHome: "shared" in
// migration/config.json keeps every worker in the person's home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const workerHomeModes = ['separate', 'shared'];
// The person's CLI home, as the CLI resolves it. Workers run with the project
// as cwd, so a relative COPILOT_HOME is the project's.
export const userCopilotHome = (root, env = process.env) => path.resolve(root ?? process.cwd(), env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
const within = (dir, parent) => { const rel = path.relative(parent, dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
// Where the worker home is, whatever the setting: next to the person's home,
// or in the user profile when that home is inside the project (a relative
// COPILOT_HOME), so copied settings and transcripts never land in the project.
export function workerHomePath(root, env = process.env) {
  const user = userCopilotHome(root, env);
  if (!within(user, path.resolve(root ?? process.cwd()))) return `${user}-migration-kit-workers`;
  const tag = crypto.createHash('sha256').update(process.platform === 'win32' ? user.toLowerCase() : user).digest('hex').slice(0, 12);
  return path.join(os.homedir(), `.copilot-migration-kit-workers-${tag}`);
}
// null when workers share the person's home.
export function workerCopilotHome(root, config, env = process.env) {
  if ((config?.workerCopilotHome ?? 'separate') === 'shared') return null;
  return workerHomePath(root, env);
}
// The only files and folders taken from the person's home. Anything else
// there is the CLI's own state (MCP ownership and activation records, writer
// bindings and leases, protected storage, permissions, caches) or the
// person's MCP servers, and is tied to that home or not wanted by workers.
export const workerSettingFiles = ['config.json', 'settings.json'];
export const workerLinkedFolders = ['installed-plugins', 'marketplaces', 'agents', 'skills', 'hooks', 'extensions'];
const sameName = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const listed = (list, name) => list.some(entry => sameName(entry, name));
// What stays when an older worker home is emptied: the workers' session
// records and index (sessions status and prune read them), logs and the CLI's
// downloaded builds. Everything else goes, locks included, so no lock is left
// without the binding written beside it.
const keptName = name => /^(?:session-state|session-store\.db(?:-wal|-shm|-journal)?|logs|pkg)$/i.test(name);
// The worker home's layout. A home without this marker (0.34.0 to 0.40.x)
// may hold copies of the person's CLI state and is emptied once.
export const workerHomeMarker = '.migration-kit-worker-home.json';
export const workerHomeLayout = 2;
// The workers' own index is rebuilt from scratch past this size: it only
// indexes kit sessions, and an index that large is what this home avoids.
export const workerIndexLimitBytes = 64 * 1024 * 1024;
// An index no CLI wrote to for this long is not in use by another kit process.
export const workerIndexIdleMs = 15 * 60 * 1000;

// Writes a settings file only when it differs, through a temporary file and a
// rename, so a CLI starting in parallel never reads a half-written file.
function copySetting(from, to, mode) {
  const data = fs.readFileSync(from);
  try { if (fs.readFileSync(to).equals(data)) return; } catch {}
  const temp = `${to}.${process.pid}.${Date.now()}.tmp`;
  // The person's own permissions (a helper script stays executable), never wider than theirs.
  try { fs.writeFileSync(temp, data, { mode: 0o600 }); fs.chmodSync(temp, mode & 0o700); fs.renameSync(temp, to); }
  finally { try { fs.rmSync(temp, { force: true }); } catch {} }
}
function linkFolder(from, to) {
  let current = null; try { current = fs.lstatSync(to); } catch {}
  if (current?.isSymbolicLink()) {
    let target = null; try { target = fs.realpathSync(to); } catch {}
    if (target && sameName(target, fs.realpathSync(from))) return;
    fs.rmSync(to, { force: true });
  } else if (current?.isDirectory()) {
    // A folder the CLI created here before the person had one: replaced by
    // the link only while it is empty, never with something in it.
    if (fs.readdirSync(to).length) return;
    fs.rmdirSync(to);
  } else if (current) return;
  fs.symlinkSync(fs.realpathSync(from), to, process.platform === 'win32' ? 'junction' : 'dir');
}

const prepared = new Map();
// Creates or refreshes the worker home once per process and returns its path
// (null for "shared").
export function prepareWorkerHome(root, config, { env = process.env, upgradeWaitMs } = {}) {
  const home = workerCopilotHome(root, config, env);
  if (!home) return null;
  const user = userCopilotHome(root, env);
  const key = `${user}\0${home}`;
  if (prepared.has(key)) return prepared.get(key);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Never a link (someone pointing it at ~/.copilot as a workaround), never
  // the person's home: emptying it below would reach their files.
  if (fs.lstatSync(home).isSymbolicLink()) throw new Error(`The kit's worker home ${home} is a link; remove it or set workerCopilotHome to shared`);
  let userReal = null; try { userReal = fs.realpathSync(user); } catch {}
  if (userReal && sameName(fs.realpathSync(home), userReal)) throw new Error('The kit\'s worker home must not be the person\'s Copilot CLI home');
  // Still being emptied by another kit process, or holding the person's CLI
  // state it could not remove: an error, so the adapter uses the person's home
  // for the rest of this command with a warning, and the next command tries
  // again.
  const pending = upgradeLayout(home, { waitMs: upgradeWaitMs });
  if (pending) throw new Error(pending);
  let names = [], read = false;
  try { names = fs.readdirSync(user); read = true; } catch {}
  for (const name of names) {
    const file = listed(workerSettingFiles, name), folder = listed(workerLinkedFolders, name);
    if (!file && !folder) continue;
    const from = path.join(user, name), to = path.join(home, name);
    try {
      // Follows links: dotfile managers keep settings as symbolic links.
      const stat = fs.statSync(from);
      if (file && stat.isFile()) copySetting(from, to, stat.mode);
      else if (folder && stat.isDirectory()) linkFolder(from, to);
    } catch {}
  }
  // A link the person's home no longer has a folder for, or one this home
  // does not take, is removed (the link only, never what it points to); files
  // stay (the CLI writes its own there).
  // An unreadable person's home is not an empty one: keep every link then.
  if (read) for (const name of fs.readdirSync(home)) {
    const to = path.join(home, name);
    try { if (fs.lstatSync(to).isSymbolicLink() && !(listed(workerLinkedFolders, name) && names.some(n => sameName(n, name)))) fs.rmSync(to, { force: true }); } catch {}
  }
  resetLargeIndex(home);
  prepared.set(key, home);
  return home;
}
// Empties a worker home made by an earlier layout, session records excepted:
// links are removed as links, never followed; files and folders there were
// copied from the person's home or written by worker CLIs against those
// copies, and the CLI makes what it needs again.
// One kit process does it at a time (an exclusive folder naming its owner);
// another one waits for it to finish. A lock whose owner process has ended, or
// that nobody touched for a while, is taken over by an atomic rename so only
// one process wins. The marker is written once nothing tied to the person's
// home is left (MCP records, bindings, leases, protected storage); something
// else Windows kept open is only warned about, so a home is not emptied on
// every start. Returns null when the home is current, or why it is not.
// How long a lock nobody touches stays another process's, and how long a
// process waits for it (tests shorten the wait).
export const workerHomeUpgradeLockMs = 10 * 60 * 1000;
export const workerHomeUpgrade = { waitMs: 30 * 1000 };
const homeStateName = name => /mcp|binding|writer|lease|protected|transaction/i.test(name);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function upgradeLayout(home, { waitMs } = {}) {
  waitMs ??= workerHomeUpgrade.waitMs;
  const marker = path.join(home, workerHomeMarker), lock = path.join(home, '.migration-kit-upgrading'), ownerFile = path.join(lock, 'owner.json');
  const current = () => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')).layout >= workerHomeLayout; } catch { return false; } };
  const token = `${process.pid}-${crypto.randomUUID()}`;
  for (const until = Date.now() + waitMs; ;) {
    if (current()) return null;
    try {
      let owner = null; try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
      const idle = Date.now() - fs.statSync(lock).mtimeMs > workerHomeUpgradeLockMs;
      if (idle || (Number.isInteger(owner?.pid) && owner.pid !== process.pid && !alive(owner.pid))) {
        const stale = `${lock}.stale-${token}`;
        fs.renameSync(lock, stale);
        fs.rmSync(stale, { recursive: true, force: true });
      }
    } catch {}
    try { fs.mkdirSync(lock); }
    catch (e) {
      if (e.code !== 'EEXIST') return `the kit's worker home ${home} cannot be written (${e.code ?? e.message})`;
      if (Date.now() >= until) return `another kit process is still clearing the kit's worker home ${home} of files from an earlier kit version`;
      sleep(250); continue;
    }
    try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token })); break; }
    catch (e) { fs.rmSync(lock, { recursive: true, force: true }); return `the kit's worker home ${home} cannot be written (${e.code ?? e.message})`; }
  }
  try {
    if (current()) return null;
    const left = [];
    for (const name of fs.readdirSync(home)) {
      if (keptName(name) || sameName(name, workerHomeMarker) || name.startsWith(path.basename(lock))) continue;
      const entry = path.join(home, name);
      // Keeps the lock fresh while a large tree is removed.
      try { const now = new Date(); fs.utimesSync(lock, now, now); } catch {}
      try {
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink() || !stat.isDirectory()) fs.rmSync(entry, { force: true });
        else fs.rmSync(entry, { recursive: true, force: true });
      } catch { left.push(name); }
    }
    if (left.some(homeStateName)) return `the kit's worker home ${home} still holds ${left.join(', ')} from an earlier kit version (in use by another program?)`;
    if (left.length) console.error(`WARNING: the kit's worker home ${home} still holds ${left.join(', ')} from an earlier kit version (in use?)`);
    fs.writeFileSync(marker, `${JSON.stringify({ layout: workerHomeLayout })}\n`, { mode: 0o600 });
    return null;
  } finally {
    // Only this process's lock: one taken over meanwhile belongs to another.
    try { if (JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token === token) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}
function resetLargeIndex(home, now = Date.now()) {
  const db = path.join(home, 'session-store.db');
  let bytes = 0, written = 0;
  for (const suffix of ['', '-wal']) { try { const stat = fs.statSync(db + suffix); bytes += stat.size; written = Math.max(written, stat.mtimeMs); } catch {} }
  // Another kit process's CLIs may be writing to it: then it waits for a quiet start.
  if (bytes <= workerIndexLimitBytes || now - written < workerIndexIdleMs) return;
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(db + suffix, { force: true }); } catch {} }
}
// For tests: forget which homes this process already prepared.
export const resetPreparedWorkerHomes = () => prepared.clear();
// Every session-state folder that may hold a kit worker's session: the worker
// home's (whatever the current setting) and the person's (sessions from before
// 0.34.0, workerCopilotHome "shared", or calls that fell back after sign-in).
export function sessionStateDirs(root, env = process.env) {
  return [workerHomePath(root, env), userCopilotHome(root, env)].map(dir => path.join(dir, 'session-state'));
}
