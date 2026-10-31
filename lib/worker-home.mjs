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
// The worker home carries the person's settings, not their records: top-level
// files (config.json, which the CLI manages and which names the signed-in
// account, settings.json, MCP and permission settings) are copied when they
// changed, once per process, and the folders the CLI reads settings or plugins
// from are linked (a junction on Windows), so workers load what they loaded
// before. The person's session-state, index, logs, command history, caches
// and downloaded builds stay where they are. Sign-in tokens live in the system
// credential store, keyed by account, not by home. A CLI that still says it is
// not signed in there makes the adapter repeat the call in the person's home,
// and stay there for the rest of that command once that works (see
// copilot_adapter.mjs). workerCopilotHome: "shared" in migration/config.json
// keeps every worker in the person's home.
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
// Session records are never brought into the worker home, including names a
// later CLI may add for them; everything else (settings and state files,
// plugins, agents, skills, hooks) is, as workers saw it before.
const recordName = name => /session|history|^logs?$|^pkg$|^te?mp$|\.lock$|\.db(?:-|$)|\.log$|\.tmp$/i.test(name);
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
    const same = (a, b) => process.platform === 'win32' ? a?.toLowerCase() === b.toLowerCase() : a === b;
    if (same(target, fs.realpathSync(from))) return;
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
export function prepareWorkerHome(root, config, { env = process.env } = {}) {
  const home = workerCopilotHome(root, config, env);
  if (!home) return null;
  const user = userCopilotHome(root, env);
  const key = `${user}\0${home}`;
  if (prepared.has(key)) return prepared.get(key);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let names = [];
  try { names = fs.readdirSync(user); } catch {}
  for (const name of names) {
    if (recordName(name)) continue;
    const from = path.join(user, name), to = path.join(home, name);
    try {
      // Follows links: dotfile managers keep settings as symbolic links.
      const stat = fs.statSync(from);
      if (stat.isFile()) copySetting(from, to, stat.mode);
      else if (stat.isDirectory()) linkFolder(from, to);
    } catch {}
  }
  // A folder the person removed is unlinked; files stay (the CLI writes its own there).
  const current = new Set(names.map(name => process.platform === 'win32' ? name.toLowerCase() : name));
  for (const name of fs.readdirSync(home)) {
    const to = path.join(home, name);
    try { if (!current.has(process.platform === 'win32' ? name.toLowerCase() : name) && fs.lstatSync(to).isSymbolicLink()) fs.rmSync(to, { force: true }); } catch {}
  }
  resetLargeIndex(home);
  prepared.set(key, home);
  return home;
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
