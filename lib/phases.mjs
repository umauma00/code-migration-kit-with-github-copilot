// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pluginRoot } from './runtime.mjs';
import { safePath, readJSON, writeJSON, fileHash, treeHash, hash, stamp, contextHash, sourceOnlyPlan, readManifest, loadReviewDependencies, reviewDependencyPath, specPlaceholder, missingRootMessage } from './core.mjs';
import { costEvent, recordCost } from './cost.mjs';
import { judgeInputHash } from './judge.mjs';

export const orderedPhases = ['00', '00b', '01', '02', '03', '04', '05', '05b', '05c', '06'];
const manual = new Set(['00', '00b', '01', '02', '03']);
const receiptPath = (root, phase) => safePath(root, `migration/phases/${phase}.json`);
const startPath = (root, phase) => safePath(root, `migration/phases/starts/${phase}.json`);
// Whether the phase was ever recorded, current or not.
export const phaseRecorded = (root, phase) => fs.existsSync(receiptPath(root, phase));
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
function foundation(root, config, read) {
  if (read?.foundation !== undefined) return read.foundation;
  for (const p of config.sourceRoots) if (!fs.existsSync(safePath(root, p))) throw new Error(missingRootMessage(config, p, 'Input root missing'));
  const value = hash(JSON.stringify({ source: treeHash(root, config.sourceRoots), sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage, mode: config.mode, verificationMode: config.verificationMode ?? 'runtime',
    sourceRoots: config.sourceRoots, outputRoots: config.outputRoots, verificationRoots: config.verificationRoots }));
  if (read) read.foundation = value;
  return value;
}
function artifacts(config, phase) {
  const paths = { '00':['migration/feasibility.md'], '00b':['migration/judge-report.md'],
    '01':['migration/depmap/report.md', 'migration/manifest.tsv', reviewDependencyPath(config)],
    '02':['migration/gap-report.md', 'migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv', reviewDependencyPath(config)],
    '03':['migration/stress-test/report.md', 'migration/results/judge.json'],
    '05c':['migration/results/smoke.json'], '06':['migration/handoff.md', 'migration/results/parity.json'] }[phase];
  return paths.concat(phase === '01' && config.packageMap ? [config.packageMap, 'migration/depmap/package-cycles.json'] : []);
}
export function currentPhase(root, config, phase, read) {
  const file = receiptPath(root, phase);
  if (!fs.existsSync(file)) return false;
  const r = readJSON(file);
  if (r?.schemaVersion !== 1 || r.phase !== phase || !r.executionId || !r.note?.trim() || r.foundation !== foundation(root, config, read) || !Array.isArray(r.evidence) || !r.evidence.length) return false;
  if (r.evidence.some(([p, h]) => !h || fileHash(safePath(root, p)) !== h)) return false;
  if (phase === '00b' && r.judgeInputHash && r.judgeInputHash !== judgeInputHash(root, config)) return false;
  if (phase === '05c' && (config.verificationMode !== 'source-only' || r.outcome !== 'not-applicable' || r.equivalence !== 'unverified')) return false;
  const index = orderedPhases.indexOf(phase);
  if (index < 0) return false;
  if (manual.has(phase) && index > 0) {
    const prev = orderedPhases[index - 1];
    if (!currentPhase(root, config, prev, read) || r.predecessorHash !== fileHash(receiptPath(root, prev))) return false;
  }
  if (['05c','06'].includes(phase) && (!currentPhase(root,config,'03',read) || r.predecessorHash !== fileHash(receiptPath(root,'03')))) return false;
  if (['02','03','05c','06'].includes(phase) && r.contextHash !== (read?.contextKnown ? read.context : contextHash(root, config))) return false;
  return r;
}
export function requirePhase(root, config, phase) {
  if (!strictPhases(root, config)) return;
  if (!currentPhase(root, config, phase)) throw new Error(`Phase ${phase} is not reviewed for current inputs. Use phase next; review its artifacts and record phase complete ${phase} --note TEXT before proceeding.`);
}
export function checkPreparation(root, config, phase, { completing = false } = {}) {
  const index = orderedPhases.indexOf(phase);
  if (index < 0) throw new Error('Unknown phase; use 00, 00b, 01, 02, 03, 04, 05, 05b, 05c, 06');
  // Source-as-spec drafts 00b, 01 and 02 as one package and records them
  // together after one review, so 01 and 02 start once 00 is reviewed.
  // Completion still checks every package phase in order.
  if (!completing && config.preparationProfile === 'source-as-spec' && ['01', '02'].includes(phase)) { requirePhase(root, config, '00'); return; }
  if (index > 0) requirePhase(root, config, orderedPhases[Math.min(index - 1, 4)]);
}
export function startPhase(root, config, phase) {
  checkPreparation(root, config, phase);
  const value = { schemaVersion:1, phase, executionId:crypto.randomUUID(), startedAt:stamp(), foundation:foundation(root, config) };
  writeJSON(startPath(root, phase), value); return value;
}
// dryRun runs every check without writing. assumePredecessor skips the
// predecessor-receipt check when that predecessor is validated in the same
// dry run, so a multi-phase completion is checked whole before anything is written.
// Phase 02 reviews rules written for this project. The installed templates are
// nonempty, so an existence check alone would let them pass as reviewed rules.
function requireDraftedRules(root) {
  const read = rel => fs.readFileSync(safePath(root, rel), 'utf8');
  const template = rel => fs.readFileSync(path.join(pluginRoot, 'templates', rel), 'utf8');
  const rulebook = read('migration/RULEBOOK.md');
  if (rulebook === template('RULEBOOK.md') || /\[source language\]|\[target language\]/.test(rulebook)) throw new Error('migration/RULEBOOK.md is still the installed template (its [source language] / [target language] placeholders remain). Draft the project rules before phase 02 review');
  const examples = template('inventory.tsv').split(/\r?\n/).slice(2).filter(Boolean);
  const inventory = read('migration/inventory.tsv').split(/\r?\n/);
  if (examples.some(row => inventory.includes(row))) throw new Error('migration/inventory.tsv still contains the template example rows. Replace them with this project\'s sites before phase 02 review');
}
export function completePhase(root, config, phase, note, {tokens, subagents, model} = {}, {dryRun = false, assumePredecessor = false, confirmNoDependencies = false} = {}) {
  if (!note?.trim()) throw new Error('Phase completion requires a concrete review --note');
  if (!assumePredecessor) checkPreparation(root, config, phase, { completing: true });
  if (!manual.has(phase) && phase !== '05c' && phase !== '06') throw new Error('This phase is completed by current runner receipts, not manual confirmation');
  if (phase === '05c' && config.verificationMode !== 'source-only') throw new Error('Runtime parity requires actual runner validation');
  if (phase === '06' && config.verificationMode === 'source-only') throw new Error('Source-only phase 06 requires the handoff runner receipt');
  const old = currentPhase(root, config, phase);
  if (old) { if (old.cost && !dryRun) recordCost(root, old.cost); return old; }
  const evidence = artifacts(config, phase).map(p => {
    const f = safePath(root, p);
    if (!fileHash(f) || fs.statSync(f).size === 0) throw new Error(`Nonempty phase artifact required: ${p}`);
    return [p, fileHash(f)];
  });
  if (phase === '00b') {
    if (config.verificationMode === 'source-only') {
      const { plan, files } = sourceOnlyPlan(root, config);
      // A drafted contract skeleton is not a reviewed specification.
      // The TODO(spec) skeleton exists only in source-as-spec; other source-only
      // plans may legitimately contain the literal text.
      const unfilled = config.preparationProfile !== 'source-as-spec' ? [] : plan.scenarios.map(s => s.path).filter(p => fs.readFileSync(safePath(root, p), 'utf8').includes(specPlaceholder));
      if (unfilled.length) throw new Error(`Source-derived contracts still contain ${specPlaceholder}: ${unfilled.join(', ')}. Fill every item from cited source lines before phase 00b review`);
      evidence.push(...files);
    }
    else if (!config.commands?.original || !config.commands?.mutation || !config.commands?.parity || !config.verificationRoots.some(p => fs.existsSync(safePath(root,p)))) throw new Error('Prepare runtime judge inputs and original/mutation/parity commands before phase 00b review');
  }
  if (phase === '01') {
    const units = readManifest(root, config);
    if (!units.length) throw new Error('Manifest is empty');
    const graph = loadReviewDependencies(root, config);
    // An all-empty map usually means the parser ran from the wrong --root
    // (imports unresolved), which silently starves reviewers of dependency
    // sources. Independent files are possible, so the person can confirm it.
    if (units.length > 1 && Object.values(graph).every(deps => !deps.length) && !confirmNoDependencies) {
      throw new Error(`Review dependency map declares no dependencies between ${units.length} manifest files. This usually means the dependency parser ran from the wrong --root and could not resolve imports. Check migration/depmap/edges.tsv; if the files really are independent, record phase 01 with --confirm-no-dependencies`);
    }
  }
  if (phase === '02') requireDraftedRules(root);
  // The hashes validate their inputs too (e.g. review dependency declarations),
  // so a dry run computes them: a multi-phase package fails before any write.
  const judgeHash = phase === '00b' ? judgeInputHash(root, config) : null;
  const context = ['02','03','05c','06'].includes(phase) ? contextHash(root, config) : null;
  if (dryRun) return { phase, checked: true };
  const index = orderedPhases.indexOf(phase), finishedAt = stamp(), executionId = crypto.randomUUID();
  const start = fs.existsSync(startPath(root, phase)) ? readJSON(startPath(root, phase)) : null;
  const currentFoundation = foundation(root, config);
  const value = { schemaVersion:1, phase, executionId, note:note.trim(), completedAt:finishedAt, foundation:currentFoundation, evidence,
    ...(phase === '00b' ? { judgeInputHash: judgeHash } : {}),
    ...(manual.has(phase) && index > 0 ? { predecessorHash:fileHash(receiptPath(root, orderedPhases[index-1])) } : ['05c','06'].includes(phase) ? {predecessorHash:fileHash(receiptPath(root,'03'))} : {}),
    ...(context ? {contextHash:context} : {}),
    ...(phase === '05c' ? {outcome:'not-applicable',equivalence:'unverified'} : {}),
    ...(phase === '01' && confirmNoDependencies ? {confirmedNoDependencies:true} : {}) };
  if (manual.has(phase) || phase === '05c' || phase === '06') value.cost = costEvent({id:`phase-${executionId}`,step:phase,finishedAt,
    startedAt:start?.foundation === currentFoundation ? start.startedAt : null,tokens,subagents,model});
  writeJSON(receiptPath(root, phase), value);
  if (value.cost) recordCost(root, value.cost);
  return value;
}
