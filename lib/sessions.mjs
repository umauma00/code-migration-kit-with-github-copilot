// SPDX-License-Identifier: Apache-2.0
// Copilot CLI worker sessions. Every worker call starts with a runner-chosen
// --session-id that its attempt or survey record keeps as cliSessionId. The
// transcripts stay local (--no-remote-export) and contain source code and
// prompts, so they are reported and, on the person's request, pruned here by
// exactly those recorded IDs: user sessions are never touched. The CLI's own
// search index (session-store.db) is not edited.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safePath, readJSON } from './core.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sessionStateDir = (home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot')) => path.join(home, 'session-state');

function* records(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* records(file, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.json')) yield file;
  }
}
function size(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) bytes += size(file);
    else if (entry.isFile()) bytes += fs.statSync(file).size;
  }
  return bytes;
}
// Recorded worker session IDs, optionally limited to one run.
export function workerSessions(root, { run } = {}) {
  if (run !== undefined && !/^[0-9]+-[a-f0-9]{8}$/.test(run)) throw new Error('--run must be a run ID from migration/runs');
  const ids = new Map();
  const roots = run ? [safePath(root, `migration/runs/${run}`)] : [safePath(root, 'migration/runs'), safePath(root, 'migration/surveys')];
  for (const dir of roots) for (const file of records(dir)) {
    let value;
    try { value = readJSON(file); } catch { continue; }
    if (typeof value?.cliSessionId === 'string' && uuid.test(value.cliSessionId)) ids.set(value.cliSessionId, path.relative(root, file).split(path.sep).join('/'));
  }
  return ids;
}
export function sessionsStatus(root, options = {}) {
  const dir = sessionStateDir(), ids = workerSessions(root, options);
  let present = 0, bytes = 0;
  for (const id of ids.keys()) {
    const p = path.join(dir, id);
    if (fs.existsSync(p) && fs.lstatSync(p).isDirectory()) { present++; bytes += size(p); }
  }
  return { sessionState: dir, recorded: ids.size, present, bytes,
    note: 'Worker transcripts stay on this machine (--no-remote-export) and contain source code and prompts. Prune them only after the person agrees; receipts never depend on them.' };
}
export function pruneSessions(root, options = {}) {
  const dir = sessionStateDir(), ids = workerSessions(root, options);
  let removed = 0, bytes = 0;
  for (const id of ids.keys()) {
    const p = path.join(dir, id);
    if (!fs.existsSync(p)) continue;
    const stat = fs.lstatSync(p);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(p) !== dir) continue;
    bytes += size(p);
    fs.rmSync(p, { recursive: true, force: true });
    removed++;
  }
  return { sessionState: dir, recorded: ids.size, removed, bytes,
    note: 'Removed only sessions recorded as kit workers. The CLI keeps its own search index; `/chronicle reindex` in an interactive CLI rebuilds it.' };
}
