// SPDX-License-Identifier: Apache-2.0
import { lockRun, contextHash, readManifest, done } from '../lib/core.mjs';
import { currentRecord, requireGate } from '../lib/pipeline.mjs';
import { initializePhases, checkPreparation, startPhase, completePhase, requirePhase } from '../lib/phases.mjs';
import { migrationStatus } from '../lib/status.mjs';

function validate(root, config, phase, completing = false) {
  checkPreparation(root, config, phase);
  if (['00','00b','01','02'].includes(phase)) return;
  const context = contextHash(root, config);
  const record = stage => {
    if (!currentRecord(root, config, stage, context, stage !== 'judge')) throw new Error(`Run ${stage} successfully for current inputs before phase ${phase}`);
    if (stage !== 'judge') requireGate(root, config, stage, context);
  };
  if (phase === '03' || phase === '04') record('judge');
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
    validate(root,config,phase,action === 'complete');
    if (action === 'start') return startPhase(root,config,phase);
    return completePhase(root,config,phase,options.note,{
      tokens:usageNumber(options.tokens),subagents:usageNumber(options.subagents),model:options.model === 'unknown' ? undefined : options.model
    });
  } finally {release();}
}
