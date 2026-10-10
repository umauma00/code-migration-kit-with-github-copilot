// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import crypto from 'node:crypto';
import { safePath, hash, fileHash, treeHash, stamp, atomicWrite, writeJSON, readJSON,
  readManifest, contextHash, statePath, unitState, done, lockRun } from './core.mjs';
import { validateResult } from './results.mjs';
import { runProcess } from './process.mjs';
import { reviewInput, readReviewText } from './review.mjs';

const recordPath = (root, stage) => safePath(root, `migration/results/${stage}.json`);
const gatePath = (root, stage) => safePath(root, `migration/gates/${stage}.json`);
const outputHash = (root, config) => hash(JSON.stringify({
  tree: treeHash(root, config.outputRoots),
  // Explicit outputs must participate even below traversal exclusions.
  manifestTargets: readManifest(root, config).map(u => [u.target, fileHash(safePath(root, u.target))])
}));
const stages = ['judge', 'translation', 'build', 'smoke', 'parity', 'post-parity'];
const previousStage = { translation: 'judge', build: 'judge', smoke: 'build', parity: 'smoke', 'post-parity': 'parity' };
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
function currentRecord(root, config, stage, context, withOutputs = true) {
  const file = recordPath(root, stage);
  if (!fs.existsSync(file)) return false;
  let r;
  try { r = readJSON(file); } catch (e) { if (e instanceof SyntaxError) return false; throw e; }
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
export function approve(root, config, stage, note) {
  if (!['translation', 'build', 'smoke', 'parity', 'post-parity'].includes(stage)) throw new Error('Unknown approval stage');
  if (!note?.trim()) throw new Error('Approval requires --note describing what was reviewed');
  const release = lockRun(root, `approve-${stage}`);
  try {
  const context = contextHash(root, config);
  if (stage === 'translation') {
    for (const p of ['migration/feasibility.md', 'migration/stress-test/report.md']) {
      const f = safePath(root, p);
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) throw new Error(`Review artifact required: ${p}`);
    }
    if (!currentRecord(root, config, 'judge', context, false)) throw new Error('Run judge successfully for these inputs before approving translation');
  } else {
    const units = readManifest(root, config);
    if (!units.length || !units.every(u => done(root, u, context))) throw new Error('All translation units must have current reviewed receipts');
    requireGate(root, config, 'translation', context);
  }
  const gate = { schemaVersion: 1, stage, note, approvedAt: stamp(), contextHash: context,
    predecessor: predecessor(root, config, stage, context),
    outputHash: stage === 'translation' ? null : outputHash(root, config),
    reports: stage === 'translation' ? ['migration/feasibility.md', 'migration/stress-test/report.md'].map(p => [p, fileHash(safePath(root, p))]) : [] };
  writeJSON(gatePath(root, stage), gate);
  return gate;
  } finally { release(); }
}
export function requireGate(root, config, stage, context) {
  const file = gatePath(root, stage);
  if (!fs.existsSync(file)) throw new Error(`No ${stage} approval. Review the artifacts and explicitly run approve ${stage}.`);
  const gate = readJSON(file);
  if (gate.contextHash !== context || (gate.outputHash !== null && gate.outputHash !== outputHash(root, config)) ||
      gate.reports?.some(([p, h]) => fileHash(safePath(root, p)) !== h)) throw new Error(`${stage} approval is stale; inputs or outputs changed`);
  if (JSON.stringify(gate.predecessor) !== JSON.stringify(predecessor(root, config, stage, context))) throw new Error(`${stage} approval is stale; predecessor was rerun`);
  if (stage !== 'translation') {
    requireGate(root, config, 'translation', context);
    const units = readManifest(root, config);
    if (!units.length || !units.every(u => done(root, u, context))) throw new Error('Reviewed translation receipts are missing or stale');
  }
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
export async function runStage(root, config, stage, { signal } = {}) {
  const names = { judge: ['original', 'mutation'], build: ['build'], smoke: ['smoke'], parity: ['original', 'parity'] }[stage];
  if (!names) throw new Error('Unknown executable stage');
  const release = lockRun(root, stage);
  let result;
  try {
    const context = contextHash(root, config), outputs = outputHash(root, config);
    if (stage !== 'judge') requireGate(root, config, stage, context);
    result = { schemaVersion: 1, executionId: crypto.randomUUID(), stage, predecessor: predecessor(root, config, stage, context), contextHash: context, outputHash: outputs, success: false, startedAt: stamp(), commands: [] };
    // Publish failure/running before side effects. A crash or partial downstream
    // invalidation cannot leave a chain of apparently successful stage records.
    writeJSON(recordPath(root, stage), result);
    invalidateAfter(root, stage);
    for (const name of names) {
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
    // Commands may create build artifacts but must not alter translated source outputs.
    if (stage !== 'judge' && outputHash(root, config) !== outputs) throw new Error('Output source tree changed during validation');
    result.success = true;
    return result;
  } catch (e) { if (result) result.error = e.message; throw e; }
  finally { try { if (result) { result.finishedAt = stamp(); writeJSON(recordPath(root, stage), result); } } finally { release(); } }
}

export async function translate(root, config, adapter, { signal, onlyTarget, evidence, onProgress = () => {} } = {}) {
  const release = lockRun(root, onlyTarget ? 'repair' : 'translation');
  let context;
  const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const errors = [];
  let calls = 0;
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
    requireGate(root, config, 'translation', context);
    const units = readManifest(root, config);
    if (!units.length) throw new Error('Manifest is empty; refusing an empty translation run');
    if (onlyTarget && !units.some(u => u.target === onlyTarget)) throw new Error('Repair target is not in manifest');
    let diagnostic = null;
    if (onlyTarget) {
      if (!evidence?.startsWith('migration/')) throw new Error('Repair requires an evidence file under migration/');
      diagnostic = readReviewText(root, evidence);
      if (diagnostic.length > 16000) throw new Error('Select a diagnostic slice of at most 16000 characters');
    }
    const pending = units.filter(u => onlyTarget ? u.target === onlyTarget : !done(root, u, context));
    if (pending.length) invalidateAfter(root, 'translation');
    async function work(unit) {
      let state = unitState(root, unit);
      const out = safePath(root, unit.target), currentHash = fileHash(out);
      if (!state || state.contextHash !== context || state.outputHash !== currentHash) {
        state = { schemaVersion: 1, ...unit, contextHash: context, outputHash: currentHash,
          stage: currentHash && fs.statSync(out).size ? 'review' : 'implement', status: 'pending', round: 0, reviewMap: {}, reviews: [] };
      }
      // A lost/corrupt receipt must return to review, never complete from an old stage label.
      if (['arbitrate', 'fix', 'done'].includes(state.stage) &&
          ((state.stage === 'done' && !done(root, unit, context)) || state.reviewEvidence?.length !== 2 || state.reviewEvidence.some(e => fileHash(safePath(root, e.path)) !== e.hash) ||
           (state.arbitration && fileHash(safePath(root, state.arbitration.path)) !== state.arbitration.hash))) {
        state.stage = 'review'; state.reviewMap = {}; state.reviews = []; delete state.arbitration;
      }
      if (onlyTarget) {
        if (!currentHash || !fs.statSync(out).size) throw new Error('Repair requires an existing nonempty target; translate missing units first');
        state.stage = 'review'; state.reviewMap = {}; state.reviews = []; state.round = 0; state.diagnostic = diagnostic;
      }
      const save = () => { state.updatedAt = stamp(); writeJSON(statePath(root, unit), state); };
      const invoke = async (role, extra = {}, review = null) => {
        if (signal?.aborted) throw new Error('Interrupted');
        if (calls >= config.maxAgentCalls) throw new Error('Agent call limit reached; resume with a new run after reviewing usage');
        calls++;
        await acquire();
        const rel = `migration/runs/${runId}/${unit.id}-${state.round}-${role}-${crypto.randomUUID().slice(0, 8)}.json`;
        const attempt = { role, unit, startedAt: stamp(), status: 'running', requestedModel: config.models[role],
          ...(review ? { reviewInputHash: review.hash } : {}) };
        let response;
        try {
          writeJSON(safePath(root, rel), attempt);
          if (signal?.aborted) throw new Error('Interrupted');
          response = await adapter({ root, config, role, unit, extra, signal, reviewInput: review?.text });
          validateResult(role, response.result, unit);
          Object.assign(attempt, response, { status: 'success', finishedAt: stamp() });
          writeJSON(safePath(root, rel), attempt);
          return { path: rel, hash: fileHash(safePath(root, rel)), result: response.result };
        } catch (e) {
          Object.assign(attempt, { status: 'failed', finishedAt: stamp(), error: e.message,
            process: e.result ?? null, ...((e.response ?? response?.result) ? { response: e.response ?? response.result } : {}) });
          writeJSON(safePath(root, rel), attempt); throw e;
        } finally { free(); }
      };
      const put = result => {
        // Only the coordinator has write access. Never take a destination from model output.
        validateResult('implementer', result, unit);
        if (fileHash(safePath(root, unit.target)) !== state.outputHash) throw new Error('Output changed concurrently; refusing to overwrite');
        atomicWrite(safePath(root, unit.target), result.content);
        state.outputHash = fileHash(safePath(root, unit.target));
        state.reviewMap = {}; state.reviews = []; state.reviewEvidence = []; delete state.arbitration; state.stage = 'review'; save();
      };
      try {
        for (;;) {
          if (signal?.aborted) throw new Error('Interrupted');
          state.status = state.stage; save(); onProgress({ unit: unit.target, stage: state.stage, calls });
          if (state.stage === 'implement') {
            const response = await invoke('implementer'); state.implementation = response.path; put(response.result);
          } else if (state.stage === 'review') {
            if (config.commands?.typecheck && !(state.diagnostic && state.round === 0)) {
              let check;
              try { check = await runCommand(root, config, 'typecheck', { target: unit.target, signal }); }
              catch (e) { state.typecheck = e.result ?? { error: e.message }; throw e; }
              if (check.code !== 0) { state.typecheck = check; throw new Error('Unit typecheck failed; inspect receipt and repair or rerun after dependencies are ready'); }
            }
            const review = reviewInput(root, config, unit, state.diagnostic ?? null);
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
            state.stage = state.findings.length ? 'arbitrate' : 'done'; save();
          } else if (state.stage === 'arbitrate') {
            const response = await invoke('arbiter', { findings: state.findings });
            const expected = new Set(state.findings.map(f => f.reference));
            for (const d of response.result.decisions) { if (!expected.delete(d.finding)) throw new Error('Unknown/duplicate arbitration finding'); }
            if (expected.size) throw new Error('Arbiter omitted findings');
            state.arbitration = { path: response.path, hash: response.hash };
            state.confirmed = state.findings.filter(f => response.result.decisions.find(d => d.finding === f.reference).confirmed);
            state.stage = state.confirmed.length ? 'fix' : 'done'; save();
          } else if (state.stage === 'fix') {
            if (state.round >= config.maxFixRounds) throw new Error('Fix-round limit reached; review recurring problems and propose a rule amendment');
            const response = await invoke('fixer', { confirmedFindings: state.confirmed, diagnostic: state.diagnostic ?? null });
            state.round++; state.fix = response.path; put(response.result);
          } else if (state.stage === 'done') {
            if (config.commands?.typecheck && state.diagnostic && state.round === 0) {
              let check;
              try { check = await runCommand(root, config, 'typecheck', { target: unit.target, signal }); }
              catch (e) { state.typecheck = e.result ?? { error: e.message }; throw e; }
              state.typecheck = check;
              if (check.code !== 0) throw new Error('Repair reviewers found no actionable issue but typecheck still fails');
            }
            if (contextHash(root, config) !== context) throw new Error('Migration inputs changed; receipts need fresh approval');
            if (fileHash(safePath(root, unit.target)) !== state.outputHash) throw new Error('Output changed during review');
            state.status = 'done'; delete state.error; save(); onProgress({ unit: unit.target, stage: 'done', calls }); break;
          } else throw new Error(`Unknown unit stage: ${state.stage}`);
        }
      } catch (e) { state.status = 'blocked'; state.error = e.message; save(); errors.push({ target: unit.target, error: e.message }); }
    }
    // Preserve manifest order between waves. Within a wave, units may run concurrently.
    // Callers must keep mutually-dependent or shared-output units in one atomic unit;
    // typecheck should be null until the target graph exists, or use concurrency=1.
    for (let i = 0; i < pending.length; i += config.concurrency) {
      if (signal?.aborted || errors.length) break;
      const wave = pending.slice(i, i + config.concurrency);
      const results = await Promise.allSettled(wave.map(work));
      results.forEach((r, j) => { if (r.status === 'rejected') errors.push({ target: wave[j].target, error: r.reason.message }); });
    }
    const report = { runId, finishedAt: stamp(), contextHash: context, agentCalls: calls,
      done: units.filter(u => done(root, u, context)).length, total: units.length, errors };
    writeJSON(safePath(root, `migration/runs/${runId}/summary.json`), report);
    if (errors.length || signal?.aborted || pending.some(u => !done(root, u, context))) throw new Error(`Translation stopped: ${errors.map(e => `${e.target}: ${e.error}`).join('; ') || (signal?.aborted ? 'Interrupted' : 'Reviewed receipts incomplete')}`);
    return report;
  } finally { release(); }
}
