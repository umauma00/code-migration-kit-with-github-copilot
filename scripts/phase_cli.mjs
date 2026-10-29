// SPDX-License-Identifier: Apache-2.0
import { lockRun, contextHash, readManifest, done } from '../lib/core.mjs';
import { currentRecord, requireGate } from '../lib/pipeline.mjs';
import { initializePhases, checkPreparation, startPhase, completePhase, requirePhase, orderedPhases, currentPhase, phaseWaiver, gateError, waivePhase, phaseStaleness } from '../lib/phases.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { requireGuardrails } from '../lib/guardrails.mjs';
import { setupBlocker } from '../lib/run-settings.mjs';

function validate(root, config, phase, completing = false) {
  checkPreparation(root, config, phase, { completing });
  if (['00','00b','01','02'].includes(phase)) return;
  const context = contextHash(root, config);
  // Relaxed mode: a waiver of the phase a record completes stands in for it.
  const stagePhase = { judge: '03', build: '05', smoke: '05b', parity: '05c' };
  const record = stage => {
    if (!currentRecord(root, config, stage, context, stage !== 'judge')) {
      // A phase's own record is never stood in for by its own waiver.
      if (stagePhase[stage] !== phase && phaseWaiver(root, stagePhase[stage])) return;
      // Only the record itself completes its own phase; waiving it again would not help.
      throw gateError(root, `Run ${stage} successfully for current inputs before phase ${phase}`, stagePhase[stage] === phase ? null : stagePhase[stage]);
    }
    if (stage !== 'judge') requireGate(root, config, stage, context);
  };
  if (phase === '03' || phase === '04') record('judge');
  // Upstream: no stress test or fan-out until the human installed the denies.
  if ((phase === '03' || phase === '04') && !completing) requireGuardrails(root, phase);
  if (['05','05b','05c','06'].includes(phase)) {
    const units = readManifest(root, config);
    if ((!units.length || !units.every(u => done(root, u, context))) && !phaseWaiver(root, '04')) throw gateError(root, 'Current reviewed translation units are required', '04');
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
  if (action === 'check') {
    // A list checks a package (source-as-spec: 00b,01,02) the way phase
    // complete would record it: each phase in order, predecessors assumed.
    const ids = typeof phase === 'string' && phase.includes(',') ? phase.split(',').map(p => p.trim()) : [phase];
    if (ids.length > 1 && ids.some((id, i) => i && orderedPhases.indexOf(id) !== orderedPhases.indexOf(ids[i - 1]) + 1)) throw new Error('List consecutive phases in order, for example 00b,01,02');
    if (ids.length > 1 && ids.some(id => !['00','00b','01','02'].includes(id))) throw new Error('Only preparation phases 00 through 02 can be checked together');
    // In a source-as-spec package, 01 and 02 are checked for their own
    // evidence; their predecessors are recorded with them.
    const packaged = id => config.preparationProfile === 'source-as-spec' && ['01','02'].includes(id);
    ids.forEach((id, i) => {
      if (!i) validate(root,config,id);
      // A manually recorded phase is checked as phase complete would check it
      // (artifacts, drafted rules, dependency map), so "ready" is not followed
      // by a refused completion after the person has reviewed it.
      if (['00','00b','01','02','03'].includes(id)) completePhase(root,config,id,'check',{},{dryRun:true,assumePredecessor:i > 0 || packaged(id),confirmNoDependencies:Boolean(options['confirm-no-dependencies'])});
    });
    // A single packaged 01/02 is ready for its own evidence only; while an
    // earlier package phase is not current, say which phases record together.
    // The hint never fails the check: an unreadable receipt just omits it.
    let recordWith = {};
    if (ids.length === 1 && packaged(phase)) {
      try {
        const read = {}, unrecorded = ['00b','01','02'].filter(id => !currentPhase(root, config, id, read));
        if (unrecorded.includes(phase) && unrecorded[0] !== phase) recordWith = { recordWith: `phase complete ${unrecorded.join(',')}` };
      } catch {}
    }
    // A phase recorded before but out of date says what changed since.
    const staleness = id => { try { const s = phaseStaleness(root, config, id); return s ? { stale: s } : {}; } catch { return {}; } };
    return ids.length > 1 ? ids.map(id => ({phase:id,ready:true,...staleness(id)})) : {phase,ready:true,...recordWith,...staleness(phase)};
  }
  if (!['init','start','complete','waive'].includes(action)) throw new Error('Use phase init|next|check ID|start ID|complete ID --note TEXT|waive ID --note TEXT');
  const release = lockRun(root,`phase-${action}-${phase ?? 'policy'}`);
  try {
    if (action === 'init') return initializePhases(root);
    // The first phase record waits for setup to settle the verification
    // method (a phase out of order would end setup without it).
    if (['start','complete','waive'].includes(action)) { const blocker = setupBlocker(root, config); if (blocker) throw new Error(blocker); }
    // The person chose to proceed past an unfinished phase (relaxed mode).
    // What the phase still lacks is recorded with their reason.
    if (action === 'waive') {
      // A runner phase already done for real needs no waiver, whatever its
      // predecessors say now: its own done-condition is checked first.
      const own = { '04': 'units', '05': 'build', '05b': 'smoke', '05c': config.verificationMode === 'source-only' ? null : 'parity' }[phase];
      if (own) {
        let finished = false;
        try {
          const context = contextHash(root, config), units = readManifest(root, config);
          finished = own === 'units' ? units.length > 0 && units.every(u => done(root, u, context)) : Boolean(currentRecord(root, config, own, context, true));
        } catch {}
        if (finished) return { phase, waived: false, complete: true };
      }
      let unmet;
      try {
        validate(root, config, phase, true);
        if (['00','00b','01','02','03'].includes(phase)) completePhase(root, config, phase, 'check', {}, { dryRun: true });
        if (own) throw new Error(own === 'units' ? 'Current reviewed translation units are required' : `Run ${own} successfully for current inputs`);
      }
      catch (e) { unmet = e.message.replace(/ Relaxed mode(?: \(auto\))?: .*$/s, ''); }
      return waivePhase(root, config, phase, options.note, unmet);
    }
    // One reviewed note may cover consecutive phases (source-as-spec reviews
    // 00b–02 as one package). Each phase is still validated and recorded in
    // order, so a missing artifact stops the list at that phase.
    const ids = action === 'complete' && typeof phase === 'string' && phase.includes(',') ? phase.split(',').map(p => p.trim()) : [phase];
    if (ids.length > 1 && ids.some((id, i) => i && orderedPhases.indexOf(id) !== orderedPhases.indexOf(ids[i - 1]) + 1)) throw new Error('List consecutive phases in order, for example 00b,01,02');
    if (ids.length > 1 && ids.some(id => !['00','00b','01','02'].includes(id))) throw new Error('Only preparation phases 00 through 02 can be completed together');
    const confirmNoDependencies = Boolean(options['confirm-no-dependencies']);
    const usage = {tokens:usageNumber(options.tokens),subagents:usageNumber(options.subagents),model:options.model === 'unknown' ? undefined : options.model};
    if (action === 'start') { validate(root,config,phase); return startPhase(root,config,phase); }
    // All or nothing: check every listed phase before writing any receipt, so
    // one review note never records only part of a package.
    if (ids.length > 1) {
      validate(root,config,ids[0],true);
      ids.forEach((id, i) => completePhase(root,config,id,options.note,{},{dryRun:true,assumePredecessor:i > 0,confirmNoDependencies}));
    }
    const results = [];
    for (const id of ids) {
      validate(root,config,id,true);
      results.push(completePhase(root,config,id,options.note,ids.length > 1 && results.length ? {} : usage,{confirmNoDependencies}));
    }
    return ids.length > 1 ? results : results[0];
  } finally {release();}
}
