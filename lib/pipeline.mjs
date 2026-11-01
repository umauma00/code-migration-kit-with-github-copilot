// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import crypto from 'node:crypto';
import { safePath, assertOutputPath, hash, fileHash, treeHash, stamp, atomicWrite, writeJSON, readJSON,
  readManifest, contextHash, statePath, unitState, done, lockRun, sourceOnlyPlan, readRepairIntent, waitsForDependencies, fixPolicy, workerEffort, workerContext } from './core.mjs';
import { validateResult } from './results.mjs';
import { runProcess, relativeProcessOutput } from './process.mjs';
import { reviewEvidence, readReviewText, pairFindings, legacySources } from './review.mjs';
import { requirePhase, strictPhases, phaseWaiver, gateError, retireWaiver, autoPhases } from './phases.mjs';
import { requireGuardrails } from './guardrails.mjs';
import { costEvent, recordCost } from './cost.mjs';
import { markerEvidence, markerError } from './markers.mjs';
import { executionPurpose, requirePilot } from './pilot.mjs';
import { judgeInputHash, currentJudgePreparation } from './judge.mjs';
import { selectTranslationScope, unitDependencies, readRepairQueue } from './scopes.mjs';
import { admitRepair, pendingRepairs } from './repair.mjs';
import { isTransientFailure, isSystemicFailure, retryDelayMs, isHostStall, isLimitedRetry, hostStallRetries } from './failures.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { executionLimits, ignoredLimits, processTimeout } from './execution-policy.mjs';
import { recordSession } from './sessions.mjs';
import { pendingRegeneration } from './generated.mjs';

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
// The workflow phase each runner record completes. In relaxed mode a waiver of
// that phase stands in for a missing record (see phases.mjs).
const stagePhase = { judge: '03', translation: '04', build: '05', smoke: '05b', parity: '05c' };
// Every translation unit reviewed, or (relaxed mode) phase 04 waived.
const unitsReviewed = (root, config, context) => { const units = readManifest(root, config); return units.length > 0 && units.every(u => done(root, u, context)); };
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
    // A record made on a waiver holds while that waiver does and the phase is
    // still unfinished; once the predecessor really runs, this stage runs again.
    if (r.predecessor?.waivedPhase) { if (p || r.predecessor.stage !== previous || r.predecessor.waiverHash !== phaseWaiver(root, stagePhase[previous]).hash) return false; }
    else if (!p || r.predecessor?.stage !== previous || r.predecessor.executionId !== p.executionId) return false;
  }
  return r;
}
function predecessor(root, config, stage, context) {
  const previous = previousStage[stage];
  if (!previous) return null;
  const record = currentRecord(root, config, previous, context, previous !== 'judge');
  if (record) return { stage: previous, executionId: record.executionId };
  // Pilots never use production waivers.
  const waiver = executionPurpose(config) === 'production' && phaseWaiver(root, stagePhase[previous]);
  if (waiver) return { stage: previous, waivedPhase: stagePhase[previous], waiverHash: waiver.hash };
  throw gateError(root, `Run ${previous} successfully for the current inputs first`, stagePhase[previous]);
}
export function approve(root, config, stage, note, options = {}) {
  if (!['translation', 'build', 'smoke', 'parity', 'post-parity', 'handoff'].includes(stage)) throw new Error('Unknown approval stage');
  if (stage === 'handoff' && config.verificationMode !== 'source-only') throw new Error('handoff is only available in source-only mode; runtime requires parity');
  if (config.verificationMode === 'source-only' && ['parity', 'post-parity'].includes(stage)) throw new Error('Source-only equivalence is unverified; use smoke then handoff');
  if (!note?.trim()) throw new Error('Approval requires --note describing what was reviewed');
  if (stage !== 'translation' && (options.batch !== undefined || options.targets !== undefined)) throw new Error('Batch/target scopes apply only to translation approval');
  // A validation approval issued by the host-confirmed build-loop grant records it.
  if (options.loop !== undefined && (!['build', 'smoke', 'parity'].includes(stage) || typeof options.loop?.grantId !== 'string' || !Number.isInteger(options.loop?.round))) throw new Error('Only build, smoke and parity approvals can belong to a build-loop grant');
  const release = lockRun(root, `approve-${stage}`);
  try {
  const pilot = requirePilot(root, config);
  if (pilot && (['post-parity', 'handoff'].includes(stage) || ['translation', 'build', 'smoke', 'parity'].indexOf(stage) > ['translation', 'build', 'smoke', 'parity'].indexOf(pilot.through))) throw new Error('Stage is outside the authorized pilot boundary');
  const context = contextHash(root, config);
  if (stage === 'translation') {
    if (!pilot) requirePhase(root, config, '03');
    for (const p of translationReports(root, pilot)) {
      const f = safePath(root, p);
      if ((!fs.existsSync(f) || fs.statSync(f).size === 0) && (pilot || !phaseWaiver(root, reportPhase[p]))) throw gateError(root, `Review artifact required: ${p}`, pilot ? null : reportPhase[p]);
    }
    if (!currentRecord(root, config, 'judge', context, false) && (pilot || !phaseWaiver(root, '03'))) throw gateError(root, 'Run judge successfully for these inputs before approving translation', pilot ? null : '03');
  } else {
    const reviewed = unitsReviewed(root, config, context);
    if (!reviewed && (pilot || !phaseWaiver(root, '04'))) throw gateError(root, 'All translation units must have current reviewed receipts', pilot ? null : '04');
    requireGate(root, config, 'translation', context);
    // A generated file the person chose to regenerate is not a translation
    // unit; its target must exist before anything is built.
    const regenerate = pendingRegeneration(root, config);
    if (regenerate.length) throw new Error(`Regenerate first (${regenerate.length} pending; see migration/generated-files.json): ${regenerate.slice(0, 3).map(e => `${e.target} from ${e.input} with ${e.how}`).join('; ')}`);
    // Every unit reviewed: phase 04 is done for real.
    if (reviewed && !pilot) retireWaiver(root, '04');
  }
  if (stage === 'handoff' && (!fileHash(safePath(root, 'migration/handoff.md')) || fs.statSync(safePath(root, 'migration/handoff.md')).size === 0)) throw new Error('Review artifact required: migration/handoff.md');
  if (stage === 'handoff') requirePhase(root, config, '05c');
  const selected = stage === 'translation' ? selectTranslationScope(root, config, context, options) : null;
  if (selected && pendingRepairs(root, readManifest(root, config), context).some(j => !selected.includes(j.target))) throw new Error('Translation scope omits unfinished repair targets; resume the admitted repair intent');
  // Auto mode keeps a current approval the person recorded instead of replacing it.
  if (autoPhases(root) && !selected && options.loop === undefined && fs.existsSync(gatePath(root, stage))) {
    const old = readJSON(gatePath(root, stage));
    if (!old.auto) { try { requireGate(root, config, stage, context); return old; } catch {} }
  }
  const gate = { schemaVersion: 1, stage, purpose: executionPurpose(config), ...(pilot ? { pilotId: pilot.id } : {}), note, approvedAt: stamp(), contextHash: context,
    ...(selected ? { targets: selected } : {}), ...(options.loop ? { loop: options.loop } : {}),
    predecessor: predecessor(root, config, stage, context),
    outputHash: stage === 'translation' ? null : outputHash(root, config),
    reports: stage === 'translation' ? translationReports(root, pilot).map(p => [p, fileHash(safePath(root, p))]) : stage === 'handoff' ? [['migration/handoff.md', fileHash(safePath(root, 'migration/handoff.md'))]] : [],
    // Auto mode approves without the person; say so.
    ...(autoPhases(root) ? { auto: true } : {}) };
  writeJSON(gatePath(root, stage), gate);
  return gate;
  } finally { release(); }
}
// The reports a translation approval reviews. In relaxed mode a report whose
// phase was waived may be missing; it is recorded with a null hash, so the
// approval goes stale once the report is written.
const reportPhase = { 'migration/feasibility.md': '00', 'migration/stress-test/report.md': '03' };
const translationReports = (root, pilot) => pilot ? ['migration/feasibility.md', 'migration/pilot.json'] : ['migration/feasibility.md', 'migration/stress-test/report.md'];
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
    if (!unitsReviewed(root, config, context) && (pilot || !phaseWaiver(root, '04'))) throw gateError(root, 'Reviewed translation receipts are missing or stale', pilot ? null : '04');
  }
  return gate;
}
export async function runCommand(root, config, name, { signal, target } = {}) {
  const argv = config.commands?.[name];
  if (!argv) throw new Error(`Configure commands.${name} as an argv array before running this stage`);
  const args = argv.map(value => target ? value.replaceAll('{target}', target) : value);
  if (args.some(v => v.includes('{target}'))) throw new Error('Unresolved {target} in command');
  const start = stamp();
  const r = await runProcess(args[0], args.slice(1), { cwd: root, signal, timeoutMs: processTimeout(config, 'commandTimeoutSeconds'), outputDir: safePath(root, 'migration/runs/process-output') })
    .catch(e => { if (e.result) e.result = relativeProcessOutput(e.result, root); throw e; });
  return { ...relativeProcessOutput(r, root), command: args, startedAt: start, finishedAt: stamp() };
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
    // A real record of the phase this stage completes retires its waiver.
    if (!pilot && ['build', 'smoke', 'parity'].includes(stage)) retireWaiver(root, stagePhase[stage]);
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

// Explicit per-command budgets still apply. Saved default budgets apply only
// in bounded mode; normal execution continues until the approved scope is done.
// Every supplied reference decided exactly once: null, or what went wrong.
// error keeps the wording existing records and guidance match.
export function arbitrationProblem(references, decisions) {
  const expected = new Set(references), unknown = [], repeated = [];
  for (const d of decisions) {
    if (expected.delete(d.finding)) continue;
    // The slip is shown back to the arbiter: keep a runaway value short.
    (references.includes(d.finding) ? repeated : unknown).push(String(d.finding).slice(0, 120));
  }
  if (unknown.length || repeated.length) return { error: 'Unknown/duplicate arbitration finding',
    message: [unknown.length ? `Unknown finding ${unknown.map(r => JSON.stringify(r)).join(', ')}` : '', repeated.length ? `Decided more than once: ${repeated.map(r => JSON.stringify(r)).join(', ')}` : '', expected.size ? `Missing: ${[...expected].map(r => JSON.stringify(r)).join(', ')}` : ''].filter(Boolean).join('; ') };
  if (expected.size) return { error: 'Arbiter omitted findings', message: `Missing: ${[...expected].map(r => JSON.stringify(r)).join(', ')}` };
  return null;
}
// A worker answer that misses its contract (not one JSON object, the wrong
// shape) is a slip of that one call, not a rule problem.
// An answer that ended without a final message (an empty reply or a tool
// call: "Copilot JSONL is incomplete") is such a slip too.
const contractSlips = /^(?:Agent did not return one valid JSON object|Copilot JSONL is incomplete|Result schemaVersion\/target mismatch|Expected implementation result|Result requires |Invalid (?:review|arbitration) result|Duplicate finding id|Review verdict contradicts findings|Arbitration requires confirmed boolean)/;
export const contractSlip = e => e?.code === 'INVALID_AGENT_RESULT' || contractSlips.test(String(e?.message ?? ''));
const endedEarly = /^Copilot JSONL is incomplete/;
// The slips that block only their own unit and may clear on one more pass: a
// contract slip, arbitration references, a single-pass fix that changed
// nothing. A wrong trailer is not among them: it blocks only after the fixer
// had it twice in this run, and one more pass would review it again first.
export const unitSlip = message => contractSlips.test(String(message ?? '')) ||
  /^(?:Unknown\/duplicate arbitration finding|Arbiter omitted findings|Fixer returned the reviewed candidate unchanged)/.test(String(message ?? ''));
// "Can't fix it, flag it" (upstream): a fixer that returned the file unchanged
// is told to flag what this file cannot fix instead.
const unchangedFix = config => `You returned the current candidate unchanged, but the findings in extra.confirmedFindings are still open. Change the file for each one. When one cannot be fixed in this file (it needs an inventory or RULEBOOK change, or a change in another file), add a line "TODO(port): <its reference>: <what is needed>" where it applies${config.markerPolicy ? ' and count it in the PORT STATUS trailer' : ''}, instead of returning the file unchanged.`;
// A single-pass fix is not reviewed again, so one that changed no code (only
// comments: TODO(port) lines, the trailer) must name each finding it leaves
// open; it is asked once to fix or name the rest. What it leaves open is
// reported (selfRepairs.flagged): a deliberate trade-off of single-pass, as
// upstream.
const unnamedFlags = (references, config) => `Your change fixes no code (it changes only comments, TODO(port) lines or the trailer), so ${references.join(', ')} ${references.length === 1 ? 'is' : 'are'} neither fixed nor named. Fix each finding in extra.confirmedFindings in the code; only when this file cannot fix one, name its reference in its TODO(port) line ("TODO(port): <its reference>: <what is needed>")${config.markerPolicy ? ' and count it in the PORT STATUS trailer' : ''}.`;
// The file's code, to tell whether a fix changed any. Comments are left out
// (whole comment lines, inline /* */ and <!-- --> parts, a trailing //, # or
// -- comment after balanced quotes; TODO(port) flags and the trailer are
// comments), and so are the spaces around each line and blank lines. A
// heuristic, not a parser: equal means the fix changed no code.
// A line starting with ' is code (a string), never a VB comment: targets are not VB.
const commentLine = /^(?:\/\/|\/\*|\*\/|\*(?:\s|$)|#(?:\s|$)|--\s|<!--|-->)/;
const balanced = text => ['"', "'", '`'].every(q => text.split(q).length % 2 === 1);
export function codeOf(text) {
  return text.split(/\r?\n/).map(raw => {
    let line = raw.replace(/\/\*.*?\*\//g, ' ').replace(/<!--.*?-->/g, ' ')
      .replace(/(?:\/\/+|#+|--|'|\bREM\b)?[ \t]*(?:TODO\(port\)|PORT STATUS:).*$/i, '').trim();
    if (commentLine.test(line)) return '';
    for (const m of line.matchAll(/\s(?:\/\/|#\s|--\s)/g)) if (balanced(line.slice(0, m.index))) { line = line.slice(0, m.index).trim(); break; }
    return line;
  }).filter(Boolean).join('\n');
}
// TODO(port) lines the fixed file has and the candidate had not.
const addedFlags = (before, after) => {
  const old = before.split(/\r?\n/).filter(line => line.includes('TODO(port)'));
  return after.split(/\r?\n/).filter(line => {
    if (!line.includes('TODO(port)')) return false;
    const i = old.indexOf(line);
    if (i < 0) return true;
    old.splice(i, 1); return false;
  });
};
// A finding about comments (the trailer, a TODO(port) line, a doc comment, a
// license header) is fixed in comments.
const aboutComments = f => /PORT STATUS|TODO\(port\)|\btodos\s*=\s*\d|\bconfidence\s*=\s*(?:high|medium|low)\b|\bcomments?\b|\bdocstrings?\b|\b(?:license|copyright)\b/i.test(`${f.message ?? ''} ${f.evidence ?? ''}`);
// A line names a reference only whole: reviewer-rules:F10 does not name F1.
const names = (line, reference) => new RegExp(`(?<![\\w-])${reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`).test(line);
// The confirmed findings a fix leaves open: those named in a TODO(port) line
// it added, and, when it changed no code, every one not about comments
// (unnamed: those of them no added line names).
function openFindings(before, after, confirmed) {
  const added = addedFlags(before, after), codeKept = codeOf(before) === codeOf(after);
  const named = f => added.some(line => names(line, f.reference));
  return { unnamed: codeKept ? confirmed.filter(f => !aboutComments(f) && !named(f)).map(f => f.reference) : [],
    open: confirmed.filter(f => named(f) || (codeKept && !aboutComments(f))).map(f => f.reference).sort() };
}
export async function translate(root, config, adapter, { signal: userSignal, onlyTarget, evidence, repairQueue, onProgress = () => {}, callLimit, inputLimit, maxCalls: runCalls } = {}) {
  if (runCalls !== undefined && (!Number.isInteger(runCalls) || runCalls < 1 || runCalls > 10000)) throw new Error('--max-calls must be an integer from 1 to 10000');
  const limits = executionLimits(config);
  const maxCalls = Math.min(runCalls ?? limits.calls, callLimit ?? Infinity);
  const maxInputBytes = Math.min(limits.inputBytes, inputLimit ?? Infinity);
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
  // What the run fixed by itself, for the summary: answers asked again,
  // trailers sent back to the fixer, and the last pass over slipped units.
  const selfRepairs = { corrections: 0, markerFixes: 0 };
  let repassUnits = null;
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
    if (typeof source?.cliHomeWarning === 'string') warnings.add(source.cliHomeWarning);
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
    // Progress lines count this run's units: finished so far out of pending.
    const notify = onProgress;
    let finished = 0;
    onProgress = event => notify({ ...event, done: event.stage === 'done' ? ++finished : finished, total: pending.length });
    // Units blocked by a slip of one answer; the run gives them one more pass.
    const slipBlocked = new Set();
    async function work(unit) {
      const repairJob = repairIntent?.jobs.find(j => j.target === unit.target);
      const unitDiagnostic = repairJob?.diagnostic ?? diagnostic;
      let state = unitState(root, unit);
      const out = safePath(root, unit.target), currentHash = fileHash(out);
      if (!state || state.contextHash !== context || state.outputHash !== currentHash) {
        state = { schemaVersion: 1, ...unit, purpose: executionPurpose(config), contextHash: context, outputHash: currentHash, markerPolicy: config.markerPolicy ?? null,
          stage: currentHash && fs.statSync(out).size ? 'review' : 'implement', status: 'pending', round: 0, reviewMap: {}, reviews: [] };
      }
      // A trailer fix (marker:M1) is bounded by its own count per run, not by
      // maxFixRounds, and has no reviews by design: its fixed file is reviewed.
      const trailerFix = () => state.confirmed?.length > 0 && state.confirmed.every(f => f.reference === 'marker:M1');
      // A lost/corrupt receipt must return to review, never complete from an old stage label.
      if (['arbitrate', 'fix', 'verify-fix', 'done'].includes(state.stage) && !(state.stage === 'fix' && !state.reviewEvidence?.length && trailerFix()) &&
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
        // The implementer and fixer get the same evidence reviewers do: the
        // runner hands it over instead of the worker searching on its own.
        let work = null;
        if (role === 'implementer' || role === 'fixer' || role === 'arbiter') {
          if (role !== 'arbiter') work = reviewEvidence(root, config, unit, state.diagnostic ?? null, { candidate: role !== 'implementer' });
          // Frozen evidence already carries decoded legacy sources.
          const legacy = work?.mode === 'frozen' ? [] : legacySources(root, config, unit);
          if (legacy.length) extra = { ...extra, legacyEncodedSources: legacy };
          // The diagnostic is part of the evidence: do not send it twice.
          if (work && Object.hasOwn(extra, 'diagnostic')) { const { diagnostic, ...rest } = extra; extra = rest; }
        }
        if (Number.isFinite(maxInputBytes) && inputBytes >= maxInputBytes) { budgetExhausted = true; throw inputBudgetError; }
        if (budgetExhausted || reservations >= maxCalls) { budgetExhausted = true; throw callLimitError; }
        reservations++;
        await acquire();
        const rel = `migration/runs/${runId}/${unit.id}-${state.round}-${role}-${crypto.randomUUID().slice(0, 8)}.json`;
        const attempt = { role, unit, startedAt: stamp(), status: 'running', requestedModel: config.models[role], ...(workerEffort(config, role) ? { requestedEffort: workerEffort(config, role) } : {}), ...(workerContext(config, role) ? { requestedContext: workerContext(config, role) } : {}),
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
          for (let retry = 0, stalls = 0; ; retry++) {
            const sessionId = recordSession(root, runId, { role, target: unit.target });
            try { response = await adapter({ root, config, role, unit, extra, signal, reviewInput: review?.text, reviewMode: review?.mode, ...(work ? { workInput: work.text, workMode: work.mode } : {}), context, runId, sessionId }); break; }
            catch (e) {
              if (isSystemicFailure(e) || !isTransientFailure(e) || retry >= limits.retries || (isLimitedRetry(e) && stalls++ >= hostStallRetries) || signal?.aborted || dispatchError || reservations >= maxCalls) throw e;
              // The failed attempt was a model call too: count its usage or mark the total unknown.
              addUsage(e); e.usageCounted = true;
              (attempt.retries ??= []).push({ error: e.message.slice(0, 500), ...(isHostStall(e) ? { hostStall: true } : {}), at: stamp() });
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
      // One more call of the same role, told what was wrong, for a slip of its
      // answer: not one JSON object or the wrong shape, or (check) a file it
      // wrote whose trailer or single-pass fix misses the required form. It is
      // not a rule problem, so it never goes to the RULEBOOK. A second slip
      // blocks the unit; the run's last pass tries it once more.
      const ask = async (role, extra = {}, review = null, check = null) => {
        let response, correction;
        try { response = await invoke(role, extra, review); correction = check?.(response.result); }
        catch (e) {
          if (!contractSlip(e)) throw e;
          correction = `Your previous answer was rejected: ${e.message}${e.parseError ? ` (${String(e.parseError).slice(0, 200)})` : ''}. ${endedEarly.test(e.message)
            ? 'It ended without a final answer (an empty message or a tool call): your last message must be exactly one JSON object in the contract\'s form.'
            : 'Return exactly one JSON object in the contract\'s form, with nothing before or after it.'}`;
        }
        if (!correction) return response;
        selfRepairs.corrections++;
        onProgress({ unit: unit.target, stage: `${role} asked again after a slip in its answer`, calls });
        return invoke(role, { ...extra, correction }, review);
      };
      // fixPolicy single-pass: a fix of reviewed findings is not reviewed again.
      // A typecheck-only or trailer-only fix has no reviews of its own yet, so it is.
      const singlePassFix = () => fixPolicy(config) === 'single-pass' && state.reviewEvidence?.length === 2;
      // A file the implementer or fixer returns is checked before it is
      // written: its trailer, and whether a single-pass fix changed anything
      // or, changing no code, named what it left open.
      const writtenProblem = role => result => {
        if (typeof result?.content !== 'string') return null;
        const problems = [];
        if (role === 'fixer' && singlePassFix()) {
          if (hash(result.content) === state.outputHash) problems.push(unchangedFix(config));
          else {
            const { unnamed } = openFindings(fs.readFileSync(out, 'utf8'), result.content, state.confirmed);
            if (unnamed.length) problems.push(unnamedFlags(unnamed, config));
          }
        }
        const evidence = markerEvidence(config, result.content);
        if (evidence && !evidence.valid) problems.push(`The PORT STATUS trailer of your content is wrong: ${evidence.problem}.`);
        return problems.length ? `${problems.join(' ')} Return the complete file again with this corrected.` : null;
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
        // What the fix left unfixed goes into the run summary (selfRepairs.flagged).
        const { open } = openFindings(fs.readFileSync(destination, 'utf8'), response.result.content, state.confirmed);
        atomicWrite(destination, response.result.content);
        state.outputHash = fileHash(destination);
        state.singlePass = { reviewedOutputHash, fix: { path: response.path, hash: response.hash },
          confirmed: state.confirmed.map(f => f.reference).sort(), arbitrated: Boolean(state.arbitration), ...(open.length ? { flagged: open } : {}) };
        state.stage = config.commands?.typecheck ? 'verify-fix' : 'done'; save();
      };
      // A wrong trailer on the written file is a defect of this output, not a
      // rule problem. Reviewers did not always flag it (a resume reviewed it
      // again and looped), so it goes to the fixer as a confirmed finding, like
      // a typecheck error, and the fixed file is reviewed. Twice per run at
      // most, then the unit blocks with the reason.
      const trailerToFixer = evidence => {
        const tries = state.markerRepair?.runId === runId ? state.markerRepair.count : 0;
        if (tries >= 2) throw new Error(markerError(evidence));
        state.markerRepair = { runId, count: tries + 1 }; selfRepairs.markerFixes++;
        state.confirmed = [{ id: 'M1', reference: 'marker:M1', message: `The PORT STATUS trailer is wrong: ${evidence.problem}`,
          evidence: `${unit.target}: ${evidence.actual} lines contain TODO(port); the trailer claims ${evidence.claimed ?? 'no count'} (literal line count)`,
          rule: 'markerPolicy todo-lines-v1: exactly one PORT STATUS trailer, on the last nonempty line, whose todos is the number of lines containing TODO(port)' }];
        state.reviewMap = {}; state.reviews = []; state.reviewEvidence = []; delete state.arbitration; delete state.singlePass;
        onProgress({ unit: unit.target, stage: 'trailer sent back to the fixer', calls });
        state.stage = 'fix'; save();
      };
      try {
        for (;;) {
          if (signal?.aborted) throw new Error('Interrupted');
          // 'done' is an internal transition until marker/typecheck/input checks
          // finish. A stop here must never publish a completed receipt.
          state.status = state.stage === 'done' ? 'validating' : state.stage;
          save(); onProgress({ unit: unit.target, stage: state.status, calls });
          if (state.stage === 'implement') {
            const response = await ask('implementer', {}, null, writtenProblem('implementer')); state.implementation = response.path; put(response.result);
          } else if (state.stage === 'review') {
            // A file with a wrong trailer goes to the fixer before any review:
            // a worker's (still wrong after its correction), an earlier run's,
            // or one resumed after a block. Reviewing it first would spend the
            // reviewer calls on a file that changes anyway.
            const trailer = markerEvidence(config, readReviewText(root, unit.target));
            if (trailer && !trailer.valid) { trailerToFixer(trailer); continue; }
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
            const results = await Promise.allSettled(missing.map(role => ask(role, {}, review)));
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
            const references = findings.map(f => f.reference);
            let response = await ask('arbiter', { findings, samePlace, references });
            let problem = arbitrationProblem(references, response.result.decisions);
            // A miswritten reference (a copied placeholder, a dropped or doubled
            // finding) is a format slip, not a verdict: ask once more, naming
            // the slip and every reference, before blocking the unit.
            if (problem) {
              selfRepairs.corrections++;
              onProgress({ unit: unit.target, stage: 'arbiter asked again after a slip in its answer', calls });
              response = await invoke('arbiter', { findings, samePlace, references, correction: `${problem.message}. Return one decision for each reference in extra.references, copying it exactly; no other finding values.` });
              problem = arbitrationProblem(references, response.result.decisions);
              if (problem) throw new Error(problem.error);
            }
            state.arbitration = { path: response.path, hash: response.hash };
            state.confirmed = findings.filter(f => response.result.decisions.find(d => d.finding === f.reference).confirmed);
            state.stage = state.confirmed.length ? 'fix' : 'done'; save();
          } else if (state.stage === 'fix') {
            const trailerOnly = trailerFix(), singlePass = singlePassFix();
            if (!trailerOnly && state.round >= limits.fixRounds) throw new Error('Fix-round limit reached; review recurring problems and propose a rule amendment');
            const response = await ask('fixer', { confirmedFindings: state.confirmed, diagnostic: state.diagnostic ?? null }, null, writtenProblem('fixer'));
            // A round counts once its fix changed the file: a fix refused here
            // (one that changed nothing) leaves the round to the next attempt.
            const round = state.round, candidate = state.outputHash;
            if (!trailerOnly) state.round++;
            state.fix = response.path;
            try { if (singlePass) putFixed(response); else put(response.result); }
            catch (e) { if (state.outputHash === candidate) state.round = round; throw e; }
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
            // A single-pass fix with a wrong trailer goes to the fixer here.
            const evidence = markerEvidence(config, readReviewText(root, unit.target));
            if (evidence && !evidence.valid) { trailerToFixer(evidence); continue; }
            state.markerEvidence = evidence;
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
        if (!budgetStop(e) && isSystemicFailure(e)) dispatchError ??= e; state.status = 'blocked'; state.error = e.message; save(); errors.push({ target: unit.target, error: e.message });
        if (unitSlip(e.message)) slipBlocked.add(unit);
        try { onProgress({ unit: unit.target, stage: 'blocked', calls }); } catch {} }
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
    const maxConsecutive = limits.consecutiveFailures;
    let consecutiveFailures = 0, tripped = false;
    const complete = new Set(units.filter(u => done(root, u, context) && !(repairing && pending.includes(u))));
    // Units blocked by a slip of one answer get one more pass before the run
    // ends, so a second slip in a row does not need a person to run translate
    // again. A repair run resets its target to review, so it does not.
    const repass = () => {
      if (repassUnits || !slipBlocked.size || repairing || signal?.aborted || dispatchError || budgetExhausted || tripped) return false;
      repassUnits = [...slipBlocked]; slipBlocked.clear();
      // The breaker counts the last pass's own failures in a row.
      consecutiveFailures = 0;
      queue.unshift(...repassUnits);
      onProgress({ unit: '(run)', stage: `one more pass for ${repassUnits.length} unit(s) blocked by a slip in an answer`, calls });
      return true;
    };
    try {
    do {
    while (queue.length || running.size) {
      while (!signal?.aborted && !dispatchError && !budgetExhausted && !tripped && queue.length && running.size < config.concurrency) {
        checkInputs('Migration inputs changed; fresh approval required');
        const index = queue.findIndex(u => [...dependencies.get(u)].every(d => complete.has(d)));
        if (index < 0) break;
        const [unit] = queue.splice(index, 1);
        // A unit on its last pass drops its earlier error only once it runs
        // again: one never restarted (a stop, the budget) keeps it.
        if (repassUnits?.includes(unit)) for (let i = errors.length - 1; i >= 0; i--) if (errors[i].target === unit.target) errors.splice(i, 1);
        const task = work(unit).then(() => ({ unit }), error => ({ unit, error }));
        started.push(task); running.set(unit, task);
      }
      if (!running.size) {
        // A unit waiting on a slipped dependency waits for its last pass.
        if (repass()) continue;
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
    } while (repass());
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
    const finishedHere = [...completed].flatMap(u => { try { const state = unitState(root, u); return state?.runId === runId ? [{ unit: u, state }] : []; } catch { return []; } });
    const unitsCompleted = finishedHere.length;
    // Findings their single-pass fixes left unfixed: no review follows, so
    // the person hears of them.
    const leftOpen = finishedHere.filter(({ state }) => state.singlePass?.flagged?.length).map(({ unit, state }) => ({ target: unit.target, references: state.singlePass.flagged }));
    for (const { target, references } of leftOpen) warnings.add(`${target}: its single-pass fix left ${references.join(', ')} unfixed (flagged with TODO(port), or no code changed for it); no review follows a single-pass fix`);
    const report = { runId, purpose: executionPurpose(config), startedAt, finishedAt: stamp(), contextHash: context, agentCalls: calls, unitsCompleted, concurrency: config.concurrency,
      ...(repairIntent ? { repairIntentId: repairIntent.id, pendingRepairs: pendingRepairs(root, units, context, repairIntent).map(j => j.target) } : {}),
      done: completed.size, total: units.length, scopeTargets: required.map(u => u.target), scopeComplete: required.every(u => completed.has(u)), errors,
      ...(cliVersions.size ? { cliVersions: [...cliVersions].sort() } : {}), ...(observedModels.size ? { observedModels: [...observedModels].sort() } : {}), ...(warnings.size ? { warnings: [...warnings] } : {}),
      ...(assistedReviews.size ? { toolAssistedReviews: [...assistedReviews].sort() } : {}),
      // Bytes are measured; tokens are a rough 4-bytes-per-token estimate, never billing data.
      usageEstimate: { promptBytes: inputBytes, responseBytes: outputBytes, estimatedInputTokens: Math.ceil(inputBytes / 4), estimatedOutputTokens: Math.ceil(outputBytes / 4), basis: 'estimate: bytes / 4; AI Credits are not measured' },
      ...(measured.calls ? { measuredUsage: { ...measured, complete: usageKnown, basis: 'Copilot CLI --usage-output-file per call, failed calls included when the CLI wrote usage; complete is false when any call had no record' } } : {}),
      ...(selfRepairs.corrections || selfRepairs.markerFixes || repassUnits || leftOpen.length ? { selfRepairs: { ...selfRepairs,
        ...(repassUnits ? { repass: { units: repassUnits.length, done: repassUnits.filter(u => completed.has(u)).length } } : {}),
        ...(leftOpen.length ? { flagged: leftOpen } : {}) } } : {}),
      executionMode: config.executionMode ?? 'continuous', ...(ignoredLimits(config).length ? { ignoredLimits: ignoredLimits(config) } : {}), ...(Number.isFinite(maxInputBytes) ? { maxRunInputBytes: maxInputBytes } : {}) };
    writeJSON(safePath(root, `migration/runs/${runId}/summary.json`), report);
    // Every unit reviewed: phase 04 is done for real, so its waiver retires.
    if (executionPurpose(config) === 'production' && units.length && completed.size === units.length) retireWaiver(root, '04');
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
