// SPDX-License-Identifier: Apache-2.0
// Copilot CLI worker sessions. The runner chooses every worker call's
// --session-id and journals it under migration/runs/<run>/cli-sessions.jsonl
// before the CLI starts, so retried, failed and interrupted calls are covered.
// The transcripts contain source code and prompts, so they are reported and,
// on the person's request, pruned here by exactly those recorded IDs: user
// sessions are never touched. The CLI's own search index (session-store.db)
// is not edited. Workers run in their own CLI home since 0.34.0
// (worker-home.mjs), so both that home and the person's are looked in.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath, readJSON, stamp } from './core.mjs';
import { userCopilotHome, sessionStateDirs } from './worker-home.mjs';

export const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = sessionIdPattern;
// The person's own session-state. Workers run with the project as cwd, so a
// relative COPILOT_HOME is the project's (as in runtime.mjs).
export const sessionStateDir = root => path.join(userCopilotHome(root), 'session-state');
const journal = runId => `migration/runs/${runId}/cli-sessions.jsonl`;
// Called before the worker process starts; returns the ID to pass to it.
export function recordSession(root, runId, { role, target } = {}) {
  const id = crypto.randomUUID(), file = safePath(root, journal(runId));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ id, role, target, at: stamp() })}\n`);
  return id;
}

function* records(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* records(file, depth + 1);
    else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name === 'cli-sessions.jsonl')) yield file;
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
    const rel = path.relative(root, file).split(path.sep).join('/');
    let values;
    try { values = file.endsWith('.jsonl') ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }) : [readJSON(file)]; }
    catch { continue; }
    // Journal lines carry `id`; attempt and survey records carry `cliSessionId`.
    for (const value of values) {
      const id = file.endsWith('.jsonl') ? value?.id : value?.cliSessionId;
      if (typeof id === 'string' && uuid.test(id)) ids.set(id, rel);
    }
  }
  return ids;
}
export function sessionsStatus(root, options = {}) {
  const dirs = sessionStateDirs(root), ids = workerSessions(root, options);
  let present = 0, bytes = 0;
  for (const id of ids.keys()) for (const dir of dirs) {
    const p = path.join(dir, id);
    if (fs.existsSync(p) && fs.lstatSync(p).isDirectory()) { present++; bytes += size(p); break; }
  }
  return { sessionState: dirs[0], sessionStates: dirs, recorded: ids.size, present, bytes,
    note: 'Worker transcripts are kept under the Copilot CLI session-state (the kit\'s worker home, and the person\'s home for older runs) and contain source code and prompts. Whether they also sync to the GitHub account follows the person\'s Copilot CLI setting. Prune them only after the person agrees; receipts never depend on them.' };
}
export function pruneSessions(root, options = {}) {
  const dirs = sessionStateDirs(root), ids = workerSessions(root, options);
  let removed = 0, bytes = 0;
  for (const id of ids.keys()) for (const dir of dirs) {
    const p = path.join(dir, id);
    if (!fs.existsSync(p)) continue;
    const stat = fs.lstatSync(p);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(p) !== dir) continue;
    bytes += size(p);
    fs.rmSync(p, { recursive: true, force: true });
    removed++;
  }
  return { sessionState: dirs[0], sessionStates: dirs, recorded: ids.size, removed, bytes,
    note: 'Removed only sessions recorded as kit workers. The CLI keeps its own search index; `/chronicle reindex` in an interactive CLI rebuilds it.' };
}
