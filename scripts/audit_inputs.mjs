#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fixed preparation inputs/results only. The parent supplies actual independent
// host calls; this transport does not attest a model or invent an AI response.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseArgs, safePath, hash, fileHash, treeHash, readJSON, writeJSON, lockRun } from '../lib/core.mjs';
import { readReviewText, validatePreparationProfile } from '../lib/review.mjs';
const models = { judge: 'judgeAudit', dependencies: 'dependencyAudit', inventory: 'inventoryAudit', design: 'designAudit' };
function snapshot(root, config) { return hash(JSON.stringify({ source: treeHash(root, config.sourceRoots), verification: treeHash(root, config.verificationRoots), config: fileHash(safePath(root, 'migration/config.json')), profile: validatePreparationProfile(root, config) })); }
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
export function submitAudit(root, config, { directory, response } = {}) {
  if (!/^migration\/audits\/[A-Za-z0-9_-]+$/.test(directory)) throw new Error('Invalid audit directory');
  const release = lockRun(root, 'audit-submit');
  try {
    const request = readJSON(safePath(root, `${directory}/request.json`));
    if (request.schemaVersion !== 1 || request.kind !== 'preparation-audit-request' || !Object.hasOwn(models, request.type) || request.requestedModel !== config.phaseModels?.[models[request.type]] ||
        !request.input || !Array.isArray(request.input.files) || request.snapshot !== snapshot(root, config) || hash(JSON.stringify(request.input)) !== request.inputHash ||
        request.input.files.some(f => typeof f.content !== 'string' || hash(f.content) !== f.hash || fileHash(safePath(root, f.path)) !== f.hash)) throw new Error('Preparation audit inputs changed; use fresh contexts and requests');
    if (fileHash(safePath(root, `${directory}/result.json`))) throw new Error('Audit result already submitted; do not overwrite evidence');
    const result = readJSON(safePath(root, response));
    if (result.schemaVersion !== 1 || result.kind !== 'preparation-audit' || result.task !== request.task || result.inputHash !== request.inputHash ||
        !['pass', 'changes'].includes(result.verdict) || !Array.isArray(result.findings) || (result.verdict === 'pass') !== (result.findings.length === 0) ||
        new Set(result.findings.map(f => f.id)).size !== result.findings.length || result.findings.some(f => ['id', 'message', 'evidence', 'proposedFix'].some(k => typeof f[k] !== 'string' || !f[k].trim()))) throw new Error('Invalid preparation audit response or task/input binding');
    const record = { schemaVersion: 1, task: request.task, inputHash: request.inputHash, requestedModel: request.requestedModel,
      observedModel: null, result, completedAt: new Date().toISOString(), note: 'Result binding verified; actual host/model/isolation remains separately verified. Findings require confirmation and fresh review after changes.' };
    writeJSON(safePath(root, `${directory}/result.json`), record); return record;
  } finally { release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2)), root = fs.realpathSync(path.resolve(args.root ?? '.')), config = loadConfig(root);
    const result = args._[0] === 'freeze' ? freezeAudit(root, config, { type: args.type, files: args.files?.split(','), out: args.out })
      : args._[0] === 'submit' ? submitAudit(root, config, { directory: args.directory, response: args.response }) : (() => { throw new Error('Use freeze --type TYPE --files LIST | submit --directory PATH --response PATH'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
}
