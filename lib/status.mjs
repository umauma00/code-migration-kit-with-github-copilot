// SPDX-License-Identifier: Apache-2.0
// Read-only evidence projection. Status never approves, repairs, or dispatches.
import fs from 'node:fs';
import { loadConfig, safePath, readJSON, fileHash, contextHash, readManifest, done, reviewDependencyPath, readRepairIntent } from './core.mjs';
import { currentRecord, requireGate } from './pipeline.mjs';
import { strictPhases, currentPhase, orderedPhases } from './phases.mjs';
import { executionPurpose, requirePilot } from './pilot.mjs';

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
export function migrationStatus(root) {
  const report = { ok: true, done: 0, total: 0, units: [], verificationMode: null, equivalence: 'unverified',
    running: false, lock: null, blockers: [], nextActions: [], phases: [], remaining: 0, timeEstimate: 'not calculated' };
  const issue = (path, reason, action) => { report.blockers.push({ path, reason }); report.nextActions.push(action); };
  let config;
  try { config = loadConfig(root); report.verificationMode = config.verificationMode ?? 'runtime'; }
  catch (e) { report.ok = false; issue('migration/config.json', e.message, 'Correct migration/config.json and run status again'); return report; }
  report.purpose = executionPurpose(config);
  let pilot = null;
  if (report.purpose === 'pilot') { try { pilot = requirePilot(root, config); } catch (e) { issue('migration/pilot.json', e.message, 'Prepare a new authorized pilot; do not alter its sealed inputs'); } }
  const lockFile = safePath(root, 'migration/run.lock');
  if (fs.existsSync(lockFile)) {
    try {
      report.lock = readJSON(lockFile);
      if (!Number.isInteger(report.lock.pid) || report.lock.pid < 1) throw new Error('Invalid lock owner PID');
      try { process.kill(report.lock.pid, 0); report.running = true; }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      if (!report.running) issue('migration/run.lock', 'Lock owner has stopped', `Check the owner, then run unlock --pid ${report.lock.pid}`);
    } catch (e) { issue('migration/run.lock', e.message, 'Inspect the lock without assuming a running migration'); }
  }
  const artifactNames = ['migration/feasibility.md', 'migration/judge-report.md', 'migration/RULEBOOK.md',
    reviewDependencyPath(config), 'migration/inventory.tsv', 'migration/manifest.tsv',
    ...(report.purpose === 'pilot' ? ['migration/pilot.json'] : ['migration/stress-test/report.md'])];
  report.artifacts = artifactNames.map(p => {
    try { const h = fileHash(safePath(root, p)); return { path: p, status: h && fs.statSync(safePath(root, p)).size > 0 ? 'candidate' : 'missing' }; }
    catch (e) { issue(p, e.message, `Correct ${p}`); return { path: p, status: 'invalid' }; }
  });
  let context = null, units = [];
  try { context = contextHash(root, config); }
  catch (e) { issue('migration inputs', e.message, 'Prepare or correct the required inputs, then run judge'); }
  try { if (fs.existsSync(safePath(root, 'migration/manifest.tsv'))) {
    units = readManifest(root, config);
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
        // Coordinator attempt files live directly under the run, not in the
        // native request/answer subtree. Do not parse worker answer JSON here.
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
    try { if (fs.existsSync(safePath(root, receipt))) state = readJSON(safePath(root, receipt)); }
    catch (e) { invalidState = e.message; issue(receipt, e.message, 'Inspect corrupt unit state and rerun translate for fresh review'); }
    const complete = context && done(root, u, context);
    const current = state?.contextHash === context && state?.outputHash === fileHash(safePath(root, u.target));
    const active = report.running && state?.runId === report.lock.runId && current;
    const calls = active ? attempts.filter(a => a.unit.id === u.id).map(a => ({ role: a.role, path: a.path })) : [];
    const status = complete ? 'done' : invalidState || (current && state?.status === 'blocked') ? 'blocked' : active && state.status === 'validating' ? 'validating' : active && state.stage !== 'done' ? state.stage : state ? 'stopped' : 'pending';
    return { source: u.source, target: u.target, status, stage: state?.stage ?? 'implement',
      activeRoles: calls, reason: complete ? null : invalidState ?? (!current && state ? 'Receipt stale; inputs or outputs changed' : state?.error ?? (state && !active ? 'Receipt incomplete; rerun translate after checking approvals' : null)),
      receipt: state ? `migration/state/units/${u.id}.json` : null };
  });
  report.done = report.units.filter(u => u.status === 'done').length;
  report.remaining = report.total - report.done;
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
  for (const a of report.artifacts.filter(a => a.status === 'missing')) {
    if (a.path === 'migration/judge-report.md' && stages.judge) continue;
    issue(a.path, 'Preparation artifact missing', `Prepare and review ${a.path}`);
  }
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
  if (report.implementationReady && report.done < report.total && !activeTranslation) report.nextActions.push(report.approvedScopeRemaining
    ? 'Run or resume translate; inspect blocked unit receipts first' : 'Review the completed batch; obtain approval for the next explicit translation batch');
  if (report.total && report.done === report.total && !activeTranslation) {
    const next = !stages.build ? 'build' : !stages.smoke ? 'smoke' : report.verificationMode === 'source-only' ? (!stages.handoff ? 'handoff' : null) : (!stages.parity ? 'parity' : 'post-parity');
    if (next === 'post-parity' && postParityApproved) report.nextActions.push('Perform the approved prompt 06 cleanup and report the results; completion is unconfirmed');
    else if (next && !activeStages.has(next)) report.nextActions.push(`Review current evidence; approve ${next} with a concrete note${next === 'post-parity' ? ', then follow prompt 06' : ` and run ${next}`}`);
  }
  if (activeTranslation) report.nextActions.push(config.workerBackend === 'native'
    ? 'Monitor the active runner and keep servicing native list/claim/delegate/submit jobs; wait for completion before the next stage'
    : 'Monitor the active translation/repair runner; wait for completion before rerunning or approving the next stage');
  if (activeStages.size) report.nextActions.push(`Monitor the active ${[...activeStages].join(', ')} stage; review its receipt after the runner finishes`);
  const phaseReceipts = {};
  let strict = false;
  try { strict = strictPhases(root,config); } catch(e) {report.ok=false;issue('migration/phases/policy.json',e.message,'Correct the phase policy record');}
  for (const id of ['00','00b','01','02','03','05c','06']) {
    try {phaseReceipts[id]=currentPhase(root,config,id);} catch(e) {phaseReceipts[id]=false;issue(`migration/phases/${id}.json`,e.message,`Review phase ${id} evidence and record its completion again`);}
  }
  const workflowDone = { ...phaseReceipts, '04':Boolean(report.total && report.done===report.total && approved),
    '05':Boolean(stages.build), '05b':Boolean(stages.smoke),
    '05c':report.verificationMode==='source-only' ? Boolean(phaseReceipts['05c']) : Boolean(stages.parity),
    '06':report.verificationMode==='source-only' ? Boolean(stages.handoff) : Boolean(phaseReceipts['06'] && postParityApproved) };
  const nextPhase = orderedPhases.find(id => !workflowDone[id]) ?? null;
  report.workflow={policy:strict ? 'strict' : 'legacy',done:orderedPhases.filter(id=>workflowDone[id]).length,total:10,next:nextPhase,
    phases:orderedPhases.map(id=>({id,complete:Boolean(workflowDone[id])}))};
  report.macroStages = macroStages.map(s => ({ ...s, complete: s.phases.every(id => workflowDone[id]),
    ...(s.id === 6 && report.verificationMode === 'source-only' ? { equivalence: 'unverified' } : {}) }));
  if (report.purpose === 'pilot') {
    const ids = ['04', '05', '05b', '05c'].slice(0, ['translation', 'build', 'smoke', 'parity'].indexOf(pilot?.through ?? 'translation') + 1);
    report.workflow = { policy: 'isolated-pilot', done: ids.filter(id => workflowDone[id]).length, total: ids.length,
      next: ids.find(id => !workflowDone[id]) ?? null, phases: ids.map(id => ({ id, complete: Boolean(workflowDone[id]) })) };
    report.phases = report.phases.filter(p => ids.includes(p.id));
    report.nextActions = report.running ? report.nextActions.filter(a => a.startsWith('Monitor')) : [pilot ? 'Run or resume pilot run within its existing authorization; archive the trial report and discard the workspace when reviewed' : 'Prepare a new authorized pilot'];
    report.outcome = 'Disposable pilot; production completion unconfirmed';
  } else if (strict) {
    for (const p of report.phases) if (['00','00b','01','02','03'].includes(p.id)) p.status=phaseReceipts[p.id] ? 'reviewed' : 'pending review';
    if (phaseReceipts['06'] && report.verificationMode==='runtime' && postParityApproved) report.phases.find(p=>p.id==='06').status='reviewed';
    if (nextPhase && ['00','00b','01','02','03'].includes(nextPhase)) report.nextActions=report.nextActions.filter(a=>/^(Correct|Inspect|Check)/.test(a));
    if (nextPhase && !report.running) report.nextActions.unshift(`Follow phase ${nextPhase}; run phase start ${nextPhase} before work and follow its prompt. Phase completion needs reviewed evidence, not an existing template.`);
  }
  report.nextActions = [...new Set(report.nextActions)];
  if (stages.handoff) report.outcome = 'Source-based migration complete; behavioral equivalence unverified';
  return report;
}
// Labels follow migration/preferences.json; machine values (IDs, statuses,
// reasons) stay as recorded so they remain greppable across languages.
const labels = {
  en: { verification: 'Verification', equivalence: 'equivalence', invalid: 'invalid configuration', reviewed: 'Reviewed units', remaining: 'remaining',
    noTime: 'time not calculated', workflow: 'Workflow', policy: 'policy', next: 'next', complete: 'complete', purpose: 'Purpose',
    production: 'production', stages: 'Major stages', unverified: 'unverified', pending: 'pending', runner: 'Runner', active: 'active',
    noRun: 'no run ID', stopped: 'stopped', start: 'Implementation start', approved: 'approved for current inputs', blocked: 'blocked or awaiting review',
    blocker: 'Blocker', nextAction: 'Next' },
  ja: { verification: '検証方式', equivalence: '同等性', invalid: '設定が不正', reviewed: 'レビュー済み単位', remaining: '残り',
    noTime: '所要時間は未計算', workflow: '工程', policy: '方針', next: '次', complete: '完了', purpose: '目的',
    production: '本番', stages: '主要段階', unverified: '未検証', pending: '未完了', runner: 'runner', active: '実行中',
    noRun: '実行IDなし', stopped: '停止中', start: '実装の開始', approved: '現在の入力で承認済み', blocked: '停止中またはレビュー待ち',
    blocker: '阻害要因', nextAction: '次の操作' }
};
export function statusMarkdown(report, language = 'en') {
  const L = labels[language] ?? labels.en, sep = language === 'ja' ? '。' : '.';
  return [`${L.verification}: ${report.verificationMode ?? L.invalid}; ${L.equivalence}: ${report.equivalence}${sep}`,
    `${L.reviewed}: ${report.done}/${report.total}; ${L.remaining}: ${report.remaining}; ${L.noTime}${sep}`,
    ...(report.workflow ? [`${L.workflow}: ${report.workflow.done}/${report.workflow.total}; ${L.policy}: ${report.workflow.policy}; ${L.next}: ${report.workflow.next ?? L.complete}${sep}`] : []),
    `${L.purpose}: ${report.purpose ?? L.production}${sep}`,
    ...(report.macroStages && report.purpose !== 'pilot' ? [`${L.stages}: ${report.macroStages.map(s => `${s.id} ${s.name}: ${s.equivalence === 'unverified' ? L.unverified : s.complete ? L.complete : L.pending}`).join('; ')}${sep}`] : []),
    `${L.runner}: ${report.running ? `${L.active} (${report.lock.task}, ${report.lock.runId ?? L.noRun})` : L.stopped}${sep} ${L.start}: ${report.implementationReady ? L.approved : L.blocked}${sep}`,
    ...report.phases.map(p => `- ${p.id} ${p.name}: ${p.status}`),
    ...report.units.map(u => `- ${u.target}: ${u.status}${u.activeRoles.length ? ` (${u.activeRoles.map(a => a.role).join(', ')})` : ''}${u.reason ? ` — ${u.reason}` : ''}`),
    ...report.blockers.map(b => `- ${L.blocker} [${b.path}]: ${b.reason}`),
    ...report.nextActions.map(a => `- ${L.nextAction}: ${a}`), report.outcome ?? ''].filter(Boolean).join('\n');
}
