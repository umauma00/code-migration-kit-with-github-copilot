// SPDX-License-Identifier: Apache-2.0
import { lockRun, contextHash, readManifest, done } from '../lib/core.mjs';
import { currentRecord, requireGate } from '../lib/pipeline.mjs';
import { initializePhases, checkPreparation, startPhase, completePhase, requirePhase, orderedPhases } from '../lib/phases.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { requireGuardrails } from '../lib/guardrails.mjs';

function validate(root, config, phase, completing = false) {
  checkPreparation(root, config, phase);
  if (['00','00b','01','02'].includes(phase)) return;
  const context = contextHash(root, config);
  const record = stage => {
    if (!currentRecord(root, config, stage, context, stage !== 'judge')) throw new Error(`Run ${stage} successfully for current inputs before phase ${phase}`);
    if (stage !== 'judge') requireGate(root, config, stage, context);
  };
  if (phase === '03' || phase === '04') record('judge');
  // Upstream: no stress test or fan-out until the human installed the denies.
  if ((phase === '03' || phase === '04') && !completing) requireGuardrails(root, phase);
  if (['05','05b','05c','06'].includes(phase)) {
    const units = readManifest(root, config);
    if (!units.length || !units.every(u => done(root, u, context))) throw new Error('Current reviewed translation units are required');
    requireGate(root, config, 'translation', context);
  }
  if (phase === '05b') record('build');
  if (phase === '05c') record('smoke');
  if (phase === '06') {
    if (config.verificationMode === 'source-only') { record('smoke'); requirePhase(root,config,'05c'); }
    else { record('parity'); if (completing) requireGate(root,config,'post-parity',context); }
  }
}
const usageNumber = value => {
  if (value === undefined || value === 'unknown') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('tokens/subagents must be a nonnegative integer or unknown');
  return n;
};
export function phaseCommand(root, config, action, phase, options = {}) {
  if (action === 'next') {
    const report = migrationStatus(root);
    if (!report.ok) throw new Error(report.blockers[0].reason);
    return report.workflow;
  }
  if (action === 'check') { validate(root,config,phase); return {phase,ready:true}; }
  if (!['init','start','complete'].includes(action)) throw new Error('Use phase init|next|check ID|start ID|complete ID --note TEXT');
  const release = lockRun(root,`phase-${action}-${phase ?? 'policy'}`);
  try {
    if (action === 'init') return initializePhases(root);
    // One reviewed note may cover consecutive phases (source-as-spec reviews
    // 00b–02 as one package). Each phase is still validated and recorded in
    // order, so a missing artifact stops the list at that phase.
    const ids = action === 'complete' && typeof phase === 'string' && phase.includes(',') ? phase.split(',').map(p => p.trim()) : [phase];
    if (ids.length > 1 && ids.some((id, i) => i && orderedPhases.indexOf(id) !== orderedPhases.indexOf(ids[i - 1]) + 1)) throw new Error('List consecutive phases in order, for example 00b,01,02');
    if (ids.length > 1 && ids.some(id => !['00','00b','01','02'].includes(id))) throw new Error('Only preparation phases 00 through 02 can be completed together');
    const usage = {tokens:usageNumber(options.tokens),subagents:usageNumber(options.subagents),model:options.model === 'unknown' ? undefined : options.model};
    if (action === 'start') { validate(root,config,phase); return startPhase(root,config,phase); }
    // All or nothing: check every listed phase before writing any receipt, so
    // one review note never records only part of a package.
    if (ids.length > 1) {
      validate(root,config,ids[0],true);
      ids.forEach((id, i) => completePhase(root,config,id,options.note,{},{dryRun:true,assumePredecessor:i > 0}));
    }
    const results = [];
    for (const id of ids) {
      validate(root,config,id,true);
      results.push(completePhase(root,config,id,options.note,ids.length > 1 && results.length ? {} : usage));
    }
    return ids.length > 1 ? results : results[0];
  } finally {release();}
}
