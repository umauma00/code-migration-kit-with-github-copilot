// SPDX-License-Identifier: Apache-2.0
// Admit a whole repair round atomically before any per-unit state or worker call.
import crypto from 'node:crypto';
import { safePath, writeJSON, fileHash, hash, stamp, contextHash, done, readRepairIntent, repairIntentPath } from './core.mjs';

export function pendingRepairs(root, units, context, intent = readRepairIntent(root, context)) {
  if (!intent) return [];
  const byTarget = new Map(units.map(u => [u.target, u]));
  for (const job of intent.jobs) if (byTarget.get(job.target)?.id !== job.unitId) throw new Error('Repair intent ownership differs from the current manifest');
  return intent.jobs.filter(j => !done(root, byTarget.get(j.target), context));
}

export function admitRepair(root, config, units, context, queue) {
  if (pendingRepairs(root, units, context).length) throw new Error('Unfinished repair intent exists; resume it before starting another queue');
  const id = crypto.randomUUID(), byTarget = new Map(units.map(u => [u.target, u]));
  const intent = { schemaVersion: 1, kind: 'repair-intent', id, contextHash: context,
    buildExecutionId: queue.buildExecutionId, queue: { path: queue.path, hash: queue.checksum }, createdAt: stamp(),
    jobs: queue.records.map(j => ({ ...j, source: byTarget.get(j.target).source, unitId: byTarget.get(j.target).id,
      diagnostic: queue.jobs.get(j.target), diagnosticHash: hash(queue.jobs.get(j.target)) })) };
  const archive = repairIntentPath(root, id);
  writeJSON(archive, intent);
  if (contextHash(root, config) !== context || fileHash(safePath(root, queue.path)) !== queue.checksum ||
      intent.jobs.some(j => fileHash(safePath(root, j.target)) !== j.outputHash || fileHash(safePath(root, j.evidence)) !== j.evidenceHash)) throw new Error('Repair inputs changed before intent publication');
  const checksum = fileHash(archive);
  // A crash before this atomic reference creates only an orphan archive. A crash
  // afterwards makes EVERY queued unit pending, even before its state is touched.
  writeJSON(safePath(root, 'migration/state/repair.json'), { schemaVersion: 1, kind: 'repair-intent-reference', id, checksum });
  return { ...intent, checksum };
}
