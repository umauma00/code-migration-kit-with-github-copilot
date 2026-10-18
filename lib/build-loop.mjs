// SPDX-License-Identifier: Apache-2.0
// Upstream Step 4: the human starts the build daemon once; it reruns the survey
// build each round and fixers work the numbered error queue "until clean", then
// the human sees the round-over-round counts. Here one host-confirmed
// `build-loop` command is that act. It grants up to maxRounds builds for the
// current translation approval: each round's build approval is recorded under
// the grant (never on the agent's own say-so), failures are parsed into the
// repair queue, repairs get the normal reviews, and the loop stops when the
// build is clean, the round limit is reached or the error count stops falling.
import crypto from 'node:crypto';
import { safePath, readJSON, writeJSON, stamp } from './core.mjs';
import { approve, runStage, translate } from './pipeline.mjs';
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

export async function buildLoop(root, config, adapter, { maxRounds = 5, note, signal, onProgress = () => {} } = {}) {
  if (!note?.trim()) throw new Error('build-loop requires --note describing what was reviewed and why the loop is authorized');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) throw new Error('--max-rounds must be an integer from 1 to 50');
  const grant = { schemaVersion: 1, kind: 'build-loop', id: crypto.randomUUID(), note, maxRounds, grantedAt: stamp(), rounds: [] };
  const file = safePath(root, `migration/gates/build-loop-${grant.id}.json`);
  const save = () => writeJSON(file, grant);
  save();
  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (signal?.aborted) throw new Error('Interrupted');
      const before = (() => { try { return readJSON(safePath(root, 'migration/results/build.json')).executionId; } catch { return null; } })();
      approve(root, config, 'build', `build-loop ${grant.id} round ${round}/${maxRounds}: ${note}`, { loop: { grantId: grant.id, round } });
      onProgress({ unit: '(build)', stage: `build round ${round}` });
      let built = true;
      try { await runStage(root, config, 'build', { signal }); }
      catch (e) { if (signal?.aborted || !failedBuildRecord(root, before)) throw e; built = false; }
      const diagnosis = diagnoseBuild(root, config);
      const entry = { round, buildExecutionId: diagnosis.buildExecutionId, success: built && diagnosis.clean,
        errors: diagnosis.errors ?? 0, targets: diagnosis.targets?.length ?? 0, unmapped: diagnosis.unmappedCount ?? 0, finishedAt: stamp() };
      grant.rounds.push(entry); save();
      if (diagnosis.clean) return { ...summary(grant), stopped: 'clean', next: 'Show the person the round-over-round counts and the build record, then ask for the smoke approval.' };
      // Two rounds in a row without fewer errors: the same rule keeps producing
      // them. Upstream rule 6 — stop patching instances and amend the rule.
      const last = grant.rounds.slice(-3).map(r => r.errors);
      if (last.length === 3 && last[1] >= last[0] && last[2] >= last[1]) {
        return { ...summary(grant), stopped: 'stalled', next: 'The error count stopped falling: find the rule behind the recurring errors, propose a rulebook amendment to the person and regenerate the slice it touches.' };
      }
      if (round === maxRounds) break;
      onProgress({ unit: '(repair queue)', stage: `repair round ${round}: ${entry.errors} errors in ${entry.targets} targets` });
      await translate(root, config, adapter, { signal, repairQueue: diagnosis.queue, onProgress });
    }
    return { ...summary(grant), stopped: 'round-limit', next: 'The round limit was reached with errors left: show the counts, then ask whether to grant more rounds or to amend the rules first.' };
  } finally { grant.finishedAt = stamp(); save(); }
}
const summary = grant => ({ grantId: grant.id, maxRounds: grant.maxRounds, rounds: grant.rounds, roundsFile: 'migration/build-rounds.tsv' });
