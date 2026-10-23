#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fixed preparation inputs/results. `run` sends a frozen request to the
// tool-free auditor as a fresh Copilot CLI process with --model set to the
// request's phaseModels entry, so the plan is enforced and the CLI-reported
// model is recorded. A response obtained elsewhere is still accepted by submit.
// Never hand a request to a host subagent (task/agent tool): a tool-free auditor
// cannot open a path, and a model retyping the body breaks the hash binding.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseCommandLine, specs, usageText } from '../lib/cli.mjs';
import { loadConfig, safePath, hash, fileHash, treeHash, readJSON, writeJSON, lockRun, semanticConfig, stamp } from '../lib/core.mjs';
import { recordSession } from '../lib/sessions.mjs';
import { createCopilotAdapter } from './copilot_adapter.mjs';
import { readReviewText, validatePreparationProfile } from '../lib/review.mjs';
const models = { judge: 'judgeAudit', dependencies: 'dependencyAudit', inventory: 'inventoryAudit', design: 'designAudit' };
// The configuration on disk counts too: run waits for a worker with the config it
// loaded at the start, and a model or rule change meanwhile must void the result.
// Run limits (semanticConfig) may change.
function snapshot(root, config) { return hash(JSON.stringify({ source: treeHash(root, config.sourceRoots), verification: treeHash(root, config.verificationRoots),
  config: hash(JSON.stringify(semanticConfig(config))), configFile: hash(JSON.stringify(semanticConfig(readJSON(safePath(root, 'migration/config.json'))))), profile: validatePreparationProfile(root, config) })); }
export function freezeAudit(root, config, { type, files, out } = {}) {
  if (!Object.hasOwn(models, type) || !Array.isArray(files) || !files.length || new Set(files).size !== files.length) throw new Error('Select judge|dependencies|inventory|design and explicit unique input files');
  const model = config.phaseModels?.[models[type]];
  if (!model) throw new Error(`Set phaseModels.${models[type]} explicitly; do not inherit a default preparation model`);
  const task = crypto.randomUUID(), directory = out ?? `migration/audits/${task}`;
  if (!/^migration\/audits\/[A-Za-z0-9_-]+$/.test(directory) || fs.existsSync(safePath(root, directory))) throw new Error('Use a new audit directory under migration/audits/');
  const release = lockRun(root, 'audit-freeze');
  try {
    const before = snapshot(root, config), input = files.map(p => {
      if (/^migration\/(?:audits|reviews|runs|state|results|gates|phases)\//.test(p)) throw new Error('Audit input cannot contain prior findings, approvals or worker outcomes');
      const content = readReviewText(root, p);
      return { path: p, content, hash: hash(content) };
    });
    const inputText = JSON.stringify({ schemaVersion: 1, type, files: input });
    if (Buffer.byteLength(inputText) > (config.maxReviewInputBytes ?? 65536)) throw new Error('Preparation audit input exceeds the configured bound; select an explicit batch, never truncate');
    if (snapshot(root, config) !== before || input.some(f => fileHash(safePath(root, f.path)) !== f.hash)) throw new Error('Audit inputs changed while freezing');
    const request = { schemaVersion: 1, kind: 'preparation-audit-request', task, type, requestedModel: model, observedModel: null,
      snapshot: before, inputHash: hash(inputText), input: JSON.parse(inputText),
      responseContract: { schemaVersion: 1, kind: 'preparation-audit', task, inputHash: hash(inputText), verdict: 'pass|changes', findings: [{ id: 'ID', message: 'specific problem', evidence: 'source/assertion/rule:line proof', proposedFix: 'proposal only' }] } };
    if (Buffer.byteLength(JSON.stringify(request)) > (config.maxReviewInputBytes ?? 65536)) throw new Error('Complete preparation request exceeds the configured input bound');
    writeJSON(safePath(root, `${directory}/request.json`), request);
    return { directory, request, note: 'Delegate the exact frozen input to the tool-free preparation auditor in a fresh context. This is a request, not completed review.' };
  } finally { release(); }
}
const auditDirectory = /^migration\/audits\/[A-Za-z0-9_-]+$/;
const retirement = (root, directory) => fs.existsSync(safePath(root, `${directory}/retired.json`)) ? readJSON(safePath(root, `${directory}/retired.json`)) : null;
function currentRequest(root, config, directory) {
  if (!auditDirectory.test(directory ?? '')) throw new Error('Invalid audit directory');
  const retired = retirement(root, directory);
  if (retired) throw new Error(`Audit request ${directory} is retired${retired.supersededBy ? `, superseded by ${retired.supersededBy}` : ''}; run its replacement instead`);
  const request = readJSON(safePath(root, `${directory}/request.json`));
  if (request.schemaVersion !== 1 || request.kind !== 'preparation-audit-request' || !Object.hasOwn(models, request.type) || request.requestedModel !== config.phaseModels?.[models[request.type]] ||
        !request.input || !Array.isArray(request.input.files) || request.snapshot !== snapshot(root, config) || hash(JSON.stringify(request.input)) !== request.inputHash ||
        request.input.files.some(f => typeof f.content !== 'string' || hash(f.content) !== f.hash || fileHash(safePath(root, f.path)) !== f.hash)) throw new Error(`Preparation audit inputs changed; use fresh contexts and requests: freeze a replacement, then retire --directory ${directory} --superseded-by NEW --reason TEXT`);
  return request;
}
export async function runAudit(root, config, adapter, { directory, signal } = {}) {
  const request = currentRequest(root, config, directory);
  if (fileHash(safePath(root, `${directory}/result.json`))) throw new Error('Audit result already submitted; freeze a new request for another independent audit');
  // A fresh session per request; the journal lets sessions status/prune cover it.
  const sessionId = recordSession(root, `audit-${request.task}`, { role: 'preparation-auditor', target: directory });
  const unit = { source: null, target: `${directory}/request.json` };
  const frozen = JSON.stringify({ task: request.task, type: request.type, inputHash: request.inputHash, input: request.input, responseContract: request.responseContract });
  const response = await adapter({ root, config, role: 'preparation-auditor', unit, extra: {}, signal, reviewInput: frozen, sessionId, model: request.requestedModel });
  const { target, ...result } = response.result;
  writeJSON(safePath(root, `${directory}/response.json`), result);
  return submitAudit(root, config, { directory, response: `${directory}/response.json`, execution: {
    worker: 'copilot-cli', observedModel: response.observedModel ?? null, cliVersion: response.cliVersion ?? null, cliSessionId: response.cliSessionId ?? sessionId,
    ...(response.cliUsage ? { cliUsage: response.cliUsage } : {}), ...(response.modelWarning ? { modelWarning: response.modelWarning } : {}) } });
}
// A request that will never be submitted (stale after an input or profile
// change, or dropped) is retired, not deleted: retired.json keeps it as
// evidence, names its replacement, and run, submit and run-pending skip it.
export function retireAudit(root, config, { directory, supersededBy, reason } = {}) {
  if (!auditDirectory.test(directory ?? '') || !fs.existsSync(safePath(root, `${directory}/request.json`))) throw new Error('Name an existing audit request directory');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Give the reason for retiring the request');
  const release = lockRun(root, 'audit-retire');
  try {
    if (fileHash(safePath(root, `${directory}/result.json`))) throw new Error('Audit result already submitted; a submitted audit stays as evidence');
    if (retirement(root, directory)) throw new Error('Audit request already retired');
    let replacement = null;
    if (supersededBy !== undefined) {
      if (supersededBy === directory || !auditDirectory.test(supersededBy) || !fs.existsSync(safePath(root, `${supersededBy}/request.json`)) || retirement(root, supersededBy)) throw new Error('The replacement must be another, unretired audit request directory');
      replacement = readJSON(safePath(root, `${supersededBy}/request.json`));
    }
    const old = readJSON(safePath(root, `${directory}/request.json`));
    const record = { schemaVersion: 1, kind: 'preparation-audit-retirement', task: old.task ?? null, reason: reason.trim(),
      supersededBy: supersededBy ?? null, supersededByTask: replacement?.task ?? null, retiredAt: stamp() };
    writeJSON(safePath(root, `${directory}/retired.json`), record); return record;
  } finally { release(); }
}
// Every frozen request without a result or retirement, config.concurrency at a
// time. One failure does not stop the others; the disk shows what is pending.
export async function runPendingAudits(root, config, adapter, { signal } = {}) {
  const base = safePath(root, 'migration/audits');
  const pending = (fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }) : [])
    .filter(d => d.isDirectory() && /^[A-Za-z0-9_-]+$/.test(d.name)).map(d => `migration/audits/${d.name}`)
    .filter(dir => fs.existsSync(safePath(root, `${dir}/request.json`)) && !fs.existsSync(safePath(root, `${dir}/result.json`)) && !retirement(root, dir)).sort();
  const outcomes = [], running = new Set();
  for (const directory of pending) {
    if (signal?.aborted) break;
    const job = runAudit(root, config, adapter, { directory, signal })
      .then(record => outcomes.push({ directory, verdict: record.result.verdict, observedModel: record.observedModel }),
        error => outcomes.push({ directory, error: error.message }))
      .finally(() => running.delete(job));
    running.add(job);
    while (running.size >= Math.max(1, config.concurrency ?? 1)) await Promise.race(running);
  }
  await Promise.all(running);
  outcomes.sort((a, b) => a.directory.localeCompare(b.directory));
  return { pending: pending.length, completed: outcomes.filter(o => !o.error).length, failed: outcomes.filter(o => o.error).length, outcomes };
}
export function submitAudit(root, config, { directory, response, execution } = {}) {
  const release = lockRun(root, 'audit-submit');
  try {
    const request = currentRequest(root, config, directory);
    if (fileHash(safePath(root, `${directory}/result.json`))) throw new Error('Audit result already submitted; do not overwrite evidence');
    const result = readJSON(safePath(root, response));
    if (result.schemaVersion !== 1 || result.kind !== 'preparation-audit' || result.task !== request.task || result.inputHash !== request.inputHash ||
        !['pass', 'changes'].includes(result.verdict) || !Array.isArray(result.findings) || (result.verdict === 'pass') !== (result.findings.length === 0) ||
        new Set(result.findings.map(f => f.id)).size !== result.findings.length || result.findings.some(f => ['id', 'message', 'evidence', 'proposedFix'].some(k => typeof f[k] !== 'string' || !f[k].trim()))) throw new Error('Invalid preparation audit response or task/input binding');
    const record = { schemaVersion: 1, task: request.task, inputHash: request.inputHash, requestedModel: request.requestedModel,
      observedModel: execution?.observedModel ?? null, ...(execution ? { execution } : {}), result, completedAt: new Date().toISOString(),
      note: execution ? 'Run as a fresh tool-free Copilot CLI worker with --model set to the requested model; observedModel is the model the CLI reported. Findings require confirmation and fresh review after changes.'
        : 'Result binding verified; actual host/model/isolation remains separately verified. Findings require confirmation and fresh review after changes.' };
    writeJSON(safePath(root, `${directory}/result.json`), record); return record;
  } finally { release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCommandLine(process.argv.slice(2), specs.audit_inputs);
    if (args.help) { console.log(usageText(specs.audit_inputs)); process.exit(0); }
    const root = fs.realpathSync(path.resolve(args.root ?? '.')), config = loadConfig(root);
    const result = args._[0] === 'freeze' ? freezeAudit(root, config, { type: args.type, files: args.files?.split(','), out: args.out })
      : args._[0] === 'run' ? await runAudit(root, config, createCopilotAdapter({ command: args.copilot }), { directory: args.directory })
      : args._[0] === 'run-pending' ? await runPendingAudits(root, config, createCopilotAdapter({ command: args.copilot }))
      : args._[0] === 'retire' ? retireAudit(root, config, { directory: args.directory, supersededBy: args['superseded-by'], reason: args.reason })
      : args._[0] === 'submit' ? submitAudit(root, config, { directory: args.directory, response: args.response }) : (() => { throw new Error('Use freeze --type TYPE --files LIST | run --directory PATH [--copilot PATH] | run-pending [--copilot PATH] | retire --directory PATH [--superseded-by PATH] --reason TEXT | submit --directory PATH --response PATH'); })();
    console.log(JSON.stringify(result, null, 2));
    if (result.failed) process.exitCode = 1;
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
