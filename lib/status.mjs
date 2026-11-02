// SPDX-License-Identifier: Apache-2.0
// Read-only evidence projection. Status never approves, repairs, or dispatches.
import fs from 'node:fs';
import { pendingRegeneration } from './generated.mjs';
import { loadConfig, safePath, pathMemo, readJSON, fileHash, contextHash, requiredInputRoots, missingRootMessage, readManifest, done, reviewDependencyPath, readRepairIntent, activeBuildLoop, lockOwnerState } from './core.mjs';
import { currentRecord, requireGate } from './pipeline.mjs';
import { strictPhases, currentPhase, orderedPhases, relaxedPhases, autoPhases, activeWaivers, phaseStaleness } from './phases.mjs';
import { autoModeReport } from './preferences.mjs';
import { executionPurpose, requirePilot } from './pilot.mjs';
import { surveyProgress } from './status-snapshot.mjs';
import { runSettingsState } from './run-settings.mjs';
import { isHostStall, isCliLock } from './failures.mjs';

export const macroStages = [
  { id: 1, name: 'Map and rules', phases: ['01', '02'] }, { id: 2, name: 'Rule stress test', phases: ['03'] },
  { id: 3, name: 'Translation', phases: ['04'] }, { id: 4, name: 'Compile', phases: ['05'] },
  { id: 5, name: 'Start', phases: ['05b'] }, { id: 6, name: 'Behavioral equivalence', phases: ['05c'] }
];

export const phaseNames = [
  ['00', 'Feasibility'], ['00b', 'Judge preparation'], ['01', 'Dependencies and rules'],
  ['02', 'Gap inventory'], ['03', 'Prototype'], ['04', 'Implementation'],
  ['05', 'Build'], ['05b', 'Smoke'], ['05c', 'Parity'], ['06', 'Handoff']
];
// Remaining time, calls and prompt bytes extrapolated from runs that finished
// units. Wall time already reflects the concurrency of those runs.
function remainingEstimate(root, remaining) {
  if (!remaining) return 'none remaining';
  let units = 0, minutes = 0, calls = 0, bytes = 0, runs = 0;
  try {
    const dir = safePath(root, 'migration/runs');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      let s;
      try { const file = safePath(root, `migration/runs/${name}/summary.json`); if (!fs.existsSync(file)) continue; s = readJSON(file); } catch { continue; }
      const wall = (Date.parse(s?.finishedAt) - Date.parse(s?.startedAt)) / 60000;
      if (!(s?.unitsCompleted > 0) || !(wall >= 0)) continue;
      units += s.unitsCompleted; minutes += wall; calls += s.agentCalls ?? 0; bytes += s.usageEstimate?.promptBytes ?? 0; runs++;
    }
  } catch { return 'not calculated'; }
  if (!units) return 'not calculated';
  return { remainingUnits: remaining, minutes: Math.round(remaining * minutes / units * 10) / 10, agentCalls: Math.ceil(remaining * calls / units),
    promptBytes: Math.ceil(remaining * bytes / units), basis: `estimate from ${units} units completed in ${runs} runs` };
}
// What the current phase is waiting for, so "in progress" is never ambiguous.
function currentPhaseState(root, config, report, id, { stages, approved, activeStages, context }) {
  if (report.running && report.survey && { facts: '00', contracts: '00b', inventory: '02' }[report.survey.kind] === id) return 'running';
  const lockPhase = { translation: '04', repair: '05', build: '05', smoke: '05b', parity: '05c', handoff: '06', judge: '03' }[report.lock?.task];
  if (report.running && (lockPhase === id || (id === '04' && report.lock?.task === 'repair'))) return 'running';
  const exists = p => { try { const f = safePath(root, p); return fs.existsSync(f) && fs.statSync(f).size > 0; } catch { return false; } };
  const manual = { '00': ['migration/feasibility.md'], '00b': ['migration/judge-report.md'], '01': ['migration/depmap/report.md', 'migration/manifest.tsv'],
    '02': ['migration/gap-report.md'], '03': ['migration/stress-test/report.md'] }[id];
  if (manual) return manual.every(exists) ? 'awaiting-review' : exists(`migration/phases/starts/${id}.json`) ? 'in-work' : 'not-started';
  const gate = stage => { try { if (!context) return false; requireGate(root, config, stage, context); return true; } catch { return false; } };
  if (id === '04') return !approved ? 'awaiting-approval' : report.units.some(u => u.status === 'blocked') ? 'blocked' : 'ready';
  const stage = { '05': 'build', '05b': 'smoke', '05c': report.verificationMode === 'source-only' ? null : 'parity', '06': report.verificationMode === 'source-only' ? 'handoff' : 'post-parity' }[id];
  if (!stage) return 'awaiting-review';
  if (activeStages.has(stage)) return 'running';
  if (!gate(stage)) return 'awaiting-approval';
  const result = `migration/results/${stage}.json`;
  if (stage !== 'post-parity' && exists(result) && !stages[stage]) return 'failed';
  return 'ready';
}
export function migrationStatus(root) {
  const report = { ok: true, done: 0, total: 0, units: [], verificationMode: null, equivalence: 'unverified',
    running: false, lock: null, blockers: [], nextActions: [], phases: [], remaining: 0, timeEstimate: 'not calculated' };
  const issue = (path, reason, action) => { if (report.blockers.some(b => b.path === path && b.reason === reason)) return; report.blockers.push({ path, reason }); report.nextActions.push(action); };
  let config;
  try { config = loadConfig(root); report.verificationMode = config.verificationMode ?? 'runtime'; }
  catch (e) { report.ok = false; issue('migration/config.json', e.message, 'Correct migration/config.json and run status again'); return report; }
  report.purpose = executionPurpose(config);
  try { report.runSettings = runSettingsState(root, config); } catch (e) { report.runSettings = { state: 'invalid', file: 'migration/run-settings.json', reason: e.message }; }
  let pilot = null, parentStale = null;
  // The parent's 02 went out of date (often a note added to a report): the
  // parent is brought up to date as its phase next says, and if removing the
  // note does it, this pilot works again without a new one.
  const fixParent = parent => `Bring the parent project ${parent} up to date as phase next --root "${parent}" says (if it says to remove a note added to a report, that keeps this pilot), then check this status again; do not alter this pilot's sealed inputs`;
  if (report.purpose === 'pilot') { try { pilot = requirePilot(root, config); } catch (e) { if (e.code === 'pilot-parent-stale') parentStale = e.parentRoot; issue('migration/pilot.json', e.message, parentStale ? fixParent(parentStale) : 'Prepare a new authorized pilot; do not alter its sealed inputs'); } }
  const lockFile = safePath(root, 'migration/run.lock');
  if (fs.existsSync(lockFile)) {
    try {
      report.lock = readJSON(lockFile);
      if (!Number.isInteger(report.lock.pid) || report.lock.pid < 1) throw new Error('Invalid lock owner PID');
      const state = lockOwnerState(report.lock);
      if (state === 'alive') report.running = true;
      else if (state === 'foreign') {
        report.foreignLock = { pid: report.lock.pid, host: report.lock.host, note: 'Written on another host; this host cannot tell whether it still runs.' };
        issue('migration/run.lock', `Lock held by pid ${report.lock.pid} on host ${report.lock.host}; this host cannot check it`, `Once that run has stopped, run unlock --pid ${report.lock.pid}`);
      } else report.staleLock = { pid: report.lock.pid, note: 'The owner has stopped; the next runner command removes this lock automatically.' };
    } catch (e) { issue('migration/run.lock', e.message, 'Inspect the lock without assuming a running migration'); }
  }
  report.survey = surveyProgress(root, report.lock);
  const artifactNames = ['migration/feasibility.md', 'migration/judge-report.md', 'migration/RULEBOOK.md',
    reviewDependencyPath(config), 'migration/inventory.tsv', 'migration/manifest.tsv',
    ...(report.purpose === 'pilot' ? ['migration/pilot.json'] : ['migration/stress-test/report.md'])];
  report.artifacts = artifactNames.map(p => {
    try { const h = fileHash(safePath(root, p)); return { path: p, status: h && fs.statSync(safePath(root, p)).size > 0 ? 'candidate' : 'missing' }; }
    catch (e) { issue(p, e.message, `Correct ${p}`); return { path: p, status: 'invalid' }; }
  });
  // status only reads: one memo spares re-checking the same parent directories per unit.
  const memo = pathMemo();
  let context = null, units = [], contextError = null;
  try { context = contextHash(root, config); }
  catch (e) { contextError = e.message; }
  try { if (fs.existsSync(safePath(root, 'migration/manifest.tsv'))) {
    units = readManifest(root, config, undefined, memo);
    if (!units.length) issue('migration/manifest.tsv', 'Manifest is empty; translation requires at least one unit', 'Populate and audit the manifest before judge and translation approval');
  } }
  catch (e) { issue('migration/manifest.tsv', e.message, 'Correct the manifest before translation'); }
  report.total = units.length;
  const attempts = [];
  if (report.running && report.lock.runId) {
    const directory = `migration/runs/${report.lock.runId}`;
    try {
      const full = safePath(root, directory);
      for (const name of fs.existsSync(full) ? fs.readdirSync(full) : []) {
        // Coordinator attempt files live directly under the run. Do not parse
        // other files (summaries, worker answers) here.
        if (!/^[a-f0-9]{24}-\d+-(?:implementer|reviewer-semantics|reviewer-rules|arbiter|fixer)-[a-f0-9]{8}\.json$/.test(name)) continue;
        const p = `${directory}/${name}`;
        try {
          const r = readJSON(safePath(root, p));
          if (r?.status === 'running' && r.unit?.id && typeof r.role === 'string') attempts.push({ ...r, path: p });
        } catch (e) { issue(p, e.message, 'Inspect the coordinator attempt record'); }
      }
    } catch (e) { issue(directory, e.message, 'Inspect current run records'); }
  }
  report.units = units.map(u => {
    let state = null, invalidState = null;
    const receipt = `migration/state/units/${u.id}.json`;
    try { const file = safePath(root, receipt, memo); if (fs.existsSync(file)) state = readJSON(file); }
    catch (e) { invalidState = e.message; issue(receipt, e.message, 'Inspect corrupt unit state and rerun translate for fresh review'); }
    const complete = context && done(root, u, context);
    const current = state?.contextHash === context && state?.outputHash === fileHash(safePath(root, u.target, memo));
    const active = report.running && state?.runId === report.lock.runId && current;
    // A running attempt with recorded retries is waiting out a transient failure
    // (rate limit, 5xx, network); the person should hear that, not just silence.
    const calls = active ? attempts.filter(a => a.unit.id === u.id).map(a => ({ role: a.role, path: a.path,
      ...(Array.isArray(a.retries) && a.retries.length ? { retries: a.retries.length, lastRetryError: String(a.retries.at(-1)?.error ?? '').slice(0, 300), ...(a.retries.at(-1)?.hostStall ? { hostStall: true } : {}), ...(a.retries.at(-1)?.cliLock ? { cliLock: true } : {}) } : {}) })) : [];
    const status = complete ? 'done' : invalidState || (current && state?.status === 'blocked') ? 'blocked' : active && state.status === 'validating' ? 'validating' : active && state.stage !== 'done' ? state.stage : state ? 'stopped' : 'pending';
    return { source: u.source, target: u.target, status, stage: state?.stage ?? 'implement',
      activeRoles: calls, reason: complete ? null : invalidState ?? (!current && state ? 'Receipt stale; inputs or outputs changed' : state?.error ?? (state && !active ? 'Receipt incomplete; rerun translate after checking approvals' : null)),
      receipt: state ? `migration/state/units/${u.id}.json` : null };
  });
  report.done = report.units.filter(u => u.status === 'done').length;
  const retrying = report.units.flatMap(u => u.activeRoles.filter(a => a.retries).map(a => ({ target: u.target, ...a })));
  if (retrying.length) {
    report.retrying = retrying;
    const rate = /rate_limit|\b429\b|rate.?limit/i.test(retrying.map(r => r.lastRetryError).join(' ')), stall = !rate && retrying.some(r => r.hostStall || isHostStall(r.lastRetryError));
    const lock = !rate && !stall && retrying.some(r => r.cliLock || isCliLock(r.lastRetryError));
    report.nextActions.push(`${retrying.length} worker call(s) are being retried after a transient failure (${rate ? 'rate limit' : stall ? 'the Copilot CLI\'s internal event wait' : lock ? 'a lock inside the Copilot CLI that another Copilot process may hold' : 'service or network error'}); the runner waits and retries automatically. Tell the person; if it persists, ${lock ? 'check for a Copilot CLI left from an earlier run (stop only the ones the runner started)' : 'consider lowering concurrency after the run'}`);
  }
  report.remaining = report.total - report.done;
  report.timeEstimate = report.total ? remainingEstimate(root, report.remaining) : 'not calculated';
  try {
    const repair = context ? readRepairIntent(root, context) : null;
    if (repair) {
      report.repairIntentId = repair.id;
      report.pendingRepairs = repair.jobs.filter(j => report.units.find(u => u.target === j.target)?.status !== 'done').map(j => j.target);
      if (report.pendingRepairs.length) issue('migration/state/repair.json', 'Admitted repair jobs remain unreviewed', 'Resume translate within the current approval to review every frozen repair diagnostic before build');
    }
  } catch (e) { issue('migration/state/repair.json', e.message, 'Inspect and restore the repair reference and immutable receipt; do not discard unfinished jobs'); }
  const stages = {}, activeStages = new Set();
  for (const stage of ['judge', 'build', 'smoke', 'parity', 'handoff']) {
    try {
      stages[stage] = context ? currentRecord(root, config, stage, context, stage !== 'judge') : false;
      if (stages[stage] && stage !== 'judge') requireGate(root, config, stage, context);
    }
    catch (e) { stages[stage] = false; issue(`migration/results/${stage}.json`, e.message, `Correct inputs and rerun ${stage}`); }
    const p = `migration/results/${stage}.json`;
    if (!stages[stage] && fs.existsSync(safePath(root, p))) {
      try {
        const r = readJSON(safePath(root, p));
        if (report.running && report.lock.task === stage && report.lock.runId === r?.executionId &&
            r.stage === stage && context && r.contextHash === context && !r.finishedAt && !r.invalidatedAt && r.success === false) {
          activeStages.add(stage);
        } else issue(p, r?.error ?? 'Receipt incomplete, stale or invalidated', `Review ${p} before rerunning ${stage}`);
      }
      catch (e) { issue(p, e.message, `Correct or rerun ${stage}`); }
    }
  }
  const missingArtifacts = report.artifacts.filter(a => a.status === 'missing' && !(a.path === 'migration/judge-report.md' && stages.judge));
  let approved = false, approval;
  if (context) { try { approval = requireGate(root, config, 'translation', context); approved = true; } catch (e) { issue('migration/gates/translation.json', e.message, report.purpose === 'pilot' ? 'Run the authorized isolated pilot' : 'Review feasibility, prototype and judge evidence; approve translation with a concrete note'); } }
  report.approvedTargets = approval?.targets ?? (approved ? units.map(u => u.target) : []);
  report.approvedScopeRemaining = report.units.filter(u => report.approvedTargets.includes(u.target) && u.status !== 'done').length;
  if (!stages.judge && !activeStages.has('judge')) report.nextActions.push(report.verificationMode === 'source-only' ? 'Prepare migration/judge-plan.json; run judge after 01/02 (equivalence remains unverified)' : 'Configure original/mutation and run judge after 01/02');
  report.implementationReady = Boolean(context && units.length && approved && stages.judge);
  report.equivalence = stages.parity && report.verificationMode === 'runtime' ? 'verified' : 'unverified';
  let postParityApproved = false;
  if (report.purpose !== 'pilot' && report.verificationMode === 'runtime' && stages.parity) {
    try { requireGate(root, config, 'post-parity', context); postParityApproved = true; }
    catch (e) { issue('migration/gates/post-parity.json', e.message, 'Review current parity evidence; approve post-parity with a concrete note, then follow prompt 06'); }
  }
  const candidates = p => report.artifacts.find(a => a.path === p)?.status === 'candidate';
  const states = [candidates('migration/feasibility.md') ? 'candidate' : 'pending', activeStages.has('judge') ? 'running' : stages.judge ? 'validated' : candidates('migration/judge-report.md') ? 'candidate' : 'pending',
    candidates('migration/RULEBOOK.md') && candidates(reviewDependencyPath(config)) ? 'candidate' : 'pending',
    candidates('migration/inventory.tsv') ? 'candidate' : 'pending', candidates('migration/stress-test/report.md') ? 'candidate' : 'pending',
    report.total && report.done === report.total ? 'reviewed' : report.running && ['translation', 'repair'].includes(report.lock?.task) ? 'running' : 'pending',
    activeStages.has('build') ? 'running' : stages.build ? 'validated' : 'pending', activeStages.has('smoke') ? 'running' : stages.smoke ? 'validated' : 'pending',
    report.verificationMode === 'source-only' ? 'unverified (not run in this mode)' : activeStages.has('parity') ? 'running' : stages.parity ? 'validated' : 'pending', report.verificationMode === 'runtime' ? (postParityApproved ? 'approved (cleanup completion unconfirmed)' : 'pending') : activeStages.has('handoff') ? 'running' : stages.handoff ? 'validated' : 'pending'];
  report.phases = phaseNames.map(([id, name], i) => ({ id, name: id === '06' && report.verificationMode === 'runtime' ? 'Post-parity cleanup' : name, status: states[i] }));
  const activeTranslation = report.running && ['translation', 'repair'].includes(report.lock?.task);
  // Generated files to regenerate in the target are not translation units.
  try { report.regeneration = pendingRegeneration(root, config); } catch (e) { report.regeneration = []; issue('migration/generated-files.json', e.message, 'Correct migration/generated-files.json (rerun generated-files --write)'); }
  if (report.regeneration.length) {
    const implementation = report.phases.find(p => p.id === '04');
    if (implementation.status === 'reviewed') implementation.status = 'pending';
    report.nextActions.push(`Regenerate ${report.regeneration.length} generated file(s) with the target generator before build approval (${report.regeneration.slice(0, 3).map(e => `${e.target} from ${e.input}: ${e.how}`).join('; ')}); if a generator cannot run, switch the file back with generated-files --translate FILE`);
  }
  if (report.implementationReady && report.done < report.total && !activeTranslation) report.nextActions.push(report.approvedScopeRemaining
    ? 'Run or resume translate; inspect blocked unit receipts first' : 'Review the completed batch; obtain approval for the next explicit translation batch');
  if (report.total && report.done === report.total && !activeTranslation && !report.regeneration.length) {
    const next = !stages.build ? 'build' : !stages.smoke ? 'smoke' : report.verificationMode === 'source-only' ? (!stages.handoff ? 'handoff' : null) : (!stages.parity ? 'parity' : 'post-parity');
    if (next === 'post-parity' && postParityApproved) report.nextActions.push('Perform the approved prompt 06 cleanup and report the results; completion is unconfirmed');
    else if (next && !activeStages.has(next)) report.nextActions.push(`Review current evidence; approve ${next} with a concrete note${next === 'post-parity' ? ', then follow prompt 06' : ` and run ${next}`}`);
  }
  if (activeTranslation) report.nextActions.push('Monitor the active translation/repair runner; wait for completion before rerunning or approving the next stage');
  if (activeStages.size) report.nextActions.push(`Monitor the active ${[...activeStages].join(', ')} stage; review its receipt after the runner finishes`);
  const phaseReceipts = {};
  // One read-only report shares its source fingerprint across the predecessor
  // chains. Never retain this cache across commands or pass it to mutations.
  const phaseRead = { contextKnown: true, context };
  let strict = false;
  try { strict = strictPhases(root,config); } catch(e) {report.ok=false;issue('migration/phases/policy.json',e.message,'Correct the phase policy record');}
  for (const id of ['00','00b','01','02','03','05c','06']) {
    try {phaseReceipts[id]=currentPhase(root,config,id,phaseRead);} catch(e) {phaseReceipts[id]=false;issue(`migration/phases/${id}.json`,e.message,`Review phase ${id} evidence and record its completion again`);}
  }
  const workflowDone = { ...phaseReceipts, '04':Boolean(report.total && report.done===report.total && approved && !report.regeneration.length),
    '05':Boolean(stages.build), '05b':Boolean(stages.smoke),
    '05c':report.verificationMode==='source-only' ? Boolean(phaseReceipts['05c']) : Boolean(stages.parity),
    '06':report.verificationMode==='source-only' ? Boolean(stages.handoff) : Boolean(phaseReceipts['06'] && postParityApproved) };
  // Relaxed mode: a waived phase stays incomplete (never counted done) but is
  // not the next phase either; the person chose to proceed past it.
  const relaxed = report.purpose !== 'pilot' && relaxedPhases(root), waivers = relaxed ? activeWaivers(root, workflowDone) : [];
  const waived = new Set(waivers.map(w => w.phase));
  const nextPhase = orderedPhases.find(id => !workflowDone[id] && !waived.has(id)) ?? null;
  // Artifacts and inputs that the current or a later phase produces are work
  // still to do, not blockers: a status read during 00b must not present the
  // manifest that 01 writes as a problem for the person (strict policy only;
  // its phase records say which phase is current).
  const preparing = strict && ['00', '00b', '01', '02'].includes(nextPhase);
  if (contextError) {
    // Only "not produced yet" is pending; a wrong root or an invalid file
    // still needs fixing and stays a blocker.
    const notYet = /^(?:Required artifact missing|Required review dependency map missing|Review dependency declaration missing)|ENOENT/.test(contextError);
    // Before intake (00) is recorded the roots may still be being set up.
    const rootsUnsettled = nextPhase === '00' && /^Input root missing/.test(contextError);
    if (preparing && (notYet || rootsUnsettled)) {
      report.inputsPending = contextError;
      // The hash stops at the first missing artifact, so a missing root
      // (which the project must supply) is checked on its own here, once
      // intake (00) is recorded and the roots are meant to be settled.
      if (nextPhase !== '00') for (const dir of requiredInputRoots(config)) {
        if (!fs.existsSync(safePath(root, dir))) issue('migration inputs', missingRootMessage(config, dir, 'Input root missing'), 'Create the root or correct sourceRoots/verificationRoots in migration/config.json');
      }
    } else issue('migration inputs', contextError, 'Prepare or correct the required inputs, then run judge');
  }
  if (strict && nextPhase) report.pendingArtifacts = missingArtifacts.map(a => a.path);
  else for (const a of missingArtifacts) issue(a.path, 'Preparation artifact missing', `Prepare and review ${a.path}`);
  report.workflow={policy:strict ? 'strict' : 'legacy',...(relaxed ? {mode:autoPhases(root) ? 'auto' : 'relaxed'} : {}),done:orderedPhases.filter(id=>workflowDone[id]).length,total:10,next:nextPhase,
    phases:orderedPhases.map(id=>({id,complete:Boolean(workflowDone[id]),...(waived.has(id) ? {waived:true} : {})}))};
  // Every phase still waived is listed for the person and the final handoff report.
  if (relaxed) report.waivers = waivers;
  // Auto mode: since when, and every record made without the person.
  const auto = report.purpose !== 'pilot' && autoModeReport(root);
  if (auto) report.autoMode = auto;
  report.macroStages = macroStages.map(s => ({ ...s, complete: s.phases.every(id => workflowDone[id]),
    ...(s.id === 6 && report.verificationMode === 'source-only' ? { equivalence: 'unverified' } : {}) }));
  if (report.purpose === 'pilot') {
    const ids = ['04', '05', '05b', '05c'].slice(0, ['translation', 'build', 'smoke', 'parity'].indexOf(pilot?.through ?? 'translation') + 1);
    report.workflow = { policy: 'isolated-pilot', done: ids.filter(id => workflowDone[id]).length, total: ids.length,
      next: ids.find(id => !workflowDone[id]) ?? null, phases: ids.map(id => ({ id, complete: Boolean(workflowDone[id]) })) };
    report.phases = report.phases.filter(p => ids.includes(p.id));
    report.nextActions = report.running ? report.nextActions.filter(a => a.startsWith('Monitor')) : [pilot ? 'Run or resume pilot run within its existing authorization; archive the trial report and discard the workspace when reviewed' : parentStale ? fixParent(parentStale) : 'Prepare a new authorized pilot'];
    report.outcome = 'Disposable pilot; production completion unconfirmed';
  } else if (strict) {
    for (const p of report.phases) if (['00','00b','01','02','03'].includes(p.id)) p.status=phaseReceipts[p.id] ? 'reviewed' : 'pending review';
    if (phaseReceipts['06'] && report.verificationMode==='runtime' && postParityApproved) report.phases.find(p=>p.id==='06').status='reviewed';
    if (nextPhase && ['00','00b','01','02','03'].includes(nextPhase)) report.nextActions=report.nextActions.filter(a=>/^(Correct|Inspect|Check)/.test(a));
    // A phase recorded earlier but out of date: say what changed and whether
    // anything must be redone, instead of sending the host back into the phase.
    let stale = null;
    if (nextPhase && ['00','00b','01','02','03','05c','06'].includes(nextPhase)) {
      try { stale = phaseStaleness(root, config, nextPhase, phaseRead); } catch {}
      if (stale) report.workflow.stale = stale;
    }
    if (stale && !report.running) report.nextActions.unshift(stale.next);
    else if (nextPhase && !report.running) report.nextActions.unshift(`Follow phase ${nextPhase}; run phase start ${nextPhase} before work and follow its prompt${nextPhase === '03' ? ' and the one-page checklist docs/STRESS-TEST-CHECKLIST.md' : ''}. Phase completion needs reviewed evidence, not an existing template.`);
  }
  // The state belongs to the final current phase: a pilot replaces the workflow
  // with its own phases above, so it is computed only now.
  report.currentState = report.workflow.next ? currentPhaseState(root, config, report, report.workflow.next, { stages, approved, activeStages, context }) : null;
  // Between its steps a build-loop holds no lock; its grant shows it is running.
  try {
    const loop = activeBuildLoop(root);
    if (loop) {
      report.buildLoop = loop;
      report.nextActions.unshift(`build-loop ${loop.id} is running (${loop.stage}; ${loop.rounds}/${loop.maxRounds ?? '∞'} builds, ${loop.agentCalls}/${loop.maxCalls ?? '∞'} AI calls; pid ${loop.pid}). Keep polling status and start no other runner command until it reports its result`);
      if (loop.stalled) report.nextActions.splice(1, 0, `build-loop: the ${loop.stalled.stage} error count has not fallen since round ${loop.stalled.sinceRound}. The loop keeps running; ${loop.stalled.next}`);
    }
  } catch (e) { issue('migration/gates', e.message, 'Inspect the build-loop grant files'); }
  report.nextActions = [...new Set(report.nextActions)];
  if (stages.handoff) report.outcome = 'Source-based migration complete; behavioral equivalence unverified';
  return report;
}
// Labels follow migration/preferences.json; machine values (IDs, statuses,
// reasons) stay as recorded so they remain greppable across languages.
const labels = {
  en: { verification: 'Verification', equivalence: 'equivalence', invalid: 'invalid configuration', reviewed: 'Reviewed units', remaining: 'remaining',
    noTime: 'time not calculated', workflow: 'Workflow', policy: 'policy', next: 'next', complete: 'complete', waivedOnly: 'none; only waived phases remain unfinished', purpose: 'Purpose',
    production: 'production', stages: 'Major stages', unverified: 'unverified', pending: 'pending', runner: 'Runner', active: 'active',
    noRun: 'no run ID', stopped: 'stopped', start: 'Implementation start', approved: 'approved for current inputs', blocked: 'blocked or awaiting review',
    waivers: 'Waived phases (relaxed mode; still unfinished)', autoOn: 'Auto mode: on (phase gates run without asking the person; upstream rule 3 is not followed)', since: 'since', autoRecords: 'Recorded by auto mode without the person\'s review', rulebookUnchecked: 'Warning: RULEBOOK changes auto mode accepted without knowing which finished files they affect (that code may still follow the old rule)', autoWaiver: 'auto', autoUnrecorded: 'Auto mode is chosen in migration/preferences.json but has no record (migration/phases/auto-mode.json), so it is not in effect and gates ask as in relaxed mode; choose it with preferences --phase-mode auto', unmet: 'missing', blocker: 'Blocker', notYet: 'Not written yet (produced by the current or a later phase; not a problem)', nextAction: 'Next', retrying: 'retrying after a transient failure, attempt', buildLoop: 'Build loop',
    runSettings: 'Run settings (migration/run-settings.json)', runSettingsStates: { applied: 'matches the configuration', differs: 'changed and not applied yet; run settings apply', unfilled: 'not filled in yet', invalid: 'not valid JSON' } },
  ja: { verification: '検証方式', equivalence: '同等性', invalid: '設定が不正', reviewed: 'レビュー済み単位', remaining: '残り',
    noTime: '所要時間は未計算', workflow: '工程', policy: '方針', next: '次', complete: '完了', waivedOnly: 'なし（見送った工程だけが未完了）', purpose: '目的',
    production: '本番', stages: '主要段階', unverified: '未検証', pending: '未完了', runner: 'runner', active: '実行中',
    noRun: '実行IDなし', stopped: '停止中', start: '実装の開始', approved: '現在の入力で承認済み', blocked: '停止中またはレビュー待ち',
    waivers: '見送った工程（緩和モード。未完了のまま）', autoOn: '自動モード：オン（工程の関門を人に聞かずに進めます。上流の規則3には従いません）', since: '開始', autoRecords: '自動モードが人の確認なしで記録したもの', rulebookUnchecked: '警告：自動モードが、影響する完了済みファイルを判断できないまま受け入れたルールの変更（その部分のコードは古いルールのままの可能性があります）', autoWaiver: '自動', autoUnrecorded: 'migration/preferences.json で自動モードが選ばれていますが、記録（migration/phases/auto-mode.json）がないため無効です。関門は緩和モードと同じく確認します。preferences --phase-mode auto で選び直してください', unmet: '不足', blocker: '阻害要因', notYet: '未作成（現在または後の工程で作るもの。問題ではありません）', nextAction: '次の操作', retrying: '一時的な失敗（レート制限等）のため再試行中・回数', buildLoop: 'ビルド修正ループ',
    runSettings: '実行設定（migration/run-settings.json）', runSettingsStates: { applied: '設定に反映済み', differs: '未反映の変更あり。settings apply で反映してください', unfilled: '未記入の項目あり', invalid: 'JSON として読めません' } }
};
export function statusMarkdown(report, language = 'en') {
  const L = labels[language] ?? labels.en, sep = language === 'ja' ? '。' : '.';
  return [...(report.recordedOnly ? [language === 'ja' ? '記録に基づく軽量表示です。入力・承認の有効性は未再検証です。' : 'Fast recorded progress only; inputs and approvals have not been revalidated.'] : []),
    `${L.verification}: ${report.verificationMode ?? L.invalid}; ${L.equivalence}: ${report.equivalence}${sep}`,
    `${L.reviewed}: ${report.done}/${report.total}; ${L.remaining}: ${report.remaining}; ${typeof report.timeEstimate === 'object'
      ? (language === 'ja' ? `残りの目安：約${report.timeEstimate.minutes}分・AI呼び出し約${report.timeEstimate.agentCalls}回・入力約${Math.ceil(report.timeEstimate.promptBytes / 1024)}KB（${report.timeEstimate.basis.replace(/estimate from (\d+) units completed in (\d+) runs/, '$2回の実行で完了した$1単位からの推定')}）`
        : `estimate for the rest: about ${report.timeEstimate.minutes} min, ${report.timeEstimate.agentCalls} AI calls, ${Math.ceil(report.timeEstimate.promptBytes / 1024)} KB of input (${report.timeEstimate.basis})`)
      : report.timeEstimate === 'none remaining' ? (language === 'ja' ? '残りなし' : 'nothing remaining') : L.noTime}${sep}`,
    ...(report.workflow ? [`${L.workflow}: ${report.workflow.done}/${report.workflow.total}; ${L.policy}: ${report.workflow.policy}; ${L.next}: ${report.workflow.next ?? (report.waivers?.length ? L.waivedOnly : L.complete)}${sep}`] : []),
    `${L.purpose}: ${report.purpose ?? L.production}${sep}`,
    ...(report.runSettings ? [`${L.runSettings}: ${L.runSettingsStates[report.runSettings.state]}${report.runSettings.differs ? ` (${report.runSettings.differs.join(', ')})` : report.runSettings.pending ? ` (${report.runSettings.pending.join(', ')})` : ''}${sep}`] : []),
    ...(report.macroStages && report.purpose !== 'pilot' ? [`${L.stages}: ${report.macroStages.map(s => `${s.id} ${s.name}: ${s.equivalence === 'unverified' ? L.unverified : s.complete ? L.complete : L.pending}`).join('; ')}${sep}`] : []),
    `${L.runner}: ${report.running ? `${L.active} (${report.lock.task}, ${report.lock.runId ?? L.noRun})` : report.buildLoop ? `${L.active} (build-loop)` : L.stopped}${sep} ${L.start}: ${report.implementationReady ? L.approved : L.blocked}${sep}`,
    ...(report.buildLoop ? [`${L.buildLoop}: ${report.buildLoop.stage}; ${report.buildLoop.rounds}/${report.buildLoop.maxRounds ?? '∞'}; AI ${report.buildLoop.agentCalls}/${report.buildLoop.maxCalls ?? '∞'}${sep}`] : []),
    ...(report.survey ? [`Survey ${report.survey.kind}: ${report.survey.done}/${report.survey.total}; active: ${report.survey.activeScopes.join(', ') || 'none'}; calls: ${report.survey.agentCalls}; unreadable files: ${report.survey.unreadableFiles ?? 0}; updated: ${report.survey.updatedAt}`] : []),
    ...(report.survey?.parts ? Object.entries(report.survey.parts).map(([scope, p]) => `Survey ${scope}: parts ${p.done}/${p.total}${p.activePart ? `; active part ${p.activePart}` : ''}`) : []),
    ...report.phases.map(p => `- ${p.id} ${p.name}: ${p.status}`),
    ...(report.autoMode?.unrecorded ? [`${L.autoUnrecorded}${sep}`] : []),
    ...(report.autoMode?.active ? [`${L.autoOn}${report.autoMode.enabledAt ? ` (${L.since}: ${report.autoMode.enabledAt})` : ''}${sep}`] : []),
    ...(report.waivers?.length ? [`${L.waivers}:`, ...report.waivers.map(w => `- ${w.phase}: ${w.note}${w.unmet ? ` (${L.unmet}: ${w.unmet})` : ''}${w.auto ? ` [${L.autoWaiver}]` : ''}`)] : []),
    ...(report.autoMode?.records.length ? [`${L.autoRecords}: ${report.autoMode.records.join(', ')}${sep}`] : []),
    ...(report.autoMode?.rulebookUnchecked?.length ? [`${L.rulebookUnchecked}:`, ...report.autoMode.rulebookUnchecked.map(w => `- ${w.at}: ${w.sections.join(', ')}`)] : []),
    ...report.units.map(u => `- ${u.target}: ${u.status}${u.activeRoles.length ? ` (${u.activeRoles.map(a => a.retries ? `${a.role}, ${L.retrying} ${a.retries}` : a.role).join(', ')})` : ''}${u.reason ? ` — ${u.reason}` : ''}`),
    ...(report.pendingArtifacts?.length ? [`${L.notYet}: ${report.pendingArtifacts.join(', ')}`] : []),
    ...report.blockers.map(b => `- ${L.blocker} [${b.path}]: ${b.reason}`),
    ...report.nextActions.map(a => `- ${L.nextAction}: ${a}`), report.outcome ?? ''].filter(Boolean).join('\n');
}

// The ten phases as the user sees them: stable IDs, names in the user's
// language and exactly one current phase. `todo` matches the three-state
// task-list schema hosts expose (VS Code todo, Copilot CLI); `checklist` is
// the chat fallback and the progress block of every phase report.
// A three-state status shows work, not position: the current phase is
// in-progress only while it runs or is worked on; waiting, blocked or not yet
// started it stays not-started with its state in the title
// (docs/PHASE-HANDOFF.md). `current` marks it in every state.
const workingStates = new Set(['running', 'in-work']);
const stateLabels = {
  ja: { running: '実行中', 'awaiting-approval': '承認待ち', 'awaiting-review': '確認待ち', 'in-work': '作業中', 'not-started': '未着手', blocked: '要対応', failed: '失敗・要対応', ready: '実行可能' },
  en: { running: 'running', 'awaiting-approval': 'awaiting approval', 'awaiting-review': 'awaiting review', 'in-work': 'in progress', 'not-started': 'not started', blocked: 'needs action', failed: 'failed, needs action', ready: 'ready to run' }
};
const phaseTitles = {
  ja: { '00': '事前調査', '00b': '比較テストの準備', '01': '依存関係とルール', '02': '意味の差・方針', '03': '事前試行',
    '04': '変換・レビュー', '05': '全体ビルド', '05b': '基本動作', '05c': '新旧比較', '06': '整理・引き継ぎ' },
  en: { '00': 'Feasibility', '00b': 'Judge preparation', '01': 'Dependencies and rules', '02': 'Gap inventory', '03': 'Stress test',
    '04': 'Translation and review', '05': 'Build', '05b': 'Smoke', '05c': 'Parity', '06': 'Cleanup and handoff' }
};
// A phase whose receipt, or whose stage approval, auto mode recorded.
const gatePhase = { translation: '04', build: '05', smoke: '05b', parity: '05c', handoff: '06' };
const autoRecorded = (report, id) => (report.autoMode?.records ?? []).some(r => r === `phase ${id}` || gatePhase[r.replace(/^approve /, '')] === id);
export function phaseList(report, language = 'en') {
  const lang = phaseTitles[language] ? language : 'en', next = report.workflow?.next ?? null;
  const detail = Object.fromEntries((report.phases ?? []).map(p => [p.id, p.status]));
  return orderedPhases.map((id, i) => {
    const complete = Boolean(report.workflow?.phases?.find(p => p.id === id)?.complete);
    let title = `${id} ${phaseTitles[lang][id]}`;
    if (complete && report.recordedOnly) title += lang === 'ja' ? '（記録のみ・未再検証）' : ' (recorded, not revalidated)';
    if (id === '05c' && report.verificationMode === 'source-only') title += lang === 'ja' ? '（この方式では未検証）' : ' (unverified in this mode)';
    if (complete && autoRecorded(report, id)) title += lang === 'ja' ? '【自動・人の確認なし】' : ' [auto, not reviewed by the person]';
    if (!complete && report.workflow?.phases?.find(p => p.id === id)?.waived) title += lang === 'ja' ? '【見送り】' : ' [waived]';
    if (id === next && report.currentState && report.currentState !== 'not-started') title += lang === 'ja' ? `【${stateLabels.ja[report.currentState]}】` : ` [${stateLabels.en[report.currentState]}]`;
    return { id: i + 1, phase: id, title, status: complete ? 'completed' : id === next && workingStates.has(report.currentState) ? 'in-progress' : 'not-started',
      current: id === next, detail: detail[id] ?? null, ...(id === next && report.currentState ? { state: report.currentState } : {}) };
  });
}
// Without a workflow (invalid config, unreadable records) progress is unknown:
// never report "all complete"; surface the first blocker instead.
const unknownProgress = report => !report.ok || !report.workflow;
const blockerText = report => report.blockers?.[0] ? `${report.blockers[0].path}: ${report.blockers[0].reason}` : 'status could not be determined';
// TODO descriptions are shown to the person, so the recorded phase statuses are
// translated here only; JSON and markdown keep them as recorded.
const phaseStatusWords = { ja: { pending: '未完了', 'pending review': '確認・記録待ち', candidate: '成果物あり（未確認）', validated: '検証済み',
  running: '実行中', reviewed: '確認済み', 'unverified (not run in this mode)': '未検証（この方式では実行しない）',
  'approved (cleanup completion unconfirmed)': '承認済み（整理の完了は未確認）' } };
// todoList items keep the host schema's fields; `current` sits beside the list.
export function statusTodo(report, language = 'en') {
  const unknown = unknownProgress(report), words = phaseStatusWords[language] ?? {}, items = phaseList(report, language), current = items.find(i => i.current);
  return { todoList: items.map(({ id, title, status, detail }) => ({ id, title, status,
    description: unknown ? `${language === 'ja' ? '判定不能' : 'unknown'}: ${blockerText(report)}` : words[detail] ?? detail ?? '' })),
    ...(current ? { current: { id: current.id, phase: current.phase, title: current.title, state: current.state ?? 'not-started' } } : {}),
    ...(report.recordedOnly ? { recordedOnly: true } : {}), ...(unknown ? { blocked: blockerText(report) } : {}) };
}
export function statusChecklist(report, language = 'en') {
  const ja = language === 'ja', items = phaseList(report, language), next = items.find(i => i.current);
  const done = report.workflow?.done ?? 0;
  const head = unknownProgress(report)
    ? (ja ? `移行フロー：進捗を判定できません。原因：${blockerText(report)}` : `Migration flow: progress cannot be determined. Cause: ${blockerText(report)}`)
    : next ? (ja ? `移行フロー：${done}/${report.workflow.total}工程完了。現在：${next.title}` : `Migration flow: ${done}/${report.workflow.total} phases complete. Current: ${next.title}`)
    : report.waivers?.length ? (ja ? `移行フロー：${done}/${report.workflow.total}工程完了。残りは見送った工程だけです` : `Migration flow: ${done}/${report.workflow.total} phases complete. Only waived phases remain`)
    : (ja ? `移行フロー：${done}/${report.workflow.total}工程完了` : `Migration flow: ${done}/${report.workflow.total} phases complete`);
  return [...(report.recordedOnly ? [ja ? '記録に基づく進捗（入力・承認は未再検証）' : 'Recorded progress (inputs and approvals not revalidated)'] : []),
    head, ...items.map(i => `- [${i.status === 'completed' ? 'x' : ' '}] ${i.current ? '▶ ' : ''}${i.title}${i.current ? (ja ? '　← いまここ' : '  ← you are here') : ''}`)].join('\n');
}
