// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import crypto from 'node:crypto';
import { safePath, readJSON, writeJSON, fileHash, treeHash, hash, stamp, contextHash, sourceOnlyPlan, readManifest, loadReviewDependencies, reviewDependencyPath } from './core.mjs';
import { costEvent, recordCost } from './cost.mjs';

export const orderedPhases = ['00', '00b', '01', '02', '03', '04', '05', '05b', '05c', '06'];
const manual = new Set(['00', '00b', '01', '02', '03']);
const receiptPath = (root, phase) => safePath(root, `migration/phases/${phase}.json`);
const startPath = (root, phase) => safePath(root, `migration/phases/starts/${phase}.json`);
export function strictPhases(root, config) {
  const policy = safePath(root, 'migration/phases/policy.json');
  if (fs.existsSync(policy)) {
    const value = readJSON(policy);
    if (value.schemaVersion !== 1 || value.policy !== 'strict') throw new Error('Invalid phase policy record');
    return true;
  }
  return config.phasePolicy === 'strict';
}
export function initializePhases(root) {
  const policy = safePath(root, 'migration/phases/policy.json');
  if (fs.existsSync(policy)) {
    const old = readJSON(policy);
    if (old.schemaVersion !== 1 || old.policy !== 'strict') throw new Error('Invalid existing phase policy');
    return old;
  }
  const value = { schemaVersion: 1, policy: 'strict', createdAt: stamp() };
  writeJSON(policy, value); return value;
}
function foundation(root, config) {
  for (const p of config.sourceRoots) if (!fs.existsSync(safePath(root, p))) throw new Error(`Input root missing: ${p}`);
  return hash(JSON.stringify({ source: treeHash(root, config.sourceRoots), sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage, mode: config.mode, verificationMode: config.verificationMode ?? 'runtime',
    sourceRoots: config.sourceRoots, outputRoots: config.outputRoots, verificationRoots: config.verificationRoots }));
}
function artifacts(config, phase) {
  return { '00':['migration/feasibility.md'], '00b':['migration/judge-report.md'],
    '01':['migration/depmap/report.md', 'migration/manifest.tsv', reviewDependencyPath(config)],
    '02':['migration/gap-report.md', 'migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv', reviewDependencyPath(config)],
    '03':['migration/stress-test/report.md', 'migration/results/judge.json'],
    '05c':['migration/results/smoke.json'], '06':['migration/handoff.md', 'migration/results/parity.json'] }[phase];
}
export function currentPhase(root, config, phase) {
  const file = receiptPath(root, phase);
  if (!fs.existsSync(file)) return false;
  const r = readJSON(file);
  if (r?.schemaVersion !== 1 || r.phase !== phase || !r.executionId || !r.note?.trim() || r.foundation !== foundation(root, config) || !Array.isArray(r.evidence) || !r.evidence.length) return false;
  if (r.evidence.some(([p, h]) => !h || fileHash(safePath(root, p)) !== h)) return false;
  if (phase === '05c' && (config.verificationMode !== 'source-only' || r.outcome !== 'not-applicable' || r.equivalence !== 'unverified')) return false;
  const index = orderedPhases.indexOf(phase);
  if (index < 0) return false;
  if (manual.has(phase) && index > 0) {
    const prev = orderedPhases[index - 1];
    if (!currentPhase(root, config, prev) || r.predecessorHash !== fileHash(receiptPath(root, prev))) return false;
  }
  if (['05c','06'].includes(phase) && (!currentPhase(root,config,'03') || r.predecessorHash !== fileHash(receiptPath(root,'03')))) return false;
  if (['02','03','05c','06'].includes(phase) && r.contextHash !== contextHash(root, config)) return false;
  return r;
}
export function requirePhase(root, config, phase) {
  if (!strictPhases(root, config)) return;
  if (!currentPhase(root, config, phase)) throw new Error(`Phase ${phase} is not reviewed for current inputs. Use phase next; review its artifacts and record phase complete ${phase} --note TEXT before proceeding.`);
}
export function checkPreparation(root, config, phase) {
  const index = orderedPhases.indexOf(phase);
  if (index < 0) throw new Error('Unknown phase; use 00, 00b, 01, 02, 03, 04, 05, 05b, 05c, 06');
  if (index > 0) requirePhase(root, config, orderedPhases[Math.min(index - 1, 4)]);
}
export function startPhase(root, config, phase) {
  checkPreparation(root, config, phase);
  const value = { schemaVersion:1, phase, executionId:crypto.randomUUID(), startedAt:stamp(), foundation:foundation(root, config) };
  writeJSON(startPath(root, phase), value); return value;
}
export function completePhase(root, config, phase, note, {tokens, subagents, model} = {}) {
  if (!note?.trim()) throw new Error('Phase completion requires a concrete review --note');
  checkPreparation(root, config, phase);
  if (!manual.has(phase) && phase !== '05c' && phase !== '06') throw new Error('This phase is completed by current runner receipts, not manual confirmation');
  if (phase === '05c' && config.verificationMode !== 'source-only') throw new Error('Runtime parity requires actual runner validation');
  if (phase === '06' && config.verificationMode === 'source-only') throw new Error('Source-only phase 06 requires the handoff runner receipt');
  const old = currentPhase(root, config, phase);
  if (old) { if (old.cost) recordCost(root, old.cost); return old; }
  const evidence = artifacts(config, phase).map(p => {
    const f = safePath(root, p);
    if (!fileHash(f) || fs.statSync(f).size === 0) throw new Error(`Nonempty phase artifact required: ${p}`);
    return [p, fileHash(f)];
  });
  if (phase === '00b') {
    if (config.verificationMode === 'source-only') evidence.push(...sourceOnlyPlan(root, config).files);
    else if (!config.commands?.original || !config.commands?.mutation || !config.commands?.parity || !config.verificationRoots.some(p => fs.existsSync(safePath(root,p)))) throw new Error('Prepare runtime judge inputs and original/mutation/parity commands before phase 00b review');
  }
  if (phase === '01') { if (!readManifest(root, config).length) throw new Error('Manifest is empty'); loadReviewDependencies(root, config); }
  const index = orderedPhases.indexOf(phase), finishedAt = stamp(), executionId = crypto.randomUUID();
  const start = fs.existsSync(startPath(root, phase)) ? readJSON(startPath(root, phase)) : null;
  const currentFoundation = foundation(root, config);
  const value = { schemaVersion:1, phase, executionId, note:note.trim(), completedAt:finishedAt, foundation:currentFoundation, evidence,
    ...(manual.has(phase) && index > 0 ? { predecessorHash:fileHash(receiptPath(root, orderedPhases[index-1])) } : ['05c','06'].includes(phase) ? {predecessorHash:fileHash(receiptPath(root,'03'))} : {}),
    ...(['02','03','05c','06'].includes(phase) ? {contextHash:contextHash(root,config)} : {}),
    ...(phase === '05c' ? {outcome:'not-applicable',equivalence:'unverified'} : {}) };
  if (manual.has(phase) || phase === '05c' || phase === '06') value.cost = costEvent({id:`phase-${executionId}`,step:phase,finishedAt,
    startedAt:start?.foundation === currentFoundation ? start.startedAt : null,tokens,subagents,model});
  writeJSON(receiptPath(root, phase), value);
  if (value.cost) recordCost(root, value.cost);
  return value;
}
