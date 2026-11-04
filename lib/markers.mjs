// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

// 2026-11-04: a Windows run sent Database.xml back to the fixer on every run.
// XML has no line comment and the trailer had to end with its count, so
// `<!-- PORT STATUS: confidence=medium todos=2 -->` failed and only a file
// that was no longer XML (a bare line, an unclosed comment) could pass. A
// trailer may now end with the closer of a comment that ends on its line, as
// the formats without a line comment write one: XML and HTML (-->), JSP and
// ASP (--%>), ERB and EJS (%>), CSS (*/), Razor (*@), Jinja and Twig (#}),
// OCaml (*). A closing brace, bracket or parenthesis is not one: a trailer
// before it sits inside code.
export const trailerClosers = ['-->', '--%>', '%>', '*/', '*@', '#}', '*)'];
const count = String.raw`PORT STATUS:\s*confidence\s*=\s*\[?\s*(high|medium|low)\s*\]?\s+todos\s*=\s*\[?\s*(\d+)\s*\]?\s*`;
// The trailer up to 0.45.0: nothing after the count.
const linePattern = new RegExp(`${count}$`);
const escaped = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const trailerPattern = new RegExp(`${count}(?:(?:${trailerClosers.map(escaped).join('|')})\\s*)?$`);
// A format with no comments at all carries no trailer: any trailer line would
// make the file invalid (JSON). Such a file is complete without one.
const commentless = /\.(?:json|jsonl|ndjson|geojson|webmanifest)$/i;
export const carriesNoTrailer = target => typeof target === 'string' && commentless.test(target);
const noComments = 'this format has no comments, so the file carries no PORT STATUS trailer';

// The fields a finished unit records, measured with one trailer pattern.
function measure(content, lines, pattern) {
  const actual = lines.filter(line => line.includes('TODO(port)')).length;
  const trailers = lines.filter(line => line.includes('PORT STATUS:'));
  // The RULEBOOK template once showed `todos=[N]`, and workers copied the
  // brackets (todos=[2]): the same count, so brackets and spaces around the
  // values are accepted, not blocked. The count itself must still match.
  const match = trailers.length === 1 && trailers[0].match(pattern);
  const claimed = match ? Number(match[2]) : null;
  const last = lines.findLast(line => line.trim());
  const valid = Boolean(match && Number.isSafeInteger(claimed) && last === trailers[0] && actual === claimed);
  return { evidence: { policy: 'todo-lines-v1', candidateHash: hash(content), countingMethod: 'literal-lines-containing-TODO(port)', actual, claimed, valid }, wellFormed: Boolean(match), trailers: trailers.length };
}

// Opt-in: old projects may have a different, reviewed trailer convention.
// Counting is literal line counting (grep -c), not an LLM judgment or a parser.
// target: the unit's target path; only its extension is read (commentless).
export function markerEvidence(config, content, target) {
  if (!config.markerPolicy) return null;
  if (config.markerPolicy !== 'todo-lines-v1') throw new Error('Unsupported markerPolicy');
  const lines = content.split(/\r?\n/);
  const { evidence, wellFormed, trailers } = measure(content, lines, trailerPattern);
  // These fields are new: no receipt of an earlier kit has a file valid without a trailer.
  if (carriesNoTrailer(target)) return trailers ? { ...evidence, valid: false, problem: markerProblem(lines, evidence.actual, evidence.claimed, wellFormed, target) }
    : { ...evidence, valid: true, noTrailer: noComments };
  // Only an invalid trailer says why: "invalid" alone left reviewers and the
  // arbiter judging a trailer above the closing brace as fine, and the unit
  // looped through review. A valid trailer keeps exactly the fields finished
  // units recorded, so their receipts still match.
  return evidence.valid ? evidence : { ...evidence, problem: markerProblem(lines, evidence.actual, evidence.claimed, wellFormed, target) };
}

// The evidence a finished unit's receipt is checked against (unitDone). A JSON
// file finished by 0.45.0 or earlier ends with the trailer those kits asked of
// every file: its receipt (valid, without noTrailer) still holds while the file
// passes the check of those kits, so updating sends no finished unit back.
// Every new answer is held to markerEvidence, which takes no trailer there.
export function finishedMarkerEvidence(config, content, target, recorded) {
  const evidence = markerEvidence(config, content, target);
  if (!evidence || evidence.valid || !carriesNoTrailer(target) || recorded?.valid !== true || recorded.noTrailer !== undefined) return evidence;
  const before = measure(content, content.split(/\r?\n/), linePattern).evidence;
  return before.valid ? before : evidence;
}

// What is wrong with the trailer, in words a worker can act on (1-based lines).
function markerProblem(lines, actual, claimed, wellFormed, target) {
  const at = lines.flatMap((line, i) => line.includes('PORT STATUS:') ? [i + 1] : []);
  const quote = line => JSON.stringify(line.trim().slice(0, 80));
  if (carriesNoTrailer(target)) return `${noComments}: remove the PORT STATUS trailer (${at.length === 1 ? `line ${at[0]}` : `lines ${at.join(', ')}`})`;
  if (!at.length) return `There is no PORT STATUS line: add one as the last nonempty line, in the file's line-comment syntax, such as "// PORT STATUS: confidence=medium todos=${actual}" (${actual} lines contain TODO(port)); a format without line comments ends that line with the closer of its comment, such as "<!-- PORT STATUS: confidence=medium todos=${actual} -->"`;
  if (at.length > 1) return `${at.length} lines contain PORT STATUS (lines ${at.join(', ')}): keep exactly one, as the last nonempty line`;
  const problems = [];
  if (!wellFormed) problems.push(`the PORT STATUS line (line ${at[0]}) does not read "PORT STATUS: confidence=high|medium|low todos=<number>", with nothing after the number but the closer of a comment that ends on that line (${trailerClosers.map(c => `"${c}"`).join(', ')})`);
  const after = lines.slice(at[0]).map((line, i) => ({ line, n: at[0] + i + 1 })).filter(({ line }) => line.trim());
  // A comment closed on the line below the trailer (XML written as <!-- ... newline -->).
  const closer = after.length === 1 && trailerClosers.includes(after[0].line.trim()) ? after[0].line.trim() : null;
  if (closer) problems.push(`the PORT STATUS line is line ${at[0]}, but line ${after[0].n} ${quote(after[0].line)} closes its comment below it: end the PORT STATUS line itself with "${closer}" and remove line ${after[0].n}, so the trailer is the last nonempty line`);
  else if (after.length) problems.push(`the PORT STATUS line is line ${at[0]}, but ${after.length === 1 ? 'line' : `${after.length} nonempty lines follow it, the first is line`} ${after[0].n} ${quote(after[0].line)}${after.length === 1 ? ' follows it' : ''}: move the trailer below it, after the final closing brace or tag, so it is the last nonempty line`);
  if (wellFormed && claimed !== actual) problems.push(`it says todos=${claimed} but ${actual} lines contain TODO(port): make the number ${actual}, or change the TODO(port) lines`);
  return problems.join('; ');
}

const sentence = text => `${text[0].toUpperCase()}${text.slice(1)}.`;
export const markerError = evidence => [`PORT STATUS count mismatch or invalid trailer: TODO(port) lines=${evidence.actual}, claimed=${evidence.claimed ?? 'missing'}.`,
  ...(evidence.problem ? [sentence(evidence.problem)] : []),
  ...(evidence.problem?.startsWith(noComments) ? [] : ['Return one final confidence/todos trailer matching the agreed marker policy.'])].join(' ');

export function requireMarkers(config, content, target) {
  const evidence = markerEvidence(config, content, target);
  if (evidence && !evidence.valid) throw new Error(markerError(evidence));
  return evidence;
}
