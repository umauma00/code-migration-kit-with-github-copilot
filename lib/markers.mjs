// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

// Opt-in: old projects may have a different, reviewed trailer convention.
// Counting is literal line counting (grep -c), not an LLM judgment or a parser.
export function markerEvidence(config, content) {
  if (!config.markerPolicy) return null;
  if (config.markerPolicy !== 'todo-lines-v1') throw new Error('Unsupported markerPolicy');
  const lines = content.split(/\r?\n/);
  const actual = lines.filter(line => line.includes('TODO(port)')).length;
  const trailers = lines.filter(line => line.includes('PORT STATUS:'));
  // The RULEBOOK template once showed `todos=[N]`, and workers copied the
  // brackets (todos=[2]): the same count, so brackets and spaces around the
  // values are accepted, not blocked. The count itself must still match.
  const match = trailers.length === 1 && trailers[0].match(/PORT STATUS:\s*confidence\s*=\s*\[?\s*(high|medium|low)\s*\]?\s+todos\s*=\s*\[?\s*(\d+)\s*\]?\s*$/);
  const claimed = match ? Number(match[2]) : null;
  const last = lines.findLast(line => line.trim());
  const valid = Boolean(match && Number.isSafeInteger(claimed) && last === trailers[0] && actual === claimed);
  return { policy: 'todo-lines-v1', candidateHash: hash(content), countingMethod: 'literal-lines-containing-TODO(port)', actual, claimed, valid };
}

export function requireMarkers(config, content) {
  const evidence = markerEvidence(config, content);
  if (evidence && !evidence.valid) throw new Error(`PORT STATUS count mismatch or invalid trailer: TODO(port) lines=${evidence.actual}, claimed=${evidence.claimed ?? 'missing'}. Return one final confidence/todos trailer matching the agreed marker policy.`);
  return evidence;
}
