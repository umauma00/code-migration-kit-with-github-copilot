// SPDX-License-Identifier: Apache-2.0
// File-backed transport only: the host session, not Node, invokes subagents.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { safePath, readJSON, writeJSON, fileHash, contextHash, hash, stamp, loadConfig, nativeModelVerification, workerModel, atomicWrite } from './core.mjs';
import { reviewInput, validateNativeProfile } from './review.mjs';
import { validateResult } from './results.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';
import { executionPurpose, requirePilot } from './pilot.mjs';
import { planSurvey, surveyInput } from './survey.mjs';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const runPattern = /^[0-9]+-[a-f0-9]{8}$/;
const taskPattern = new RegExp(`^([0-9]+-[a-f0-9]{8})/(${uuid})$`);
// nativeInput file: the worker reads this file itself instead of receiving the
// prompt through the parent, so the parent never re-emits large frozen inputs.
export const promptFilePattern = new RegExp(`^migration/runs/([0-9]+-[a-f0-9]{8})/native/(${uuid})/prompt\\.txt$`);
export const nativeTaskOfPromptFile = rel => { const m = String(rel).match(promptFilePattern); return m ? `${m[1]}/${m[2]}` : null; };
// Written by the profile's --native-file hook when it admits the read. Its
// absence means the host never ran the agent-scoped hook for this task.
export const readerReceipt = 'reader.json';
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
  if (!lock || lock.hash !== request.lockHash || lock.runId !== task.split('/')[0] || !['translation', 'repair', 'survey'].includes(lock.task)) throw new Error('Native task belongs to an inactive runner');
  if (Date.now() >= request.deadline || fs.existsSync(taskPath(root, task, 'closed.json'))) throw new Error('Native task expired or closed');
  const config = loadConfig(root);
  requirePilot(root, config);
  // A survey task is bound to its scope input, not to the translation context.
  const expected = request.survey ? surveyScopeHash(root, config, request.survey) : contextHash(root, config);
  if (expected !== request.context || fileHash(safePath(root, request.unit.target)) !== request.outputHash) throw new Error('Native task inputs or candidate changed');
  return request;
}
function surveyScopeHash(root, config, { kind, scope, maxFiles, sitesFile }) {
  const plan = planSurvey(root, config, kind, { maxFiles, sitesFile });
  const entry = plan.scopes.find(s => s.id === scope);
  return entry ? surveyInput(root, config, kind, entry, { sitesFile }).hash : null;
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
  if (['translation', 'repair', 'survey'].includes(lock.task)) {
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
      tasks.push({ task, role: r.role, target: r.unit.target, model: r.model, harness: r.harness, modelVerification: r.modelVerification ?? 'host-metadata', status, deadline: r.deadline });
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
      // Both modes require the model the parent passed to the host's per-call
      // model parameter. Only host-metadata asserts it was observed.
      if (model !== request.model) throw new Error('Native model differs from the requested model; report failure instead of substituting');
      validateResult(request.role, result, request.unit);
    }
    const response = { task, claimToken: token, requestHash: claim.requestHash, result, hostReportedModel: model,
      modelVerification: request.modelVerification ?? 'host-metadata', error, submittedAt: stamp() };
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
    const survey = role === 'surveyor' ? extra.survey : undefined;
    const prompt = `Migration: ${config.sourceLanguage} to ${config.targetLanguage}; mode: ${config.mode}.\n` +
      agentPrompt({ role, unit, extra, reviewInput: role === 'surveyor' ? undefined : frozenReview, frozenInput: frozen });
    const fileInput = config.nativeInput === 'file';
    const promptFile = `migration/runs/${runId}/native/${task.split('/')[1]}/prompt.txt`;
    if (fileInput) atomicWrite(safePath(root, promptFile), prompt);
    const request = {
      schemaVersion: 1, task, role, unit, purpose: executionPurpose(config), context, lockHash: lock.hash,
      outputHash: fileHash(safePath(root, unit.target)), model: workerModel(config, role), harness: config.nativeHarness, ...(survey ? { survey } : {}),
      agent: profile.id, agentName: profile.name, tools: [], instructionIsolation: 'host-managed', modelVerification: nativeModelVerification(config),
      inputHash: hash(frozen), createdAt: stamp(), deadline: Date.now() + config.timeoutSeconds * 1000,
      ...(fileInput
        ? { nativeInput: 'file', promptFile, promptSha256: hash(prompt), promptBytes: Buffer.byteLength(prompt),
          dispatch: `Your complete task is the file ${promptFile} (SHA-256 ${hash(prompt)}). Read it in full with the read tool, read nothing else, follow it exactly and return only the JSON object it asks for.` }
        : { prompt })
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
          if (fileInput) {
            const marker = taskPath(root, task, readerReceipt), seen = fs.existsSync(marker) ? readJSON(marker) : null;
            if (seen?.task !== task || seen.role !== role || seen.promptSha256 !== request.promptSha256) throw new Error('Native file input was not read through the profile\'s reader hook; this host did not run the agent-scoped hook, so use nativeInput inline');
          }
          const result = validateResult(role, response.result, unit);
          status = 'received';
          return { result, requestedModel: request.model, observedModel: null, tokens: null, aiCredits: null,
            promptBytes: Buffer.byteLength(prompt), responseBytes: Buffer.byteLength(JSON.stringify(result)), nativeInput: fileInput ? 'file' : 'inline',
            workerBackend: 'native', nativeHarness: config.nativeHarness, instructionIsolation: 'host-managed',
            hostReportedModel: response.hostReportedModel, modelVerification: request.modelVerification, nativeTask: task, requestHash };
        }
        await delay(pollMs, undefined, { signal });
      }
    } catch (e) { error = signal?.aborted ? 'Interrupted' : e.message; throw new Error(error); }
    finally { writeJSON(taskPath(root, task, 'closed.json'), { task, status, error, closedAt: stamp() }); }
  };
}
