// SPDX-License-Identifier: Apache-2.0
import { markerEvidence } from './markers.mjs';

// markerPolicy todo-lines-v1 (0.46.0). A trailer whose only faults are its
// form or its place needs no judgment: capitals or punctuation the check does
// not take, a block comment left open, the line above the final closing
// brace, the same trailer twice. The runner rewrites it itself, instead of a
// worker returning the whole file again (an answer asked again, or a fix of
// marker:M1, and the reviews after it). A count that differs from the
// TODO(port) lines may be a TODO(port) line left out, a missing trailer needs
// the worker's own confidence, and trailers that disagree need a choice: those
// still go to the worker.

const STATUS = 'PORT STATUS:';
const lineOpener = /^(?:\/{2,}|#+|-{2,}|'|rem|::|;+|%+)$/i;
const blockClosers = { '<!--': '-->', '<%--': '--%>', '<%#': '%>', '@*': '*@', '{#': '#}' };
const closerOf = opener => /^\/\*+$/.test(opener) ? '*/' : /^\(\*+$/.test(opener) ? '*)' : blockClosers[opener];
// Comments of a markup or a template: valid between elements, so they may move
// below closing tags (Razor's @* *@ is valid in its code blocks too).
const markup = new Set(['<!--', '<%--', '<%#', '{#']);

// A comment that holds the whole line, with PORT STATUS right after its
// opener: a line comment (not one a final backslash continues, not a VB ' with
// another ' after it, which is more likely a string), or a block comment whose
// closer ends the line or is missing (closed false). Anything else on the line
// (code before it, code after its closer) makes it no such comment.
export function trailerComment(text) {
  const line = text.trim(), at = line.indexOf(STATUS);
  if (at < 0) return null;
  const opener = line.slice(0, at).trimEnd(), rest = line.slice(at + STATUS.length);
  if (lineOpener.test(opener)) return /\\$/.test(rest.trimEnd()) || (opener === "'" && rest.includes("'")) ? null : { opener, closer: null, body: rest, closed: true };
  const closer = closerOf(opener);
  if (!closer) return null;
  const end = rest.indexOf(closer);
  if (end < 0) return { opener, closer, body: rest, closed: false };
  // A closer drawn with more asterisks (**/, **)) leaves them out of the body.
  return rest.slice(end + closer.length).trim() ? null : { opener, closer, body: rest.slice(0, end).replace(closer.startsWith('*') ? /\*+$/ : /$/, ''), closed: true };
}

// The confidence and the count a trailer says, read leniently: either order,
// capitals, = or :, quotes or brackets around a value, commas and other
// separators between. Exactly one of each, and nothing else but separators.
const separators = /^[\s,;|.:/()[\]{}"'`\-–—、。]*$/;
export function trailerValues(body) {
  const confidence = [...body.matchAll(/\bconfidence\b\s*[:=]?\s*["'`[({<]?\s*(high|medium|low)\b\s*["'`\])}>]?/gi)];
  const todos = [...body.matchAll(/\btodos?\b\s*[:=]?\s*["'`[({<]?\s*(\d+)\b\s*["'`\])}>]?/gi)];
  if (confidence.length !== 1 || todos.length !== 1) return null;
  let rest = body;
  for (const m of [...confidence, ...todos].sort((a, b) => b.index - a.index)) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
  const count = Number(todos[0][1]);
  return separators.test(rest) && Number.isSafeInteger(count) ? { confidence: confidence[0][1].toLowerCase(), todos: count } : null;
}

// Lines that close a block, which a trailer above them may move below: a
// closing brace or bracket (not a line with Lua's ]] in it, which may end a
// long string, as )]] does), an end keyword (a bare END or End is left out: a
// heredoc ends with it), a shell fi/done/esac, #endif or #endregion, each
// with a line comment after it or not. A string's end (a quote, a backtick)
// is none, so a trailer inside a string is never moved out of it.
const comment = String.raw`(?:[ \t]*(?:\/\/|#|--|').*)?`;
const codeClosers = [String.raw`(?!.*\]\])[)\]}][ \t()\]};,]*`, String.raw`end\w*(?:[ \t]+[\w.]+)*[ \t]*[()\]};,.]*`, String.raw`(?:End|END)[ \t]+\w+(?:[ \t]+[\w.]+)*[ \t]*;?`,
  String.raw`END[ \t]*[;.]`, String.raw`(?:fi|done|esac)[ \t]*;?`].map(core => new RegExp(`^${core}${comment}$`));
const codeCloser = t => codeClosers.some(re => re.test(t)) || /^#[ \t]*(?:endif|endregion|end[ \t]+region|pragma[ \t]+endregion)\b/i.test(t);
const tagCloser = t => /^(?:(?:<\/[A-Za-z_][\w:.-]*[ \t]*>|<!--(?:(?!-->).)*-->)[ \t]*)+$/.test(t);
// Another line comment of the same kind as a line-comment trailer, one that
// closes no block comment (-->, #}, */ and the like): a trailer inside
// <!-- ... --> or {# ... #} is never moved out of it.
const blockEnd = /-->|--%>|%>|\*\/|\*@|#\}|\*\)/;
const sameComment = (t, opener) => {
  if (blockEnd.test(t)) return false;
  const family = /^(\/\/|#|--|;|%|::)/.exec(opener)?.[1];
  return family ? t.startsWith(family) : opener === "'" ? t.startsWith("'") : /^rem(?:\s|$)/i.test(t);
};
function closes(text, opener) {
  const t = text.trim();
  if (markup.has(opener)) return tagCloser(t);
  if (opener === '@*') return tagCloser(t) || codeCloser(t);
  return codeCloser(t) || (!closerOf(opener) && sameComment(t, opener));
}

// Lines with their endings, so a rewrite keeps CRLF or LF and a missing final newline.
const splitLines = text => text.split(/(?<=\n)/).map(chunk => chunk.endsWith('\r\n') ? { text: chunk.slice(0, -2), eol: '\r\n' } : chunk.endsWith('\n') ? { text: chunk.slice(0, -1), eol: '\n' } : { text: chunk, eol: '' });
const joinLines = lines => lines.map(l => l.text + l.eol).join('');
// The whole-line PORT STATUS comments, by index. A block comment left open
// counts only when nothing but its closer, on a line of its own, follows it
// (that line counts too): otherwise it hides the lines after it.
function trailerLines(lines) {
  const found = new Set();
  for (let i = 0; i < lines.length; i++) {
    const c = trailerComment(lines[i].text);
    if (!c) continue;
    if (c.closed) { found.add(i); continue; }
    const next = lines.findIndex((l, j) => j > i && l.text.trim());
    if (next < 0) found.add(i);
    else if (lines[next].text.trim() === c.closer) { found.add(i); found.add(next); i = next; }
  }
  return found;
}

// The text without its whole-line PORT STATUS comments. A text whose
// comment-looking line sits inside a multi-line string is read the same way,
// as withoutFlags in pipeline.mjs reads quotes only on their own line.
export function trailerless(text) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = splitLines(text.slice(bom.length)), found = trailerLines(lines);
  return bom + joinLines(lines.filter((_, i) => !found.has(i)));
}
// Two texts that differ in nothing but their whole-line PORT STATUS comments,
// and in whether the text before them ends with a line ending at all (the line
// a trailer moves below gains one). A line ending that changes kind (CRLF, LF)
// is a change.
export function sameButTrailer(a, b) {
  const [x, y] = [a, b].map(text => /^([\s\S]*?)(\r?\n)?$/.exec(trailerless(text)));
  return x[1] === y[1] && (x[2] === y[2] || !x[2] || !y[2]);
}

// The content with its trailer rewritten, or null when the runner cannot fix
// it alone. Every PORT STATUS line must be a whole-line comment saying the same
// confidence and count, the count must match the TODO(port) lines, and every
// nonempty line after the first must close a block (so moving the trailer below
// them changes nothing else). The rewrite keeps the comment's own opener (the
// worker chose the syntax), adds a missing closer, and goes after the last
// nonempty line in the agreed form. A JSON file carries no trailer
// (noTrailer): its trailer comments are taken out. It is used only when the
// result passes and nothing but the trailer changed.
// target: the unit's target path (markerEvidence reads its extension).
export function repairTrailer(config, content, target) {
  const evidence = markerEvidence(config, content, target);
  if (!evidence || evidence.valid) return null;
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = splitLines(content.slice(bom.length));
  const at = lines.flatMap((l, i) => l.text.includes(STATUS) ? [i] : []);
  const found = trailerLines(lines);
  if (!at.length || at.some(i => !found.has(i))) return null;
  const checked = text => markerEvidence(config, text, target)?.valid && sameButTrailer(content, text) ? text : null;
  if (evidence.noTrailer) return checked(bom + joinLines(lines.filter((_, i) => !found.has(i))));
  const comments = at.map(i => trailerComment(lines[i].text)), values = comments.map(c => trailerValues(c.body));
  if (values.some(v => !v) || new Set(values.map(v => `${v.confidence} ${v.todos}`)).size > 1 || new Set(comments.map(c => c.opener)).size > 1) return null;
  const [{ opener, closer }] = comments, [{ confidence, todos }] = values;
  for (let i = at[0] + 1; i < lines.length; i++) if (!found.has(i) && lines[i].text.trim() && !closes(lines[i].text, opener)) return null;
  const kept = lines.filter((_, i) => !found.has(i));
  const last = kept.findLastIndex(l => l.text.trim());
  const eol = lines[at[0]].eol || lines.find(l => l.eol)?.eol || '\n';
  const after = last < 0 ? lines[at[0]].eol : kept[last].eol;
  if (last >= 0) kept[last] = { text: kept[last].text, eol: kept[last].eol || eol };
  kept.splice(last + 1, 0, { text: `${opener} PORT STATUS: confidence=${confidence} todos=${todos}${closer ? ` ${closer}` : ''}`, eol: after });
  return checked(bom + joinLines(kept));
}
