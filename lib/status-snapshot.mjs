// SPDX-License-Identifier: Apache-2.0
// Progress only: no source walks, source hashes, model calls or approval checks.
// Execution and gates always revalidate through the normal runner functions.
import fs from 'node:fs';
import { safePath, readJSON, hash, fileHash, activeBuildLoop, phaseReports, lockOwnerState, readMovedJSON, configFile, legacyConfigFile, configFileOf } from './core.mjs';
import { settingsState, settingsFile } from './settings.mjs';
import { autoModeReport, preferencesFile, legacyPreferencesFile } from './preferences.mjs';

const ids = ['00', '00b', '01', '02', '03', '04', '05', '05b', '05c', '06'];
const names = ['Feasibility', 'Judge preparation', 'Dependencies and rules', 'Gap inventory', 'Prototype', 'Implementation', 'Build', 'Smoke', 'Parity', 'Handoff'];
const record = (root, name) => {
  try { return readJSON(safePath(root, name)); } catch { return null; }
};

export function surveyProgress(root, lock) {
  if (lock?.task !== 'survey' || !/^[A-Za-z0-9_-]+$/.test(lock.runId ?? '')) return null;
  for (const [store, kind] of [['facts', 'facts'], ['contracts', 'contracts'], ['inventory', 'inventory'], ['inventory-trial', 'inventory']]) {
    const progress = record(root, `migration/surveys/${store}/runs/${lock.runId}.progress.json`);
    if (progress?.schemaVersion === 1 && progress.runId === lock.runId && progress.kind === kind &&
        Array.isArray(progress.activeScopes) && progress.activeScopes.every(s => typeof s === 'string') &&
        ['done', 'total', 'agentCalls'].every(k => Number.isSafeInteger(progress[k]) && progress[k] >= 0) && progress.done <= progress.total) return progress;
  }
  return null;
}

// The coordinator's attempt records of a run that are still running: the
// small files directly under the run (no summary, worker answer or source).
// units: the unit IDs to read (null: every unit); a finished attempt can be
// large (it holds the worker's answer), so the fast view reads only those of
// the units its state files show at work. onError(path, reason, next): a
// record or the run's folder that cannot be read.
const attemptName = /^([a-f0-9]{24})-\d+-(?:implementer|reviewer-semantics|reviewer-rules|arbiter|fixer)-[a-f0-9]{8}\.json$/;
// A finished attempt of a unit still at work (its implementer's, say) holds
// the worker's whole answer. The record keeps the order of its fields as made
// (writeJSON, two spaces), with its status near the top, so the head of the
// file shows a finished one, which is then not read whole (status --wait
// reads these every 5 s). A head that shows no status in that form (a record
// written compact or indented otherwise, a status further down) is read whole.
const headBytes = 16384;
const finishedHead = file => {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(headBytes), size = fs.readSync(fd, buffer, 0, headBytes, 0);
    const status = /^ {2}"status": "([^"\\]*)"/m.exec(buffer.toString('utf8', 0, size))?.[1];
    return status !== undefined && status !== 'running';
  } finally { fs.closeSync(fd); }
};
export function runningAttempts(root, runId, { units = null, onError = () => {} } = {}) {
  const attempts = [];
  if (typeof runId !== 'string' || !runId || units?.size === 0) return attempts;
  const directory = `migration/runs/${runId}`;
  try {
    const full = safePath(root, directory);
    for (const name of fs.existsSync(full) ? fs.readdirSync(full) : []) {
      const match = attemptName.exec(name);
      if (!match || (units && !units.has(match[1]))) continue;
      const p = `${directory}/${name}`;
      try {
        if (finishedHead(safePath(root, p))) continue;
        const r = readJSON(safePath(root, p));
        if (r?.status === 'running' && r.unit?.id && typeof r.role === 'string') attempts.push({ ...r, path: p });
      } catch (e) { onError(p, e.message, 'Inspect the coordinator attempt record'); }
    }
  } catch (e) { onError(directory, e.message, 'Inspect current run records'); }
  return attempts;
}
// When the try of a call now at work started (its last retry, else the
// attempt's start), how many minutes ago, and the call limit it runs under
// (0.47.0, workerCallMinutes; an attempt of an older kit has none).
export function callTiming(attempt, now = Date.now()) {
  const at = [Array.isArray(attempt?.retries) ? attempt.retries.at(-1)?.at : undefined, attempt?.startedAt].find(v => typeof v === 'string' && Number.isFinite(Date.parse(v)));
  return { ...(at ? { startedAt: at, elapsedMinutes: Math.max(0, Math.floor((now - Date.parse(at)) / 60000)) } : {}),
    ...(Number.isSafeInteger(attempt?.callLimitMinutes) && attempt.callLimitMinutes > 0 ? { callLimitMinutes: attempt.callLimitMinutes } : {}) };
}
// A running attempt as a unit's activeRoles entry shows it in both views.
export const activeRole = (attempt, now) => ({ role: attempt.role, path: attempt.path, ...callTiming(attempt, now) });

export function statusSnapshot(root) {
  const report = { ok: true, recordedOnly: true, observedAt: new Date().toISOString(), verificationMode: null, equivalence: 'unverified',
    done: 0, total: 0, units: [], remaining: 0, timeEstimate: 'not calculated', implementationReady: false,
    running: false, lock: null, blockers: [], nextActions: [], phases: [], artifacts: [] };
  // The kit's records, in their place or in the old one the next command moves them from.
  const moved = (name, legacy) => { try { return readMovedJSON(root, name, legacy)?.value ?? null; } catch { return null; } };
  const config = moved(configFile, legacyConfigFile);
  if (!config || config.schemaVersion !== 1) {
    report.ok = false; report.blockers.push({ path: configFileOf(root), reason: `Configuration missing or unreadable (the kit's record of ${settingsFile})` }); return report;
  }
  report.verificationMode = config.verificationMode ?? 'runtime';
  report.purpose = config.executionPurpose ?? 'production';
  try { report.settings = settingsState(root, config); } catch {}
  report.lock = record(root, 'migration/run.lock');
  // As the full status: a lock written on another host is not running here.
  if (Number.isSafeInteger(report.lock?.pid) && report.lock.pid > 0) {
    const owner = lockOwnerState(report.lock);
    report.running = owner === 'alive';
    if (owner === 'foreign') {
      report.foreignLock = { pid: report.lock.pid, host: report.lock.host, note: 'Written on another host; this host cannot tell whether it still runs.' };
      report.nextActions.push(`Lock held by pid ${report.lock.pid} on host ${report.lock.host}; this host cannot check it. Once that run has stopped, run unlock --pid ${report.lock.pid}`);
    }
  }
  const completed = new Set(), touched = [];
  for (const id of ids) {
    const r = record(root, `migration/phases/${id}.json`);
    if (r?.schemaVersion === 1 && r.phase === id && r.executionId && r.note?.trim()) {
      completed.add(id);
      // A file stat only (no hashing): an artifact written after the record
      // may have made it out of date; phase next decides.
      const at = Date.parse(r.completedAt);
      // A RULEBOOK change the person accepted afterwards (rulebook accept) is not a change since the record.
      const acceptedAt = Math.max(at, ...((record(root, 'migration/phases/rulebook-amendments.json')?.log ?? []).map(e => Date.parse(e?.at)).filter(Number.isFinite)));
      // A written report is small: one written after the record but with the
      // recorded bytes (a note added and removed again) has not changed.
      const recorded = new Map((Array.isArray(r.evidence) ? r.evidence : []).filter(e => Array.isArray(e) && typeof e[0] === 'string').map(e => [e[0], e[1]]));
      const after = [...recorded.keys()].filter(p => { try { return fs.statSync(safePath(root, p)).mtimeMs > (p === 'migration/RULEBOOK.md' ? acceptedAt : at) + 1000 && !(phaseReports.includes(p) && recorded.get(p) && fileHash(safePath(root, p)) === recorded.get(p)); } catch { return true; } });
      if (after.length) touched.push({ phase: id, files: after });
    }
  }
  const stages = { '05': 'build', '05b': 'smoke', '05c': 'parity', '06': 'handoff' };
  for (const [id, stage] of Object.entries(stages)) {
    if ((stage === 'handoff') !== (report.verificationMode === 'source-only') && id === '06') continue;
    if (stage === 'parity' && report.verificationMode === 'source-only') continue;
    const r = record(root, `migration/results/${stage}.json`);
    if (r?.schemaVersion === 1 && r.stage === stage && r.success && !r.invalidatedAt) completed.add(id);
  }
  // State files are small coordinator records. Do not inspect candidate/source
  // content to display a running phase in the host's TODO list.
  // An unreadable manifest (a folder or a link in its place) is a blocker of
  // this view, as it is of the full status, not a failure of status --wait.
  // recorded: the unit has a state file (an earlier or this run tried it).
  // A unit at work in the running run shows its calls with their minutes
  // (activeRoles, from the run's attempt records of those units only).
  try {
    const manifest = safePath(root, 'migration/manifest.tsv');
    if (fs.existsSync(manifest)) {
      const rows = fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
      const atWork = new Map();
      if (rows.shift() !== 'source\ttarget') { report.ok = false; report.blockers.push({ path: 'migration/manifest.tsv', reason: 'Manifest header is invalid' }); }
      else for (const row of rows.filter(Boolean)) {
        const cells = row.split('\t');
        if (cells.length !== 2) { report.ok = false; report.blockers.push({ path: 'migration/manifest.tsv', reason: 'Manifest row is invalid' }); continue; }
        const [source, target] = cells, id = hash(`${source}\0${target}`).slice(0, 24);
        const state = record(root, `migration/state/units/${id}.json`);
        const matches = state?.source === source && state?.target === target;
        const unit = { source, target, status: matches ? state.status : 'pending', stage: matches ? state.stage : 'implement',
          reason: matches ? state.error ?? null : null, recorded: matches, activeRoles: [] };
        if (report.running && matches && state.runId === report.lock?.runId && !['done', 'blocked'].includes(state.status)) atWork.set(id, unit);
        report.units.push(unit);
      }
      const now = Date.now();
      for (const attempt of runningAttempts(root, report.running ? report.lock?.runId : null, { units: new Set(atWork.keys()) })) atWork.get(attempt.unit.id)?.activeRoles.push(activeRole(attempt, now));
    }
  } catch (e) { report.ok = false; report.units = []; report.blockers.push({ path: 'migration/manifest.tsv', reason: e.message }); }
  report.total = report.units.length;
  report.done = report.units.filter(u => u.status === 'done').length;
  report.remaining = report.total - report.done;
  // The manifest may still contain unstarted units; never infer phase 04 done
  // just because all the state files written so far say done.
  if (report.ok && report.total > 0 && report.done === report.total) completed.add('04');
  const pilot = report.purpose === 'pilot' ? record(root, 'migration/pilot.json') : null;
  const workflowIds = report.purpose === 'pilot' ? ['04', '05', '05b', '05c'].slice(0,
    Math.max(1, ['translation', 'build', 'smoke', 'parity'].indexOf(pilot?.through ?? 'translation') + 1)) : ids;
  // Relaxed mode: waiver files are read as recorded, like the receipts above.
  const mode = moved(preferencesFile, legacyPreferencesFile)?.phaseMode;
  const relaxed = report.purpose !== 'pilot' && ['relaxed', 'auto'].includes(mode);
  const waivers = (relaxed ? ids.filter(id => id !== '06' && !completed.has(id)) : [])
    .map(id => [id, record(root, `migration/phases/waivers/${id}.json`)])
    .filter(([id, w]) => w?.schemaVersion === 1 && w.phase === id && typeof w.note === 'string' && w.note.trim())
    .map(([, { phase, note, waivedAt, unmet, auto }]) => ({ phase, note, waivedAt, ...(unmet ? { unmet } : {}), ...(auto ? { auto } : {}) }));
  const waived = new Set(waivers.map(w => w.phase));
  if (relaxed) report.waivers = waivers;
  const auto = report.purpose !== 'pilot' && autoModeReport(root);
  if (auto) report.autoMode = auto;
  report.workflow = { policy: report.purpose === 'pilot' ? 'isolated-pilot' : config.phasePolicy ?? 'legacy', recordedOnly: true, ...(relaxed ? { mode: auto?.active ? 'auto' : 'relaxed' } : {}),
    done: workflowIds.filter(id => completed.has(id)).length, total: workflowIds.length,
    next: workflowIds.find(id => !completed.has(id) && !waived.has(id)) ?? null, phases: workflowIds.map(id => ({ id, complete: completed.has(id), ...(waived.has(id) ? { waived: true } : {}) })) };
  report.phases = workflowIds.map(id => ({ id, name: names[ids.indexOf(id)], status: !completed.has(id) ? 'pending'
    : touched.some(t => t.phase === id) ? 'recorded, files changed since (phase next decides)' : 'recorded (not revalidated)' }));
  // Only the strict phase workflow explains an out-of-date record (phase next's stale).
  if (touched.length && (config.phasePolicy === 'strict' || record(root, 'migration/phases/policy.json')?.policy === 'strict')) {
    report.workflow.changedSinceRecord = touched;
    report.nextActions.push(`Files changed after phase ${touched.map(t => t.phase).join(', ')} was recorded (${[...new Set(touched.flatMap(t => t.files))].join(', ')}); this view does not revalidate. Run phase next: if it names an earlier phase, follow its workflow.stale.next instead of asking about the difference.`);
  }
  report.survey = surveyProgress(root, report.lock);
  const phase = report.workflow.next;
  const activePhase = report.survey ? { facts: '00', contracts: '00b', inventory: '02' }[report.survey.kind]
    : { translation: '04', build: '05', smoke: '05b', parity: '05c', handoff: '06' }[report.lock?.task];
  const started = phase && record(root, `migration/phases/starts/${phase}.json`);
  report.currentState = report.running && activePhase === phase ? 'running' : started ? 'in-work' : 'not-started';
  try { const loop = activeBuildLoop(root); if (loop) report.buildLoop = loop; } catch {}
  report.nextActions.push(report.running || report.buildLoop ? 'Monitor the existing runner; silence alone is not a reason to kill or relaunch it.'
    : 'Recorded progress only. Use phase check or normal status to revalidate before a gate; no phase or approval is recorded by this view.');
  return report;
}
