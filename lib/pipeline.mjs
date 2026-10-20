// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import crypto from 'node:crypto';
import { safePath, assertOutputPath, hash, fileHash, treeHash, stamp, atomicWrite, writeJSON, readJSON,
  readManifest, contextHash, statePath, unitState, done, lockRun, sourceOnlyPlan, readRepairIntent, waitsForDependencies, fixPolicy } from './core.mjs';
import { validateResult } from './results.mjs';
import { runProcess } from './process.mjs';
import { reviewEvidence, readReviewText, pairFindings } from './review.mjs';
import { requirePhase, strictPhases } from './phases.mjs';
import { requireGuardrails } from './guardrails.mjs';
import { costEvent, recordCost } from './cost.mjs';
import { requireMarkers } from './markers.mjs';
import { executionPurpose, requirePilot } from './pilot.mjs';
import { judgeInputHash, currentJudgePreparation } from './judge.mjs';
import { selectTranslationScope, unitDependencies, readRepairQueue } from './scopes.mjs';
import { admitRepair, pendingRepairs } from './repair.mjs';
import { isTransientFailure, isSystemicFailure, retryDelayMs } from './failures.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { recordSession } from './sessions.mjs';

const recordPath = (root, stage) => safePath(root, `migration/results/${stage}.json`);
const gatePath = (root, stage) => safePath(root, `migration/gates/${stage}.json`);
const outputHash = (root, config) => hash(JSON.stringify({
  tree: treeHash(root, config.outputRoots),
  // Explicit outputs must participate even below traversal exclusions.
  manifestTargets: readManifest(root, config).map(u => [u.target, fileHash(safePath(root, u.target))])
}));
export const outputFingerprint = (root, config) => outputHash(root, config);
const stages = ['judge', 'translation', 'build', 'smoke', 'parity', 'post-parity', 'handoff'];
const previousStage = { translation: 'judge', build: 'judge', smoke: 'build', parity: 'smoke', 'post-parity': 'parity', handoff: 'smoke' };
function invalidateAfter(root, stage) {
  for (const next of stages.slice(stages.indexOf(stage) + 1)) {
    const file = recordPath(root, next);
    if (fs.existsSync(file)) {
      try { writeJSON(file, { ...readJSON(file), invalidatedAt: stamp(), invalidatedBy: stage }); }
      catch (e) { if (!(e instanceof SyntaxError)) throw e; fs.rmSync(file); }
    }
    fs.rmSync(gatePath(root, next), { force: true });
  }
}
export function currentRecord(root, config, stage, context, withOutputs = true) {
  const file = recordPath(root, stage);
  if (!fs.existsSync(file)) return false;
  let r;
  try { r = readJSON(file); } catch (e) { if (e instanceof SyntaxError) return false; throw e; }
  if ((r.purpose ?? 'production') !== executionPurpose(config)) return false;
  if (stage === 'handoff' && (config.verificationMode !== 'source-only' || r.verificationMode !== 'source-only' || r.equivalence !== 'unverified' || r.evidence?.length !== 1 || r.evidence[0][0] !== 'migration/handoff.md' || !r.evidence[0][1])) return false;
  if (r.evidence?.some(([p, h]) => fileHash(safePath(root, p)) !== h)) return false;
  if (!r.executionId || !r.success || r.invalidatedAt || r.contextHash !== context || (withOutputs && r.outputHash !== outputHash(root, config))) return false;
  const previous = previousStage[stage];
  if (previous) {
    const p = currentRecord(root, config, previous, context, previous !== 'judge');
    if (!p || r.predecessor?.stage !== previous || r.predecessor.executionId !== p.executionId) return false;
  }
  return r;
}
function predecessor(root, config, stage, context) {
  const previous = previousStage[stage];
  if (!previous) return null;
  const record = currentRecord(root, config, previous, context, previous !== 'judge');
  if (!record) throw new Error(`Run ${previous} successfully for the current inputs first`);
  return { stage: previous, executionId: record.executionId };
}
export function approve(root, config, stage, note, options = {}) {
  if (!['translation', 'build', 'smoke', 'parity', 'post-parity', 'handoff'].includes(stage)) throw new Error('Unknown approval stage');
  if (stage === 'handoff' && config.verificationMode !== 'source-only') throw new Error('handoff is only available in source-only mode; runtime requires parity');
  if (config.verificationMode === 'source-only' && ['parity', 'post-parity'].includes(stage)) throw new Error('Source-only equivalence is unverified; use smoke then handoff');
  if (!note?.trim()) throw new Error('Approval requires --note describing what was reviewed');
  if (stage !== 'translation' && (options.batch !== undefined || options.targets !== undefined)) throw new Error('Batch/target scopes apply only to translation approval');
  // A build approval issued by the host-confirmed build-loop grant records it.
  if (options.loop !== undefined && (stage !== 'build' || typeof options.loop?.grantId !== 'string' || !Number.isInteger(options.loop?.round))) throw new Error('Only build approvals can belong to a build-loop grant');
  const release = lockRun(root, `approve-${stage}`);
  try {
  const pilot = requirePilot(root, config);
  if (pilot && (['post-parity', 'handoff'].includes(stage) || ['translation', 'build', 'smoke', 'parity'].indexOf(stage) > ['translation', 'build', 'smoke', 'parity'].indexOf(pilot.through))) throw new Error('Stage is outside the authorized pilot boundary');
  const context = contextHash(root, config);
  if (stage === 'translation') {
    if (!pilot) requirePhase(root, config, '03');
    for (const p of pilot ? ['migration/feasibility.md', 'migration/pilot.json'] : ['migration/feasibility.md', 'migration/stress-test/report.md']) {
      const f = safePath(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) throw new Error(`Review artifact required: ${p}`);
    }
    if (!currentRecord(root, config, 'judge', context, false)) throw new Error('Run judge successfully for these inputs before approving translation');
  } else {
    const units = readManifest(root, config);
    if (!units.length || !units.every(u => done(root, u, context))) throw new Error('All translation units must have current reviewed receipts');
    requireGate(root, config, 'translation', context);
  }
  if (stage === 'handoff' && (!fileHash(safePath(root, 'migration/handoff.md')) || fs.statSync(safePath(root, 'migration/handoff.md')).size === 0)) throw new Error('Review artifact required: migration/handoff.md');
  if (stage === 'handoff') requirePhase(root, config, '05c');
  const selected = stage === 'translation' ? selectTranslationScope(root, config, context, options) : null;
  if (selected && pendingRepairs(root, readManifest(root, config), context).some(j => !selected.includes(j.target))) throw new Error('Translation scope omits unfinished repair targets; resume the admitted repair intent');
  const gate = { schemaVersion: 1, stage, purpose: executionPurpose(config), ...(pilot ? { pilotId: pilot.id } : {}), note, approvedAt: stamp(), contextHash: context,
    ...(selected ? { targets: selected } : {}), ...(options.loop ? { loop: options.loop } : {}),
    predecessor: predecessor(root, config, stage, context),
    outputHash: stage === 'translation' ? null : outputHash(root, config),
    reports: stage === 'translation' ? (pilot ? ['migration/feasibility.md', 'migration/pilot.json'] : ['migration/feasibility.md', 'migration/stress-test/report.md']).map(p => [p, fileHash(safePath(root, p))]) : stage === 'handoff' ? [['migration/handoff.md', fileHash(safePath(root, 'migration/handoff.md'))]] : [] };
  writeJSON(gatePath(root, stage), gate);
  return gate;
  } finally { release(); }
}
export function requireGate(root, config, stage, context) {
  const pilot = requirePilot(root, config);
  if (stage === 'translation' && !pilot) requirePhase(root, config, '03');
  if (stage === 'handoff') requirePhase(root, config, '05c');
  const file = gatePath(root, stage);
  if (!fs.existsSync(file)) throw new Error(`No ${stage} approval. Review the artifacts and explicitly run approve ${stage}.`);
  const gate = readJSON(file);
  if ((gate.purpose ?? 'production') !== executionPurpose(config) || (pilot && gate.pilotId !== pilot.id)) throw new Error('Approval belongs to a different execution purpose');
  if (gate.targets !== undefined && (stage !== 'translation' || !Array.isArray(gate.targets) || !gate.targets.length || new Set(gate.targets).size !== gate.targets.length || gate.targets.some(p => !readManifest(root, config).some(u => u.target === p)))) throw new Error('Invalid translation approval scope');
  if (gate.contextHash !== context || (gate.outputHash !== null && gate.outputHash !== outputHash(root, config)) ||
      gate.reports?.some(([p, h]) => fileHash(safePath(root, p)) !== h)) throw new Error(`${stage} approval is stale; inputs or outputs changed`);
  if (JSON.stringify(gate.predecessor) !== JSON.stringify(predecessor(root, config, stage, context))) throw new Error(`${stage} approval is stale; predecessor was rerun`);
  if (stage !== 'translation') {
    requireGate(root, config, 'translation', context);
    const units = readManifest(root, config);
    if (!units.length || !units.every(u => done(root, u, context))) throw new Error('Reviewed translation receipts are missing or stale');
  }
  return gate;
}
export async function runCommand(root, config, name, { signal, target } = {}) {
  const argv = config.commands?.[name];
  if (!argv) throw new Error(`Configure commands.${name} as an argv array before running this stage`);
  const args = argv.map(value => target ? value.replaceAll('{target}', target) : value);
  if (args.some(v => v.includes('{target}'))) throw new Error('Unresolved {target} in command');
  const start = stamp();
  const r = await runProcess(args[0], args.slice(1), { cwd: root, signal, timeoutMs: config.commandTimeoutSeconds * 1000 });
  return { ...r, command: args, startedAt: start, finishedAt: stamp() };
}
export async function runJudgePreparation(root, config, { signal } = {}) {
  if (signal?.aborted) throw new Error('Interrupted');
  if (executionPurpose(config) !== 'production') throw new Error('Early judge preparation belongs to the production preparation phase');
  const release = lockRun(root, 'judge-preparation'), executionId = crypto.randomUUID();
  const file = safePath(root, 'migration/results/judge-preparation.json');
  let result;
  try {
    requirePhase(root, config, '00');
    const inputHash = judgeInputHash(root, config);
    result = { schemaVersion: 1, executionId, stage: 'judge-preparation', purpose: 'production', inputHash,
      success: false, equivalence: 'unverified', verificationMode: config.verificationMode ?? 'runtime', startedAt: stamp(), commands: [] };
    writeJSON(file, result);
    const old = recordPath(root, 'judge');
    if (fileHash(old)) { try { writeJSON(old, { ...readJSON(old), invalidatedAt: stamp(), invalidatedBy: 'judge-preparation' }); } catch (e) { if (!(e instanceof SyntaxError)) throw e; fs.rmSync(old); } }
    invalidateAfter(root, 'judge');
    for (const name of config.verificationMode === 'source-only' ? [] : ['original', 'mutation']) {
      const attempt = { name, command: config.commands?.[name] ?? null, startedAt: stamp(), status: 'running' };
      result.commands.push(attempt); writeJSON(file, result);
      try {
        Object.assign(attempt, await runCommand(root, config, name, { signal }));
        if (attempt.code !== 0) throw new Error(`${name} failed (exit ${attempt.code}); see migration/results/judge-preparation.json`);
        attempt.status = 'success';
      } catch (e) { Object.assign(attempt, e.result, { status: 'failed', error: e.message }); throw e; }
    }
    if (signal?.aborted || judgeInputHash(root, config) !== inputHash) throw new Error('Judge preparation inputs changed or execution interrupted');
    result.success = true; return result;
  } catch (e) { if (result) result.error = e.message; throw e; }
  finally { try { if (result) {
    result.finishedAt = stamp(); writeJSON(file, result);
    recordCost(root, costEvent({ id: `judge-preparation-${executionId}`, step: '00b', startedAt: result.startedAt, finishedAt: result.finishedAt, tokens: 0, subagents: 0, model: 'none' }));
  } } finally { release(); } }
}
export async function runStage(root, config, stage, { signal } = {}) {
  if (signal?.aborted) throw new Error('Interrupted');
  if (config.verificationMode === 'source-only' && stage === 'parity') throw new Error('Parity is unverified in source-only mode; no parity receipt is created');
  if (stage === 'handoff' && config.verificationMode !== 'source-only') throw new Error('Runtime requires parity; source-only handoff is unavailable');
  const names = stage === 'handoff' || (stage === 'judge' && config.verificationMode === 'source-only') ? [] : { judge: ['original', 'mutation'], build: ['build'], smoke: ['smoke'], parity: ['original', 'parity'] }[stage];
  if (!names) throw new Error('Unknown executable stage');
  const executionId = crypto.randomUUID();
  const release = lockRun(root, stage, { runId: executionId });
  let result;
  try {
    const pilot = requirePilot(root, config);
    if (pilot && (stage === 'handoff' || (stage !== 'judge' && ['translation', 'build', 'smoke', 'parity'].indexOf(stage) > ['translation', 'build', 'smoke', 'parity'].indexOf(pilot.through)))) throw new Error('Stage is outside the authorized pilot boundary');
    if (stage === 'judge' && !pilot) requirePhase(root, config, '02');
    const context = contextHash(root, config), outputs = outputHash(root, config);
    if (stage === 'judge' && config.verificationMode === 'source-only') sourceOnlyPlan(root, config);
    if (stage !== 'judge') requireGate(root, config, stage, context);
    result = { schemaVersion: 1, executionId, stage, purpose: executionPurpose(config), predecessor: predecessor(root, config, stage, context), contextHash: context, outputHash: outputs, success: false, verificationMode: config.verificationMode ?? 'runtime', equivalence: stage === 'parity' ? 'pending' : 'unverified', startedAt: stamp(), commands: [] };
    // Publish failure/running before side effects. A crash or partial downstream
    // invalidation cannot leave a chain of apparently successful stage records.
    writeJSON(recordPath(root, stage), result);
    invalidateAfter(root, stage);
    const preparation = stage === 'judge' && !pilot ? currentJudgePreparation(root, config) : false;
    if (preparation) {
      result.preparationExecutionId = preparation.executionId;
      result.evidence = [['migration/results/judge-preparation.json', fileHash(safePath(root, 'migration/results/judge-preparation.json'))]];
      result.commands = preparation.commands.map(c => ({ ...c, reusedFrom: preparation.executionId }));
    }
    for (const name of preparation ? [] : names) {
      const attempt = { name, command: config.commands?.[name] ?? null, startedAt: stamp(), status: 'running' };
      result.commands.push(attempt); writeJSON(recordPath(root, stage), result);
      try {
        Object.assign(attempt, await runCommand(root, config, name, { signal }));
        if (attempt.code !== 0) throw new Error(`${name} failed (exit ${attempt.code}); see migration/results/${stage}.json`);
        attempt.status = 'success';
      } catch (e) {
        Object.assign(attempt, e.result, { status: 'failed', error: e.message, finishedAt: stamp() }); throw e;
      }
    }
    if (contextHash(root, config) !== context) throw new Error('Protected migration inputs changed during command execution');
    requirePilot(root, config);
    // Commands may create build artifacts but must not alter translated source outputs.
    if (stage !== 'judge' && outputHash(root, config) !== outputs) throw new Error('Output source tree changed during validation');
    result.success = true;
    if (stage === 'parity') result.equivalence = 'verified';
    if (stage === 'judge' && config.verificationMode === 'source-only') result.preparation = 'validated';
    if (stage === 'handoff') {
      result.evidence = [['migration/handoff.md', fileHash(safePath(root, 'migration/handoff.md'))]];
      result.outcome = 'Source-based migration complete; behavioral equivalence unverified';
    }
    return result;
  } catch (e) { if (result) result.error = e.message; throw e; }
  finally { try { if (result) {
    result.finishedAt = stamp(); writeJSON(recordPath(root, stage), result);
    recordCost(root, costEvent({id:`stage-${result.executionId}`,step:{judge:'00b',build:'05',smoke:'05b',parity:'05c',handoff:'06'}[stage],
      startedAt:result.startedAt,finishedAt:result.finishedAt,tokens:0,subagents:0,model:'none'}));
  } } finally { release(); } }
}

// callLimit/inputLimit lower this run's budgets (build-loop shares one budget
// across its repair rounds); they never raise the configured ones. maxCalls is
// the person's agreed budget for this one run (translate --max-calls) and
// replaces maxAgentCalls without editing the configuration.
export async function translate(root, config, adapter, { signal: userSignal, onlyTarget, evidence, repairQueue, onProgress = () => {}, callLimit, inputLimit, maxCalls: runCalls } = {}) {
  if (runCalls !== undefined && (!Number.isInteger(runCalls) || runCalls < 1 || runCalls > 10000)) throw new Error('--max-calls must be an integer from 1 to 10000');
  const maxCalls = Math.min(runCalls ?? config.maxAgentCalls, callLimit ?? Infinity);
  const maxInputBytes = Math.min(config.maxRunInputBytes ?? Infinity, inputLimit ?? Infinity);
  const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const repairing = Boolean(onlyTarget || repairQueue);
  const release = lockRun(root, repairing ? 'repair' : 'translation', { runId });
  let context, repairIntent = null, resumingRepair = false;
  const errors = [];
  const startedAt = stamp();
  const cancellation = new AbortController();
  const signal = userSignal ? AbortSignal.any([userSignal, cancellation.signal]) : cancellation.signal;
  const started = [];
  let calls = 0, reservations = 0;
  let tokens = 0, usageKnown = true, modelsKnown = true;
  // The CLI's own per-call usage records (--usage-output-file), summed per run,
  // failed calls included. One call without a record makes the total unknown.
  const measured = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, nanoAiu: 0 };
  const addUsage = source => {
    if (Number.isSafeInteger(source?.cliUsage?.inputTokens)) {
      measured.calls++;
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'nanoAiu']) if (Number.isSafeInteger(source.cliUsage[key])) measured[key] += source.cliUsage[key];
    }
    if (Number.isSafeInteger(source?.tokens) && source.tokens >= 0) tokens += source.tokens; else usageKnown = false;
  };
  const observedModels = new Set();
  // CLI versions and warnings are run evidence, not completion conditions.
  const cliVersions = new Set(), warnings = new Set(), assistedReviews = new Set();
  const noteVersion = source => {
    if (typeof source?.cliVersion === 'string') cliVersions.add(source.cliVersion);
    if (typeof source?.cliVersionWarning === 'string') warnings.add(source.cliVersionWarning);
    if (typeof source?.modelWarning === 'string') warnings.add(source.modelWarning);
  };
  let dispatchError = null;
  let budgetExhausted = false;
  const callLimitError = new Error('Agent call limit reached; resume with a new run after reviewing usage');
  const inputBudgetError = new Error('Run input budget (maxRunInputBytes) reached; resume with a new run after reviewing usage');
  const budgetStop = e => e === callLimitError || e === inputBudgetError;
  // Prompt bytes actually sent; tokens are estimated from them only for display.
  // The budget counts completed calls, so in-flight calls (<= concurrency) can overshoot it.
  let inputBytes = 0, outputBytes = 0;
  const fatal = e => { dispatchError ??= e; cancellation.abort(); return e; };
  const checkInputs = message => {
    try {
      if (contextHash(root, config) !== context) throw new Error(message);
      requirePilot(root, config);
      if (repairIntent && readRepairIntent(root, context)?.checksum !== repairIntent.checksum) throw new Error('Repair intent changed during execution');
    }
    catch (e) { throw fatal(e); }
  };
  let active = 0;
  const waiting = [];
  const acquire = async () => {
    if (active < config.concurrency) { active++; return; }
    await new Promise(resolve => waiting.push(resolve));
  };
  const free = () => { if (waiting.length) waiting.shift()(); else active--; };
  try {
    context = contextHash(root, config);
    if (config.mode !== 'preserve') throw new Error('Automated file runner supports preserve mode; redesign needs a module adapter. Use the redesign phase prompts meanwhile.');
    const approval = requireGate(root, config, 'translation', context);
    // The hook's text checks cannot see every way a file disappears; a phased
    // production run re-checks that the human-installed guardrails still exist.
    if (strictPhases(root, config) && !requirePilot(root, config)) requireGuardrails(root, '04');
    const units = readManifest(root, config);
    if (!units.length) throw new Error('Manifest is empty; refusing an empty translation run');
    if (onlyTarget && !units.some(u => u.target === onlyTarget)) throw new Error('Repair target is not in manifest');
    if (onlyTarget && repairQueue) throw new Error('Choose one --target or a --queue, not both');
    const scope = new Set(approval.targets ?? units.map(u => u.target));
    const queueInput = repairQueue ? readRepairQueue(root, config, repairQueue, context, outputHash(root, config)) : null;
    if ((onlyTarget && !scope.has(onlyTarget)) || (queueInput && [...queueInput.jobs.keys()].some(target => !scope.has(target)))) throw new Error('Repair exceeds the current translation approval scope');
    let diagnostic = null;
    if (onlyTarget) {
      if (!evidence?.startsWith('migration/')) throw new Error('Repair requires an evidence file under migration/');
      diagnostic = readReviewText(root, evidence);
      if (diagnostic.length > 16000) throw new Error('Select a diagnostic slice of at most 16000 characters');
    }
    repairIntent = readRepairIntent(root, context);
    const unfinishedRepairs = pendingRepairs(root, units, context, repairIntent);
    if (unfinishedRepairs.some(j => !scope.has(j.target))) throw new Error('Current approval omits unfinished repair targets');
    if (onlyTarget && repairIntent) {
      if (unfinishedRepairs.length) {
        if (!unfinishedRepairs.some(j => j.target === onlyTarget && j.diagnostic === diagnostic)) throw new Error('Resume the unfinished repair with its frozen diagnostic before starting a new repair');
      } else {
        // Historical receipts keep their immutable archive; a new explicit
        // single-target repair must not inherit a completed queue's diagnostic.
        fs.rmSync(safePath(root, 'migration/state/repair.json'));
        repairIntent = null;
      }
    }
    if (queueInput) {
      repairIntent = admitRepair(root, config, units, context, queueInput);
      onProgress({ unit: '(repair queue)', stage: 'repair-planned', calls });
    }
    resumingRepair = Boolean(!repairing && unfinishedRepairs.length);
    const pending = units.filter(u => queueInput ? queueInput.jobs.has(u.target) : onlyTarget ? u.target === onlyTarget : scope.has(u.target) && !done(root, u, context));
    if (pending.length) invalidateAfter(root, 'translation');
    async function work(unit) {
      const repairJob = repairIntent?.jobs.find(j => j.target === unit.target);
      const unitDiagnostic = repairJob?.diagnostic ?? diagnostic;
      let state = unitState(root, unit);
      const out = safePath(root, unit.target), currentHash = fileHash(out);
      if (!state || state.contextHash !== context || state.outputHash !== currentHash) {
        state = { schemaVersion: 1, ...unit, purpose: executionPurpose(config), contextHash: context, outputHash: currentHash, markerPolicy: config.markerPolicy ?? null,
          stage: currentHash && fs.statSync(out).size ? 'review' : 'implement', status: 'pending', round: 0, reviewMap: {}, reviews: [] };
      }
      // A lost/corrupt receipt must return to review, never complete from an old stage label.
      if (['arbitrate', 'fix', 'verify-fix', 'done'].includes(state.stage) &&
          ((state.stage === 'done' && !done(root, unit, context)) || state.reviewEvidence?.length !== 2 || state.reviewEvidence.some(e => fileHash(safePath(root, e.path)) !== e.hash) ||
           (state.arbitration && fileHash(safePath(root, state.arbitration.path)) !== state.arbitration.hash) ||
           (state.singlePass && fileHash(safePath(root, state.singlePass.fix.path)) !== state.singlePass.fix.hash))) {
        state.stage = 'review'; state.reviewMap = {}; state.reviews = []; delete state.arbitration; delete state.singlePass;
      }
      if (repairJob && (state.repairIntentId !== repairIntent.id || state.repairIntentHash !== repairIntent.checksum)) {
        state.stage = 'review'; state.reviewMap = {}; state.reviews = []; state.reviewEvidence = []; state.round = 0;
        delete state.arbitration; delete state.singlePass;
      } else if (onlyTarget && !repairJob) {
        if (!currentHash || !fs.statSync(out).size) throw new Error('Repair requires an existing nonempty target; translate missing units first');
        state.stage = 'review'; state.reviewMap = {}; state.reviews = []; state.round = 0; state.diagnostic = unitDiagnostic; delete state.singlePass;
        delete state.repairIntentId; delete state.repairIntentHash; delete state.repairDiagnosticHash;
      }
      if (repairJob) {
        if (!currentHash || !fs.statSync(out).size) throw new Error('Repair requires an existing nonempty target; restore its candidate before resuming');
        state.repairIntentId = repairIntent.id; state.repairIntentHash = repairIntent.checksum;
        state.repairDiagnosticHash = repairJob.diagnosticHash; state.diagnostic = unitDiagnostic;
      }
      state.runId = runId;
      const save = () => { state.updatedAt = stamp(); writeJSON(statePath(root, unit), state); };
      const invoke = async (role, extra = {}, review = null) => {
        if (signal?.aborted) throw new Error('Interrupted');
        if (dispatchError) throw dispatchError;
        if (role === 'implementer' || role === 'fixer') reviewEvidence(root, config, unit, state.diagnostic ?? null, { candidate: role !== 'implementer' });
        if (Number.isFinite(maxInputBytes) && inputBytes >= maxInputBytes) { budgetExhausted = true; throw inputBudgetError; }
        if (budgetExhausted || reservations >= maxCalls) { budgetExhausted = true; throw callLimitError; }
        reservations++;
        await acquire();
        const rel = `migration/runs/${runId}/${unit.id}-${state.round}-${role}-${crypto.randomUUID().slice(0, 8)}.json`;
        const attempt = { role, unit, startedAt: stamp(), status: 'running', requestedModel: config.models[role],
          ...(repairJob ? { repairIntentId: repairIntent.id, repairIntentHash: repairIntent.checksum, diagnosticHash: repairJob.diagnosticHash } : {}),
          ...(review ? { reviewInputHash: review.hash, reviewInputMode: review.mode } : {}) };
        let response;
        try {
          writeJSON(safePath(root, rel), attempt);
          if (signal?.aborted) throw new Error('Interrupted');
          if (dispatchError) throw dispatchError;
          checkInputs('Migration inputs changed before worker invocation');
          calls++;
          // Transient failures (rate limits, 5xx, network) retry the same call with
          // backoff while holding the slot; each retry is a model call and counts
          // against maxAgentCalls.
          for (let retry = 0; ; retry++) {
            const sessionId = recordSession(root, runId, { role, target: unit.target });
            try { response = await adapter({ root, config, role, unit, extra, signal, reviewInput: review?.text, reviewMode: review?.mode, context, runId, sessionId }); break; }
            catch (e) {
              if (!isTransientFailure(e) || retry >= (config.transientRetries ?? 2) || signal?.aborted || dispatchError || reservations >= maxCalls) throw e;
              // The failed attempt was a model call too: count its usage or mark the total unknown.
              addUsage(e); e.usageCounted = true;
              (attempt.retries ??= []).push({ error: e.message.slice(0, 500), at: stamp() });
              writeJSON(safePath(root, rel), attempt);
              onProgress({ unit: unit.target, stage: `${role} retry ${retry + 1} after transient failure`, calls });
              await sleep(retryDelayMs(config, retry), undefined, { signal }).catch(() => { throw new Error('Interrupted'); });
              checkInputs('Migration inputs changed before worker invocation');
              // Other units may have spent the budget while this one waited:
              // re-check and reserve with no await in between.
              if (dispatchError || reservations >= maxCalls) throw e;
              reservations++; calls++;
            }
          }
          noteVersion(response);
          if (Number.isSafeInteger(response.promptBytes)) inputBytes += response.promptBytes;
          if (Number.isSafeInteger(response.responseBytes)) outputBytes += response.responseBytes;
          addUsage(response);
          // A manually submitted model string is not measured execution metadata.
          const observed = response.observedModel;
          if (typeof observed === 'string' && observed.trim()) observedModels.add(observed); else modelsKnown = false;
          {
            if (signal?.aborted) throw new Error('Interrupted');
            checkInputs('Migration inputs changed during worker invocation');
            if (fileHash(out) !== state.outputHash) throw new Error('Output changed during worker invocation; refusing to overwrite');
          }
          validateResult(role, response.result, unit);
          Object.assign(attempt, response, { status: 'success', finishedAt: stamp() });
          writeJSON(safePath(root, rel), attempt);
          return { path: rel, hash: fileHash(safePath(root, rel)), result: response.result };
        } catch (e) {
          // A failed invocation counts its usage when the CLI recorded it; the
          // run total is unknown either way, since the response never completed.
          if (!e?.usageCounted) addUsage(e);
          usageKnown = false; modelsKnown = false;
          noteVersion(e);
          // Only systemic failures stop every unit; others block this unit alone.
          if (!budgetStop(e) && isSystemicFailure(e)) dispatchError ??= e;
          Object.assign(attempt, { status: 'failed', finishedAt: stamp(), error: e.message,
            process: e.result ?? null, ...(e.cliVersion !== undefined ? { cliVersion: e.cliVersion } : {}), ...(e.cliSessionId ? { cliSessionId: e.cliSessionId } : {}), ...(e.cliVersionWarning ? { cliVersionWarning: e.cliVersionWarning } : {}), ...((e.response ?? response?.result) ? { response: e.response ?? response.result } : {}) });
          writeJSON(safePath(root, rel), attempt); throw e;
        } finally { free(); }
      };
      const put = result => {
        // Only the coordinator has write access. Never take a destination from model output.
        validateResult('implementer', result, unit);
        const destination = assertOutputPath(root, config, unit.target, unit.source);
        if (fileHash(destination) !== state.outputHash) throw new Error('Output changed concurrently; refusing to overwrite');
        atomicWrite(destination, result.content);
        state.outputHash = fileHash(safePath(root, unit.target));
        state.reviewMap = {}; state.reviews = []; state.reviewEvidence = []; delete state.arbitration; delete state.singlePass; state.stage = 'review'; save();
      };
      // fixPolicy single-pass (upstream Step 3): the reviewed candidate gets one
      // fix of its confirmed findings and keeps those reviews as its evidence;
      // the build, smoke and parity referees judge the fixed output.
      const putFixed = response => {
        validateResult('implementer', response.result, unit);
        const destination = assertOutputPath(root, config, unit.target, unit.source);
        if (fileHash(destination) !== state.outputHash) throw new Error('Output changed concurrently; refusing to overwrite');
        const reviewedOutputHash = state.outputHash;
        // "Can't fix it, flag it": an unchanged candidate leaves confirmed findings open.
        if (hash(response.result.content) === reviewedOutputHash) throw new Error('Fixer returned the reviewed candidate unchanged; confirmed findings remain open (fixPolicy single-pass)');
        atomicWrite(destination, response.result.content);
        state.outputHash = fileHash(destination);
        state.singlePass = { reviewedOutputHash, fix: { path: response.path, hash: response.hash },
          confirmed: state.confirmed.map(f => f.reference).sort(), arbitrated: Boolean(state.arbitration) };
        state.stage = config.commands?.typecheck ? 'verify-fix' : 'done'; save();
      };
      try {
        for (;;) {
          if (signal?.aborted) throw new Error('Interrupted');
          // 'done' is an internal transition until marker/typecheck/input checks
          // finish. A stop here must never publish a completed receipt.
          state.status = state.stage === 'done' ? 'validating' : state.stage;
          save(); onProgress({ unit: unit.target, stage: state.status, calls });
          if (state.stage === 'implement') {
            const response = await invoke('implementer'); state.implementation = response.path; put(response.result);
          } else if (state.stage === 'review') {
            if (config.commands?.typecheck && !(state.diagnostic && state.round === 0)) {
              let check;
              try { check = await runCommand(root, config, 'typecheck', { target: unit.target, signal }); }
              catch (e) { state.typecheck = e.result ?? { error: e.message }; throw e; }
              if (check.code !== 0) {
                // README Step 4 dissolved: the cheap referee runs inside the loop and
                // its errors are a confirmed finding for the fixer, within maxFixRounds.
                state.typecheck = check;
                const output = `${check.stdout ?? ''}\n${check.stderr ?? ''}`.trim().slice(-4000);
                state.confirmed = [{ id: 'TC1', reference: 'typecheck:TC1', message: `Unit typecheck failed (exit ${check.code})`,
                  evidence: output || 'typecheck produced no output', rule: 'In-loop typecheck (README Step 4; RULEBOOK §0 referee)' }];
                state.reviewMap = {}; state.reviews = []; state.reviewEvidence = []; delete state.arbitration;
                state.stage = 'fix'; save(); continue;
              }
            }
            const review = reviewEvidence(root, config, unit, state.diagnostic ?? null);
            state.reviewInputMode = review.mode;
            if (review.mode === 'tool-assisted') { assistedReviews.add(unit.target); warnings.add(`Review evidence for ${unit.target} exceeded maxReviewInputBytes; both reviewers read the hash-bound file list with read-only tools instead of a frozen input`); }
            if (state.reviewInputHash !== review.hash) { state.reviewMap = {}; state.reviews = []; }
            state.reviewInputHash = review.hash;
            const missing = ['reviewer-semantics', 'reviewer-rules'].filter(r => !state.reviewMap[r] ||
              fileHash(safePath(root, state.reviewMap[r].path)) !== state.reviewMap[r].hash);
            const results = await Promise.allSettled(missing.map(role => invoke(role, {}, review)));
            for (let i = 0; i < results.length; i++) if (results[i].status === 'fulfilled') state.reviewMap[missing[i]] = results[i].value;
            save();
            const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
            delete state.arbitration;
            state.reviews = ['reviewer-semantics', 'reviewer-rules'].map(r => state.reviewMap[r].path);
            state.reviewEvidence = ['reviewer-semantics', 'reviewer-rules'].map(r => ({ path: state.reviewMap[r].path, hash: state.reviewMap[r].hash }));
            state.findings = Object.entries(state.reviewMap).flatMap(([role, r]) => r.result.findings.map(f => ({ ...f, reference: `${role}:${f.id}` })));
            state.samePlace = pairFindings(state.reviewMap).samePlace;
            state.stage = state.findings.length ? 'arbitrate' : 'done';
            save();
          } else if (state.stage === 'arbitrate') {
            // Every finding is arbitrated: sharing a source line is not agreement.
            const { findings, samePlace } = pairFindings(state.reviewMap);
            const response = await invoke('arbiter', { findings, samePlace });
            const expected = new Set(findings.map(f => f.reference));
            for (const d of response.result.decisions) { if (!expected.delete(d.finding)) throw new Error('Unknown/duplicate arbitration finding'); }
            if (expected.size) throw new Error('Arbiter omitted findings');
            state.arbitration = { path: response.path, hash: response.hash };
            state.confirmed = findings.filter(f => response.result.decisions.find(d => d.finding === f.reference).confirmed);
            state.stage = state.confirmed.length ? 'fix' : 'done'; save();
          } else if (state.stage === 'fix') {
            if (state.round >= config.maxFixRounds) throw new Error('Fix-round limit reached; review recurring problems and propose a rule amendment');
            const response = await invoke('fixer', { confirmedFindings: state.confirmed, diagnostic: state.diagnostic ?? null });
            state.round++; state.fix = response.path;
            // A typecheck-only fix has no reviews of its own yet, so it is reviewed.
            if (fixPolicy(config) === 'single-pass' && state.reviewEvidence?.length === 2) putFixed(response); else put(response.result);
          } else if (state.stage === 'verify-fix') {
            let check;
            try { check = await runCommand(root, config, 'typecheck', { target: unit.target, signal }); }
            catch (e) { state.typecheck = e.result ?? { error: e.message }; throw e; }
            state.typecheck = check;
            if (check.code !== 0) {
              // The fix broke the cheap referee: the fixed output needs the full loop.
              state.reviewMap = {}; state.reviews = []; state.reviewEvidence = []; delete state.arbitration; delete state.singlePass;
              state.stage = 'review'; save(); continue;
            }
            state.stage = 'done'; save();
          } else if (state.stage === 'done') {
            state.markerEvidence = requireMarkers(config, readReviewText(root, unit.target));
            if (config.commands?.typecheck && state.diagnostic && state.round === 0) {
              let check;
              try { check = await runCommand(root, config, 'typecheck', { target: unit.target, signal }); }
              catch (e) { state.typecheck = e.result ?? { error: e.message }; throw e; }
              state.typecheck = check;
              if (check.code !== 0) throw new Error('Repair reviewers found no actionable issue but typecheck still fails');
            }
            checkInputs('Migration inputs changed; receipts need fresh approval');
            if (fileHash(safePath(root, unit.target)) !== state.outputHash) throw new Error('Output changed during review');
            state.status = 'done'; delete state.error; save(); onProgress({ unit: unit.target, stage: 'done', calls }); break;
          } else throw new Error(`Unknown unit stage: ${state.stage}`);
        }
      } catch (e) {
        // Input failures can also surface while building review/typecheck evidence.
        try { checkInputs('Migration inputs changed; fresh approval required'); } catch {}
        if (!budgetStop(e) && isSystemicFailure(e)) dispatchError ??= e; state.status = 'blocked'; state.error = e.message; save(); errors.push({ target: unit.target, error: e.message }); }
    }
    // Only dependencies which are actual conversion jobs impose target order.
    // All others remain immutable source evidence in reviewInput.
    // dependencyOrder decides whether translated dependencies gate dependents.
    // Without the wait, every unit starts from fixed source, as upstream's
    // batch fan-out does; build/smoke/parity still check integration.
    const dependencies = waitsForDependencies(config) ? unitDependencies(root, config, units) : new Map(units.map(u => [u, new Set()]));
    const cycles = pending.filter(u => [...dependencies.get(u)].some(d => dependencies.get(d)?.has(u)));
    if (cycles.length && config.commands?.typecheck) throw new Error(`Cyclic translation dependencies with unit typecheck: ${cycles.map(u => u.source).join(', ')}. Audit the dependency map; group the cycle into an atomic unit or explicitly defer unit typecheck until the target graph exists and use build/smoke validation.`);
    // reviewSources is transitive: mutual reachability identifies each SCC.
    // With no unit typecheck, members consume fixed source only, so intra-SCC
    // ordering is unnecessary; dependencies outside the SCC still apply.
    const cyclicEdges = [...dependencies].flatMap(([u, deps]) => [...deps].filter(d => dependencies.get(d)?.has(u)).map(d => [u, d]));
    for (const [u, d] of cyclicEdges) dependencies.get(u).delete(d);
    const queue = [...pending], running = new Map();
    // Circuit breaker: several failures in a row without any success usually
    // share one cause; stop dispatching instead of spending more calls.
    const maxConsecutive = config.maxConsecutiveFailures ?? 3;
    let consecutiveFailures = 0, tripped = false;
    const complete = new Set(units.filter(u => done(root, u, context) && !(repairing && pending.includes(u))));
    try {
    while (queue.length || running.size) {
      while (!signal?.aborted && !dispatchError && !budgetExhausted && !tripped && queue.length && running.size < config.concurrency) {
        checkInputs('Migration inputs changed; fresh approval required');
        const index = queue.findIndex(u => [...dependencies.get(u)].every(d => complete.has(d)));
        if (index < 0) break;
        const [unit] = queue.splice(index, 1);
        const task = work(unit).then(() => ({ unit }), error => ({ unit, error }));
        started.push(task); running.set(unit, task);
      }
      if (!running.size) {
        // Units left in the queue wait on a failed or unfinished dependency.
        if (queue.length && !signal?.aborted && !dispatchError && !budgetExhausted && !tripped) {
          for (const u of queue) errors.push({ target: u.target, error: `Waiting on unfinished dependencies (${[...dependencies.get(u)].filter(d => !complete.has(d)).map(d => d.target).join(', ') || 'unknown'}); review blocked upstream receipts` });
        }
        break;
      }
      const { unit, error } = await Promise.race(running.values());
      running.delete(unit);
      if (error) errors.push({ target: unit.target, error: error.message });
      // A unit's own failure is recorded by work(); it resolves without throwing.
      if (done(root, unit, context)) { complete.add(unit); consecutiveFailures = 0; }
      else if (!budgetExhausted && !signal?.aborted && !dispatchError && ++consecutiveFailures >= maxConsecutive && !tripped) {
        tripped = true;
        errors.push({ target: '(run)', error: `Stopped dispatching after ${consecutiveFailures} consecutive unit failures; they likely share one cause (maxConsecutiveFailures)` });
      }
    }
    } catch (e) { fatal(e); errors.push({ target: '(inputs)', error: e.message }); }
    // The lock covers every started worker, including adapters that ignore abort.
    const settled = await Promise.all(started);
    for (const {unit, error} of settled) if (error && !errors.some(e => e.target === unit.target && e.error === error.message)) errors.push({target: unit.target, error: error.message});
    let completed = new Set();
    try { completed = new Set(units.filter(u => done(root, u, context))); }
    catch (e) { if (!dispatchError) { fatal(e); errors.push({target: '(inputs)', error: e.message}); } }
    if (dispatchError && !errors.some(e => e.error === dispatchError.message)) errors.unshift({target: '(inputs)', error: dispatchError.message});
    const required = repairing ? pending : units.filter(u => scope.has(u.target));
    // Units this run finished: the basis for status time and usage estimates.
    const unitsCompleted = [...completed].filter(u => { try { return unitState(root, u)?.runId === runId; } catch { return false; } }).length;
    const report = { runId, purpose: executionPurpose(config), startedAt, finishedAt: stamp(), contextHash: context, agentCalls: calls, unitsCompleted, concurrency: config.concurrency,
      ...(repairIntent ? { repairIntentId: repairIntent.id, pendingRepairs: pendingRepairs(root, units, context, repairIntent).map(j => j.target) } : {}),
      done: completed.size, total: units.length, scopeTargets: required.map(u => u.target), scopeComplete: required.every(u => completed.has(u)), errors,
      ...(cliVersions.size ? { cliVersions: [...cliVersions].sort() } : {}), ...(observedModels.size ? { observedModels: [...observedModels].sort() } : {}), ...(warnings.size ? { warnings: [...warnings] } : {}),
      ...(assistedReviews.size ? { toolAssistedReviews: [...assistedReviews].sort() } : {}),
      // Bytes are measured; tokens are a rough 4-bytes-per-token estimate, never billing data.
      usageEstimate: { promptBytes: inputBytes, responseBytes: outputBytes, estimatedInputTokens: Math.ceil(inputBytes / 4), estimatedOutputTokens: Math.ceil(outputBytes / 4), basis: 'estimate: bytes / 4; AI Credits are not measured' },
      ...(measured.calls ? { measuredUsage: { ...measured, complete: usageKnown, basis: 'Copilot CLI --usage-output-file per call, failed calls included when the CLI wrote usage; complete is false when any call had no record' } } : {}),
      ...(config.maxRunInputBytes ? { maxRunInputBytes: config.maxRunInputBytes } : {}) };
    writeJSON(safePath(root, `migration/runs/${runId}/summary.json`), report);
    recordCost(root, costEvent({id:`run-${runId}`,step:executionPurpose(config) === 'pilot' ? '03' : repairing || resumingRepair ? '05' : '04',startedAt,finishedAt:report.finishedAt,
      subagents:calls,tokens:usageKnown ? tokens : null,model:modelsKnown ? [...observedModels].sort().join(',') || 'none' : null}));
    if (errors.length || signal?.aborted || required.some(u => !completed.has(u))) throw Object.assign(new Error(`Translation stopped: ${errors.map(e => `${e.target}: ${e.error}`).join('; ') || (signal?.aborted ? 'Interrupted' : 'Reviewed receipts incomplete')}`), { report, budgetStop: budgetExhausted });
    return report;
  } finally { release(); }
}

// The explicit parent pilot grant authorizes these finite, isolated operations.
// This helper never approves any stage in the production project.
export async function runPilot(root, config, adapter, options = {}) {
  const grant = requirePilot(root, config);
  if (!grant) throw new Error('pilot run requires an authorized isolated pilot project');
  const results = [{ stage: 'judge', result: await runStage(root, config, 'judge', options) }];
  approve(root, config, 'translation', `Pilot ${grant.id}: ${grant.note}`);
  results.push({ stage: 'translation', result: await translate(root, config, adapter, options) });
  for (const stage of ['build', 'smoke', 'parity'].slice(0, ['translation', 'build', 'smoke', 'parity'].indexOf(grant.through))) {
    approve(root, config, stage, `Pilot ${grant.id}: ${grant.note}`);
    results.push({ stage, result: await runStage(root, config, stage, options) });
  }
  return { purpose: 'pilot', pilotId: grant.id, productionCompletion: false, results };
}
