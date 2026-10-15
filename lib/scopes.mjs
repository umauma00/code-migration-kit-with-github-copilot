// SPDX-License-Identifier: Apache-2.0
import { readManifest, loadReviewDependencies, reviewSources, done, readJSON, safePath, fileHash, hash } from './core.mjs';
import { readReviewText } from './review.mjs';

export function unitDependencies(root, config, units) {
  const graph = loadReviewDependencies(root, config), bySource = new Map(units.map(u => [u.source, u]));
  return new Map(units.map(u => [u, new Set(reviewSources(root, config, u.source, graph).filter(p => p !== u.source && bySource.has(p)).map(p => bySource.get(p)))]));
}
export function selectTranslationScope(root, config, context, { batch, targets } = {}) {
  if (batch !== undefined && targets !== undefined) throw new Error('Choose --batch or --targets, not both');
  if (batch === undefined && targets === undefined) return null;
  const units = readManifest(root, config), deps = unitDependencies(root, config, units);
  const cyclic = new Set(units.filter(u => [...deps.get(u)].some(d => deps.get(d).has(u))));
  if (!config.commands?.typecheck) for (const [u, ds] of deps) for (const d of ds) if (deps.get(d).has(u)) ds.delete(d);
  const complete = new Set(units.filter(u => done(root, u, context)));
  let selected;
  if (targets !== undefined) {
    if (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length || targets.some(p => !units.some(u => u.target === p))) throw new Error('Translation scope requires unique manifest targets');
    selected = units.filter(u => targets.includes(u.target));
  } else {
    const count = Number(batch);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('--batch is a positive unit count, not an agent-call budget');
    selected = [];
    const remaining = units.filter(u => !complete.has(u));
    while (selected.length < count && remaining.length) {
      const index = remaining.findIndex(u => !(config.commands?.typecheck && cyclic.has(u)) && [...deps.get(u)].every(d => complete.has(d) || selected.includes(d)));
      if (index < 0) break;
      selected.push(remaining.splice(index, 1)[0]);
    }
    if (!selected.length) throw new Error('No pending dependency-ready batch; inspect reviewed receipts and resolve/defer cycle typecheck');
  }
  for (const u of selected) if ([...deps.get(u)].some(d => !complete.has(d) && !selected.includes(d))) throw new Error(`Translation scope omits an incomplete prerequisite: ${u.source}`);
  return selected.map(u => u.target);
}

export function readRepairQueue(root, config, name, context, outputs) {
  if (!name?.startsWith('migration/')) throw new Error('Repair queue must be under migration/');
  const checksum = fileHash(safePath(root, name));
  const queue = readJSON(safePath(root, name)), build = readJSON(safePath(root, 'migration/results/build.json'));
  if (queue.schemaVersion !== 1 || queue.contextHash !== context || build.contextHash !== context || queue.buildExecutionId !== build.executionId ||
      build.invalidatedAt || build.outputHash !== outputs || !Array.isArray(queue.jobs) || !queue.jobs.length) throw new Error('Repair queue is missing or stale for the current build and outputs');
  const units = new Set(readManifest(root, config).map(u => u.target)), jobs = new Map();
  for (const job of queue.jobs) {
    if (!units.has(job.target) || jobs.has(job.target) || job.outputHash !== fileHash(safePath(root, job.target)) ||
        !job.evidence?.startsWith('migration/') || job.evidenceHash !== fileHash(safePath(root, job.evidence))) throw new Error('Repair queue has duplicate, changed or unowned targets/evidence');
    const diagnostic = readReviewText(root, job.evidence);
    if (!diagnostic.trim() || diagnostic.length > 16000 || hash(diagnostic) !== job.evidenceHash) throw new Error('Each repair diagnostic slice must be unchanged, nonempty and at most 16000 characters');
    jobs.set(job.target, diagnostic);
  }
  if (fileHash(safePath(root, name)) !== checksum) throw new Error('Repair queue changed while reading');
  return { jobs, records: queue.jobs, path: name, checksum, buildExecutionId: build.executionId };
}
