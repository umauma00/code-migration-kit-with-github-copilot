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
  const evidence = { policy: 'todo-lines-v1', candidateHash: hash(content), countingMethod: 'literal-lines-containing-TODO(port)', actual, claimed, valid };
  // Only an invalid trailer says why: "invalid" alone left reviewers and the
  // arbiter judging a trailer above the closing brace as fine, and the unit
  // looped through review. A valid trailer keeps exactly the fields finished
  // units recorded, so their receipts still match.
  return valid ? evidence : { ...evidence, problem: markerProblem(lines, actual, claimed, Boolean(match)) };
}

// What is wrong with the trailer, in words a worker can act on (1-based lines).
function markerProblem(lines, actual, claimed, wellFormed) {
  const at = lines.flatMap((line, i) => line.includes('PORT STATUS:') ? [i + 1] : []);
  const quote = line => JSON.stringify(line.trim().slice(0, 80));
  if (!at.length) return `There is no PORT STATUS line: add one as the last nonempty line, in the file's line-comment syntax, such as "// PORT STATUS: confidence=medium todos=${actual}" (${actual} lines contain TODO(port))`;
  if (at.length > 1) return `${at.length} lines contain PORT STATUS (lines ${at.join(', ')}): keep exactly one, as the last nonempty line`;
  const problems = [];
  if (!wellFormed) problems.push(`the PORT STATUS line (line ${at[0]}) does not read "PORT STATUS: confidence=high|medium|low todos=<number>"`);
  const after = lines.slice(at[0]).map((line, i) => ({ line, n: at[0] + i + 1 })).filter(({ line }) => line.trim());
  if (after.length) problems.push(`the PORT STATUS line is line ${at[0]}, but ${after.length === 1 ? 'line' : `${after.length} nonempty lines follow it, the first is line`} ${after[0].n} ${quote(after[0].line)}${after.length === 1 ? ' follows it' : ''}: move the trailer below it, after the final closing brace, so it is the last nonempty line`);
  if (wellFormed && claimed !== actual) problems.push(`it says todos=${claimed} but ${actual} lines contain TODO(port): make the number ${actual}, or change the TODO(port) lines`);
  return problems.join('; ');
}

export const markerError = evidence => `PORT STATUS count mismatch or invalid trailer: TODO(port) lines=${evidence.actual}, claimed=${evidence.claimed ?? 'missing'}. ${evidence.problem ? `${evidence.problem[0].toUpperCase()}${evidence.problem.slice(1)}. ` : ''}Return one final confidence/todos trailer matching the agreed marker policy.`;

export function requireMarkers(config, content) {
  const evidence = markerEvidence(config, content);
  if (evidence && !evidence.valid) throw new Error(markerError(evidence));
  return evidence;
}
