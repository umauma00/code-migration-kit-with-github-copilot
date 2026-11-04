// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

// 2026-11-04: a Windows run sent Database.xml back to the fixer on every run.
// XML has no line comment and the trailer had to end with its count, so
// `<!-- PORT STATUS: confidence=medium todos=2 -->` failed and only a file
// that was no longer XML (a bare line, an unclosed comment) could pass. A
// trailer may now end with the closer of a comment that ends on its line, as
// the formats without a line comment write one: XML and HTML (-->), JSP and
// ASP.NET (--%>), ERB and EJS (%>), CSS (*/), Razor (*@), Jinja and Twig (#}),
// OCaml (*). A closing brace, bracket or parenthesis of code is not one: a
// trailer before it sits inside code.
export const trailerClosers = ['-->', '--%>', '%>', '*/', '*@', '#}', '*)'];
const escaped = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const count = String.raw`PORT STATUS:\s*confidence\s*=\s*\[?\s*(high|medium|low)\s*\]?\s+todos\s*=\s*\[?\s*(\d+)\s*\]?\s*`;
const trailerPattern = new RegExp(`${count}(?:(${trailerClosers.map(escaped).join('|')})\\s*)?$`);
// A trailer line that opens a block comment before PORT STATUS ends with its
// closer: `<!-- PORT STATUS: ... todos=2` left the file inside a comment (the
// form 0.45.0 passed in XML). One opened on a line above is not seen here.
const opener = /(<!--|<%--|<%#|\/\*+|\{#|@\*|\(\*+)$/;
const closerOf = open => open === '<!--' ? '-->' : open === '<%--' ? '--%>' : open === '<%#' ? '%>' : open === '{#' ? '#}' : open === '@*' ? '*@' : open.startsWith('/') ? '*/' : '*)';
// A format with no comments at all carries no trailer: any trailer line would
// make the file invalid (the JSON formats). Such a file is complete without one.
const commentless = /\.(?:json|jsonl|ndjson|geojson|topojson|jsonld|webmanifest|ipynb|har|sarif|gltf)$/i;
export const carriesNoTrailer = target => typeof target === 'string' && commentless.test(target);
export const commentlessExtensions = '.json, .jsonl, .ndjson, .geojson, .topojson, .jsonld, .webmanifest, .ipynb, .har, .sarif or .gltf';

// The fields a finished unit records, with what the problem text needs.
function measure(content, lines) {
  const actual = lines.filter(line => line.includes('TODO(port)')).length;
  const trailers = lines.filter(line => line.includes('PORT STATUS:'));
  // The RULEBOOK template once showed `todos=[N]`, and workers copied the
  // brackets (todos=[2]): the same count, so brackets and spaces around the
  // values are accepted, not blocked. The count itself must still match.
  const match = trailers.length === 1 && trailers[0].match(trailerPattern);
  const claimed = match ? Number(match[2]) : null;
  const last = lines.findLast(line => line.trim());
  const valid = Boolean(match && Number.isSafeInteger(claimed) && last === trailers[0] && actual === claimed);
  const open = match ? trailers[0].slice(0, trailers[0].indexOf('PORT STATUS:')).trimEnd().match(opener)?.[1] : undefined;
  const unclosed = open && match[3] !== closerOf(open) ? { open, close: closerOf(open) } : null;
  return { evidence: { policy: 'todo-lines-v1', candidateHash: hash(content), countingMethod: 'literal-lines-containing-TODO(port)', actual, claimed, valid }, wellFormed: Boolean(match), trailers: trailers.length, unclosed };
}

// Opt-in: old projects may have a different, reviewed trailer convention.
// Counting is literal line counting (grep -c), not an LLM judgment or a parser.
// target: the unit's target path; only its extension is read (commentless).
export function markerEvidence(config, content, target) {
  if (!config.markerPolicy) return null;
  if (config.markerPolicy !== 'todo-lines-v1') throw new Error('Unsupported markerPolicy');
  const lines = content.split(/\r?\n/);
  const { evidence, wellFormed, trailers, unclosed } = measure(content, lines);
  const problem = () => markerProblem(lines, { ...evidence, wellFormed, target, unclosed });
  // noTrailer is a field of the receipt (unitDone compares every field): its
  // value never changes. No receipt of an earlier kit has it.
  if (carriesNoTrailer(target)) return trailers ? { ...evidence, valid: false, noTrailer: true, problem: problem() } : { ...evidence, valid: true, noTrailer: true };
  // Only an invalid trailer says why: "invalid" alone left reviewers and the
  // arbiter judging a trailer above the closing brace as fine, and the unit
  // looped through review. A valid trailer keeps exactly the fields finished
  // units recorded, so their receipts still match.
  return evidence.valid && !unclosed ? evidence : { ...evidence, valid: false, problem: problem() };
}

// The evidence a finished unit's receipt is checked against (unitDone). A unit
// finished by an earlier kit keeps its receipt while its file passes what every
// kit since 0.45.1 takes: the count and its place, before the rules for comments
// left open and for the JSON formats, which hold every new answer. So a JSON file
// finished with `// PORT STATUS: ...`, or an XML file with a comment left open,
// stays finished. A receipt holds only for the content it was recorded with
// (candidateHash), so nothing else finishes this way.
export function finishedMarkerEvidence(config, content, target, recorded) {
  const evidence = markerEvidence(config, content, target);
  if (!evidence || evidence.valid || recorded?.valid !== true) return evidence;
  const earlier = measure(content, content.split(/\r?\n/)).evidence;
  return earlier.valid ? earlier : evidence;
}

// What is wrong with the trailer, in words a worker can act on (1-based lines).
function markerProblem(lines, { actual, claimed, wellFormed, target, unclosed }) {
  const at = lines.flatMap((line, i) => line.includes('PORT STATUS:') ? [i + 1] : []);
  const quote = line => JSON.stringify(line.trim().slice(0, 80));
  if (carriesNoTrailer(target)) return `this format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (${at.length === 1 ? `line ${at[0]}` : `lines ${at.join(', ')}`})`;
  if (!at.length) return `There is no PORT STATUS line: add one as the last nonempty line, in the file's line-comment syntax, such as "// PORT STATUS: confidence=medium todos=${actual}" (${actual} lines contain TODO(port)); a format without line comments ends that line with the closer of its comment, such as "<!-- PORT STATUS: confidence=medium todos=${actual} -->"`;
  if (at.length > 1) return `${at.length} lines contain PORT STATUS (lines ${at.join(', ')}): keep exactly one, as the last nonempty line`;
  const problems = [];
  if (!wellFormed) problems.push(`the PORT STATUS line (line ${at[0]}) does not read "PORT STATUS: confidence=high|medium|low todos=<number>", with nothing after the number but the closer of a comment that ends on that line (${trailerClosers.map(c => `"${c}"`).join(', ')})`);
  if (unclosed) problems.push(`the PORT STATUS line (line ${at[0]}) opens a comment with "${unclosed.open}" that does not end on that line: end the line with "${unclosed.close}"`);
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
  ...(evidence.noTrailer ? [] : ['Return one final confidence/todos trailer matching the agreed marker policy.'])].join(' ');

export function requireMarkers(config, content, target) {
  const evidence = markerEvidence(config, content, target);
  if (evidence && !evidence.valid) throw new Error(markerError(evidence));
  return evidence;
}
