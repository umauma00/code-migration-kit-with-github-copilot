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
// account, settings.json, MCP and permission settings) are copied once per
// process, and the folders the CLI reads settings or plugins from are linked
// (a junction on Windows), so workers load exactly what they loaded before.
// The person's session-state, index, logs, command history and downloaded
// builds stay where they are. Sign-in tokens live in the system credential
// store, keyed by account, not by home. A CLI that still reports itself signed
// out in the worker home makes the adapter fall back to the person's home for
// the rest of the process (see copilot_adapter.mjs). workerCopilotHome:
// "shared" in migration/config.json keeps every worker in the person's home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const workerHomeModes = ['separate', 'shared'];
// The person's CLI home, as the CLI resolves it. Workers run with the project
// as cwd, so a relative COPILOT_HOME is the project's.
export const userCopilotHome = (root, env = process.env) => path.resolve(root ?? process.cwd(), env.COPILOT_HOME || path.join(os.homedir(), '.copilot'));
// null when workers share the person's home.
export function workerCopilotHome(root, config, env = process.env) {
  if ((config?.workerCopilotHome ?? 'separate') === 'shared') return null;
  return `${userCopilotHome(root, env)}-migration-kit-workers`;
}
// Records of the person's own sessions, never brought into the worker home.
const recordFile = name => /^session-store\.db/i.test(name) || /^command-history/i.test(name) || /\.lock$/i.test(name);
const recordDir = name => ['session-state', 'logs', 'pkg', 'command-history-state'].includes(name.toLowerCase());
// The workers' own index is rebuilt from scratch past this size: it only
// indexes kit sessions, and an index that large is what this home avoids.
export const workerIndexLimitBytes = 64 * 1024 * 1024;

const prepared = new Map();
// Creates or refreshes the worker home once per process and returns its path
// (null for "shared"). Settings are copied at most once per process so that
// workers running in parallel never see a half-written file.
export function prepareWorkerHome(root, config, { env = process.env } = {}) {
  const home = workerCopilotHome(root, config, env);
  if (!home) return null;
  const user = userCopilotHome(root, env);
  const key = `${user}\0${home}`;
  if (prepared.has(key)) return prepared.get(key);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let entries = [];
  try { entries = fs.readdirSync(user, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    const from = path.join(user, entry.name), to = path.join(home, entry.name);
    try {
      if (entry.isFile() && !recordFile(entry.name)) fs.copyFileSync(from, to);
      else if (entry.isDirectory() && !recordDir(entry.name) && !fs.existsSync(to)) {
        let present = false; try { fs.lstatSync(to); present = true; } catch {}
        // A dangling link left by a folder the person removed is replaced.
        if (present) fs.rmSync(to, { force: true });
        fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
      }
    } catch {}
  }
  resetLargeIndex(home);
  prepared.set(key, home);
  return home;
}
function resetLargeIndex(home) {
  const db = path.join(home, 'session-store.db');
  let bytes = 0;
  for (const suffix of ['', '-wal']) { try { bytes += fs.statSync(db + suffix).size; } catch {} }
  if (bytes <= workerIndexLimitBytes) return;
  // A CLI still using it (another kit process) keeps it open: Windows then
  // refuses the removal and the index stays until the next run.
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(db + suffix, { force: true }); } catch {} }
}
// For tests: forget which homes this process already prepared.
export const resetPreparedWorkerHomes = () => prepared.clear();
// Every session-state folder that may hold a kit worker's session: the worker
// home's (whatever the current setting) and the person's (sessions from before
// 0.34.0, workerCopilotHome "shared", or calls that fell back after sign-in).
export function sessionStateDirs(root, env = process.env) {
  const user = userCopilotHome(root, env);
  return [`${user}-migration-kit-workers`, user].map(dir => path.join(dir, 'session-state'));
}
