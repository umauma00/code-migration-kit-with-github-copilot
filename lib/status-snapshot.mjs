// SPDX-License-Identifier: Apache-2.0
// Progress only: no source walks, source hashes, model calls or approval checks.
// Execution and gates always revalidate through the normal runner functions.
import fs from 'node:fs';
import { safePath, readJSON, hash, fileHash, activeBuildLoop, phaseReports } from './core.mjs';
import { runSettingsState } from './run-settings.mjs';
import { autoModeReport } from './preferences.mjs';

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

export function statusSnapshot(root) {
  const report = { ok: true, recordedOnly: true, observedAt: new Date().toISOString(), verificationMode: null, equivalence: 'unverified',
    done: 0, total: 0, units: [], remaining: 0, timeEstimate: 'not calculated', implementationReady: false,
    running: false, lock: null, blockers: [], nextActions: [], phases: [], artifacts: [] };
  const config = record(root, 'migration/config.json');
  if (!config || config.schemaVersion !== 1) {
    report.ok = false; report.blockers.push({ path: 'migration/config.json', reason: 'Configuration missing or unreadable' }); return report;
  }
  report.verificationMode = config.verificationMode ?? 'runtime';
  report.purpose = config.executionPurpose ?? 'production';
  try { report.runSettings = runSettingsState(root, config); } catch {}
  report.lock = record(root, 'migration/run.lock');
  if (Number.isSafeInteger(report.lock?.pid) && report.lock.pid > 0) {
    try { process.kill(report.lock.pid, 0); report.running = true; } catch {}
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
  const manifest = safePath(root, 'migration/manifest.tsv');
  if (fs.existsSync(manifest)) {
    const rows = fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
    if (rows.shift() !== 'source\ttarget') { report.ok = false; report.blockers.push({ path: 'migration/manifest.tsv', reason: 'Manifest header is invalid' }); }
    else for (const row of rows.filter(Boolean)) {
      const cells = row.split('\t');
      if (cells.length !== 2) { report.ok = false; report.blockers.push({ path: 'migration/manifest.tsv', reason: 'Manifest row is invalid' }); continue; }
      const [source, target] = cells, id = hash(`${source}\0${target}`).slice(0, 24);
      const state = record(root, `migration/state/units/${id}.json`);
      const matches = state?.source === source && state?.target === target;
      report.units.push({ source, target, status: matches ? state.status : 'pending', stage: matches ? state.stage : 'implement',
        reason: matches ? state.error ?? null : null, activeRoles: [] });
    }
  }
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
  const mode = record(root, 'migration/preferences.json')?.phaseMode;
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
