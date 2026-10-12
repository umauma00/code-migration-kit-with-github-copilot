// SPDX-License-Identifier: Apache-2.0
// File-backed transport only: the host session, not Node, invokes subagents.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { safePath, readJSON, writeJSON, fileHash, contextHash, hash, stamp, loadConfig } from './core.mjs';
import { reviewInput, validateNativeProfile } from './review.mjs';
import { validateResult } from './results.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const runPattern = /^[0-9]+-[a-f0-9]{8}$/;
const taskPattern = new RegExp(`^([0-9]+-[a-f0-9]{8})/(${uuid})$`);
export const maxNativeResponseBytes = 16 * 1024 * 1024;
function taskPath(root, task, leaf) {
  const match = typeof task === 'string' && task.match(taskPattern);
  if (!match) throw new Error('Invalid native task ID');
  return safePath(root, `migration/runs/${match[1]}/native/${match[2]}/${leaf}`);
}
function liveLock(root) {
  const file = safePath(root, 'migration/run.lock');
  if (!fs.existsSync(file)) return null;
  const lock = readJSON(file);
  if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('Invalid runner lock');
  try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; throw e; }
  return { ...lock, hash: fileHash(file) };
}
function activeTask(root, task) {
  const request = readJSON(taskPath(root, task, 'request.json'));
  if (request.task !== task || request.schemaVersion !== 1) throw new Error('Invalid native request');
  const lock = liveLock(root);
  if (!lock || lock.hash !== request.lockHash || lock.runId !== task.split('/')[0] || !['translation', 'repair'].includes(lock.task)) throw new Error('Native task belongs to an inactive runner');
  if (Date.now() >= request.deadline || fs.existsSync(taskPath(root, task, 'closed.json'))) throw new Error('Native task expired or closed');
  const config = loadConfig(root);
  if (contextHash(root, config) !== request.context || fileHash(safePath(root, request.unit.target)) !== request.outputHash) throw new Error('Native task inputs or candidate changed');
  return request;
}
function transaction(root, task, action) {
  const file = taskPath(root, task, 'control.lock');
  // Only claim/submit clients acquire this short synchronous lock. A client
  // crash leaves this task unusable; restart the runner instead of stealing it.
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Native task control is busy; retry, or restart the runner after a client crash'); throw e; }
  try { return action(); }
  finally { fs.closeSync(fd); fs.rmSync(file, { force: true }); }
}

export function listNativeTasks(root) {
  const lock = liveLock(root), tasks = [];
  if (!lock) return { running: false, tasks };
  if (['translation', 'repair'].includes(lock.task)) {
    if (typeof lock.runId !== 'string' || !runPattern.test(lock.runId)) throw new Error('Native task listing requires a runner run ID; restart with the current runner');
    // The lock identifies the only live run. Never parse old requests: corrupt
    // history (even a hard-crashed task without closed.json) cannot block resume.
    const dir = safePath(root, `migration/runs/${lock.runId}/native`);
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const task = `${lock.runId}/${name}`;
      if (!taskPattern.test(task)) continue;
      if (fs.existsSync(taskPath(root, task, 'closed.json'))) continue;
      const file = taskPath(root, task, 'request.json');
      if (!fs.existsSync(file)) continue;
      const r = readJSON(file);
      if (r.lockHash !== lock.hash || r.deadline <= Date.now()) continue;
      const status = fs.existsSync(taskPath(root, task, 'response.json')) ? 'submitted'
        : fs.existsSync(taskPath(root, task, 'claim.json')) ? 'claimed' : 'pending';
      tasks.push({ task, role: r.role, target: r.unit.target, model: r.model, harness: r.harness, status, deadline: r.deadline });
    }
  }
  return { running: true, runner: { pid: lock.pid, task: lock.task, runId: lock.runId }, tasks };
}

export function claimNativeTask(root, task) {
  return transaction(root, task, () => {
    const request = activeTask(root, task), file = taskPath(root, task, 'claim.json');
    if (fs.existsSync(file)) throw new Error('Native task already claimed');
    const claim = { token: crypto.randomUUID(), requestHash: fileHash(taskPath(root, task, 'request.json')), claimedAt: stamp() };
    writeJSON(file, claim);
    return { ...request, claimToken: claim.token };
  });
}

export function submitNativeTask(root, task, token, { result, model, error }) {
  return transaction(root, task, () => {
    const request = activeTask(root, task), claim = readJSON(taskPath(root, task, 'claim.json'));
    if (claim.token !== token || claim.requestHash !== fileHash(taskPath(root, task, 'request.json'))) throw new Error('Native claim token or request hash mismatch');
    const file = taskPath(root, task, 'response.json');
    if (fs.existsSync(file)) throw new Error('Native task already submitted');
    if (error !== undefined) {
      if (typeof error !== 'string' || !error.trim() || error.length > 4000) throw new Error('Native failure requires a short error message');
    } else {
      if (model !== request.model) throw new Error('Native model differs from the requested model; report failure instead of substituting');
      validateResult(request.role, result, request.unit);
    }
    const response = { task, claimToken: token, requestHash: claim.requestHash, result, hostReportedModel: model, error, submittedAt: stamp() };
    if (Buffer.byteLength(JSON.stringify(response)) > maxNativeResponseBytes) throw new Error('Native response exceeded limit');
    writeJSON(file, response);
    return { task, accepted: true, note: 'Queued for runner validation; this is not a completion receipt.' };
  });
}

export function createNativeAdapter({ pollMs = 200 } = {}) {
  return async ({ root, config, role, unit, extra = {}, signal, reviewInput: frozenReview, context, runId }) => {
    if (config.workerBackend !== 'native') throw new Error('Configure workerBackend: native before approving translation');
    const profile = validateNativeProfile(root, role, config);
    const lock = liveLock(root);
    if (!lock || lock.pid !== process.pid || lock.runId !== runId) throw new Error('Native adapter requires the active runner lock and run ID');
    if (signal?.aborted) throw new Error('Interrupted');
    const task = `${runId}/${crypto.randomUUID()}`;
    const frozen = frozenReview ?? reviewInput(root, config, unit, extra.diagnostic ?? null, { candidate: role !== 'implementer' }).text;
    const request = {
      schemaVersion: 1, task, role, unit, context, lockHash: lock.hash,
      outputHash: fileHash(safePath(root, unit.target)), model: config.models[role], harness: config.nativeHarness,
      agent: profile.id, agentName: profile.name, tools: [], instructionIsolation: 'host-managed',
      inputHash: hash(frozen), createdAt: stamp(), deadline: Date.now() + config.timeoutSeconds * 1000,
      prompt: `Migration: ${config.sourceLanguage} to ${config.targetLanguage}; mode: ${config.mode}.\n` +
        agentPrompt({ role, unit, extra, reviewInput: frozenReview, frozenInput: frozen })
    };
    const requestFile = taskPath(root, task, 'request.json');
    writeJSON(requestFile, request);
    const requestHash = fileHash(requestFile);
    let status = 'failed', error;
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('Interrupted');
        if (Date.now() >= request.deadline) throw new Error('Native worker timed out; cancel the host subagent before resuming');
        const responseFile = taskPath(root, task, 'response.json');
        if (fs.existsSync(responseFile)) {
          activeTask(root, task);
          if (fileHash(requestFile) !== requestHash) throw new Error('Native request changed');
          if (fs.statSync(responseFile).size > maxNativeResponseBytes) throw new Error('Native response exceeded limit');
          const response = readJSON(responseFile), claim = readJSON(taskPath(root, task, 'claim.json'));
          if (response.task !== task || response.requestHash !== requestHash || claim.requestHash !== requestHash || response.claimToken !== claim.token) throw new Error('Native response binding mismatch');
          if (response.error !== undefined) throw new Error(`Native worker failed: ${String(response.error).slice(0, 4000)}`);
          if (response.hostReportedModel !== request.model) throw new Error('Native response model mismatch');
          const result = validateResult(role, response.result, unit);
          status = 'received';
          return { result, requestedModel: request.model, observedModel: null, tokens: null, aiCredits: null,
            workerBackend: 'native', nativeHarness: config.nativeHarness, instructionIsolation: 'host-managed',
            hostReportedModel: response.hostReportedModel, nativeTask: task, requestHash };
        }
        await delay(pollMs, undefined, { signal });
      }
    } catch (e) { error = signal?.aborted ? 'Interrupted' : e.message; throw new Error(error); }
    finally { writeJSON(taskPath(root, task, 'closed.json'), { task, status, error, closedAt: stamp() }); }
  };
}
