// SPDX-License-Identifier: Apache-2.0
// Upstream Step 4: the human starts the build daemon once; it reruns the survey
// build each round and fixers work the numbered error queue "until clean", then
// the human sees the round-over-round counts. Here one host-confirmed
// `build-loop` command is that act. It grants up to maxRounds builds for the
// current translation approval: each round's build approval is recorded under
// the grant (never on the agent's own say-so), failures are parsed into the
// repair queue, repairs get the normal reviews, and the loop stops when the
// build is clean, the round limit or the shared call budget is reached, or the
// error count stops falling.
import crypto from 'node:crypto';
import { safePath, readJSON, writeJSON, stamp } from './core.mjs';
import { approve, runStage, translate } from './pipeline.mjs';
import { strictPhases } from './phases.mjs';
import { requirePilot } from './pilot.mjs';
import { requireGuardrails } from './guardrails.mjs';
import { diagnoseBuild } from '../scripts/diagnostic_queue.mjs';

// A build that ran and failed is a round result; anything else (stale gates,
// changed inputs, missing commands) is an error the person must see.
function failedBuildRecord(root, executionId) {
  try {
    const record = readJSON(safePath(root, 'migration/results/build.json'));
    return record.executionId !== executionId && record.success === false && !record.invalidatedAt &&
      (record.commands ?? []).some(c => c.status === 'failed' && Number.isInteger(c.code));
  } catch { return false; }
}

// maxCalls is the whole loop's AI call budget (default: one run's maxAgentCalls),
// so the confirmed command states the most the loop can spend.
export async function buildLoop(root, config, adapter, { maxRounds = 5, maxCalls = config.maxAgentCalls, note, signal, onProgress = () => {} } = {}) {
  if (!note?.trim()) throw new Error('build-loop requires --note describing what was reviewed and why the loop is authorized');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) throw new Error('--max-rounds must be an integer from 1 to 50');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 10000) throw new Error('--max-calls must be an integer from 1 to 10000');
  if (strictPhases(root, config) && !requirePilot(root, config)) requireGuardrails(root, '05');
  const grant = { schemaVersion: 1, kind: 'build-loop', id: crypto.randomUUID(), note, maxRounds, maxCalls, pid: process.pid,
    grantedAt: stamp(), agentCalls: 0, promptBytes: 0, stage: 'starting', rounds: [] };
  const file = safePath(root, `migration/gates/build-loop-${grant.id}.json`);
  const save = () => writeJSON(file, grant);
  const stage = value => { grant.stage = value; save(); onProgress({ unit: '(build-loop)', stage: value }); };
  const done = (stopped, next, extra = {}) => ({ ...summary(grant), stopped, next, ...extra });
  save();
  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (signal?.aborted) throw new Error('Interrupted');
      const before = (() => { try { return readJSON(safePath(root, 'migration/results/build.json')).executionId; } catch { return null; } })();
      approve(root, config, 'build', `build-loop ${grant.id} round ${round}/${maxRounds}: ${note}`, { loop: { grantId: grant.id, round } });
      stage(`build round ${round}/${maxRounds}`);
      let built = true;
      try { await runStage(root, config, 'build', { signal }); }
      catch (e) { if (signal?.aborted || !failedBuildRecord(root, before)) throw e; built = false; }
      const diagnosis = diagnoseBuild(root, config);
      const entry = { round, buildExecutionId: diagnosis.buildExecutionId, success: built && diagnosis.clean,
        errors: diagnosis.errors ?? 0, targets: diagnosis.targets?.length ?? 0, unmapped: diagnosis.unmappedCount ?? 0, finishedAt: stamp() };
      grant.rounds.push(entry); save();
      if (diagnosis.clean) return done('clean', 'Show the person the round-over-round counts and the build record, then ask for the smoke approval.');
      // Two rounds in a row without fewer errors: the same rule keeps producing
      // them. Upstream rule 6 — stop patching instances and amend the rule.
      const last = grant.rounds.slice(-3).map(r => r.errors);
      if (last.length === 3 && last[1] >= last[0] && last[2] >= last[1]) {
        return done('stalled', 'The error count stopped falling: find the rule behind the recurring errors, propose a rulebook amendment to the person and regenerate the slice it touches.');
      }
      if (round === maxRounds) break;
      const remaining = maxCalls - grant.agentCalls;
      if (remaining < 1) return done('budget', 'The loop\'s call budget is spent with errors left: show the counts and usage, then ask whether to grant more calls or amend the rules first.');
      stage(`repair round ${round}: ${entry.errors} errors in ${entry.targets} targets`);
      let report;
      try {
        report = await translate(root, config, adapter, { signal, repairQueue: diagnosis.queue, onProgress, callLimit: remaining,
          ...(config.maxRunInputBytes ? { inputLimit: Math.max(1, config.maxRunInputBytes - grant.promptBytes) } : {}) });
      } catch (e) {
        if (e.report) { grant.agentCalls += e.report.agentCalls; grant.promptBytes += e.report.usageEstimate?.promptBytes ?? 0; save(); }
        if (e.budgetStop && !signal?.aborted) return done('budget', 'The loop\'s call budget ran out during a repair round. The unfinished repairs resume with translate within the current approval; show the counts and usage, then ask whether to grant more calls.', { pendingRepairs: e.report?.pendingRepairs ?? [] });
        throw e;
      }
      grant.agentCalls += report.agentCalls; grant.promptBytes += report.usageEstimate?.promptBytes ?? 0; save();
    }
    return done('round-limit', 'The round limit was reached with errors left: show the counts, then ask whether to grant more rounds or to amend the rules first.');
  } finally { grant.stage = 'finished'; grant.finishedAt = stamp(); save(); }
}
const summary = grant => ({ grantId: grant.id, maxRounds: grant.maxRounds, maxCalls: grant.maxCalls, agentCalls: grant.agentCalls,
  rounds: grant.rounds, roundsFile: 'migration/build-rounds.tsv' });
