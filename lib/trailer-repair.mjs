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
// capitals, =, : or a space before a value, todo or todos, a value in quotes
// or brackets, commas and other separators between, the whole in brackets.
// Exactly one of each, and nothing else but separators. A quote, a backtick
// or a bracket left over (one that pairs with nothing on the line) is not
// read: the line may end a string or a literal opened above it, which the
// rewrite would leave open.
const separators = /^[\s,;|.:/()[\]{}\-–—、。]*$/;
const valueOf = (key, word) => new RegExp(String.raw`\b${key}\b\s*[:=]?\s*(?:(["'\`])\s*(${word})\s*\1|\[\s*(${word})\s*\]|\(\s*(${word})\s*\)|\{\s*(${word})\s*\}|<\s*(${word})\s*>|(${word})\b)`, 'gi');
const confidenceValue = valueOf('confidence', 'high|medium|low'), todosValue = valueOf('todos?', String.raw`\d+`);
const valueIn = match => match.slice(2).find(v => v !== undefined);
const balanced = text => {
  const open = [];
  for (const ch of text) {
    if ('([{'.includes(ch)) open.push(')]}'['([{'.indexOf(ch)]);
    else if (')]}'.includes(ch) && open.pop() !== ch) return false;
  }
  return !open.length;
};
export function trailerValues(body) {
  const confidence = [...body.matchAll(confidenceValue)], todos = [...body.matchAll(todosValue)];
  if (confidence.length !== 1 || todos.length !== 1) return null;
  let rest = body;
  for (const m of [...confidence, ...todos].sort((a, b) => b.index - a.index)) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
  const count = Number(valueIn(todos[0]));
  return separators.test(rest) && balanced(rest) && Number.isSafeInteger(count) ? { confidence: valueIn(confidence[0]).toLowerCase(), todos: count } : null;
}

// Lines that close a block, which a trailer above them may move below: a
// closing brace, bracket or parenthesis, an end keyword (end, endif, end;,
// End Class and the like: end or a word of lowercase letters that starts
// with it, not endef, which ends a Makefile define; not a bare END or End,
// nor a name that goes on with _ or a digit), below a # comment a shell fi,
// done or esac, and #endif or #endregion, each with a line comment after it
// or not. Each pattern ends with its own spaces, so a failed match does not
// backtrack over them twice.
const comment = String.raw`(?:(?:\/\/|#|--|').*)?`;
const codeClosers = [String.raw`[)\]}][ \t()\]};,]*`, String.raw`(?!endef\b)end[a-z]*\b(?:[ \t]+[\w.]+)*[ \t]*(?:[()\]};,.]+[ \t]*)?`,
  String.raw`(?:End|END)[ \t]+\w+(?:[ \t]+[\w.]+)*[ \t]*(?:;[ \t]*)?`, String.raw`END[ \t]*[;.][ \t]*`].map(core => new RegExp(`^${core}${comment}$`));
const shellCloser = new RegExp(String.raw`^(?:fi|done|esac)[ \t]*(?:;[ \t]*)?${comment}$`);
const codeCloser = (t, opener) => codeClosers.some(re => re.test(t)) || (opener.startsWith('#') && shellCloser.test(t)) ||
  /^#[ \t]*(?:endif|endregion|end[ \t]+region|pragma[ \t]+endregion)\b/i.test(t);
// Closing tags and HTML comments; not the end of an element whose text is
// kept as written (a comment line inside <pre> or <textarea> is its text).
const verbatimTag = /<\/(?:script|style|textarea|title|pre|xmp|listing|plaintext|iframe|noembed|noframes|noscript)\b/i;
const tagCloser = t => /^(?:(?:<\/[A-Za-z_][\w:.-]*[ \t]*>|<!--(?:(?!-->).)*-->)[ \t]*)+$/.test(t) && !verbatimTag.test(t);
// The end of a block comment, a long string, a literal or a block of code
// in a page (-->, */, *), #>, ]], ]=], -}, %}, PHP's ?> and the like, or a
// line of nothing but CoffeeScript's ###): a trailer is never moved past one,
// out of <!-- ... -->, <# ... #>, --[[ ... ]], --[=[ ... ]=], ### ... ###, a
// Lua long string or <?php ... ?> (a // comment there ends at ?>).
const blockEnd = /-->|--%>|%>|\*\/|\*@|#\}|#>|\*\)|\]=*\]|\]#|-\}|=#|%\}|\|#|\+\/|\?>|^###$/;
// Another line comment of the same kind as a line-comment trailer.
const sameComment = (t, opener) => {
  const family = /^(\/\/|#|--|;|%|::)/.exec(opener)?.[1];
  return family ? t.startsWith(family) : opener === "'" ? t.startsWith("'") : /^rem(?:\s|$)/i.test(t);
};
// The line without its whole /* ... */ comments that hold no quote, no
// backtick and no other closer (#endif /* A_H */, } /* end */), read once
// from the left.
function withoutBlockComments(text) {
  let out = '', from = 0;
  for (let open = text.indexOf('/*'); open >= 0; open = text.indexOf('/*', from)) {
    const close = text.indexOf('*/', open + 2), body = close < 0 ? '' : text.slice(open + 2, close);
    // A comment left open, or one holding a quote or another closer
    // (/* --> */), stays: the tests after this refuse the line anyway.
    if (close < 0 || /["'`]/.test(body) || blockEnd.test(body)) break;
    out += `${text.slice(from, open)} `;
    from = close + 2;
  }
  return out + text.slice(from);
}
// Whether a block comment (/* ... */ unless told otherwise) is open at the
// end of the text, nested ones counted (Rust and OCaml nest them). An opener
// in a string or a line comment counts too, which only keeps a trailer where
// it is.
function commentOpen(text, open = '/*', close = '*/') {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith(open, i)) { depth++; i += open.length - 1; } else if (depth && text.startsWith(close, i)) { depth--; i += close.length - 1; }
  }
  return depth > 0;
}
// A closing tag below a comment of the markup; otherwise a code closer or a
// comment line that holds no quote or backtick (one may end a string opened
// above: VB's ' is its comment) and ends no block comment or long string.
// With inline set (a // or /* trailer, no block comment open above it), the
// whole /* ... */ comments on the line are read away first, and a line of
// nothing else closes too.
function closes(text, opener, inline) {
  const raw = text.trim();
  if (markup.has(opener) || (opener === '@*' && tagCloser(raw))) return tagCloser(raw);
  const t = inline ? withoutBlockComments(raw).trim() : raw;
  if (!t) return true;
  if (/["`]/.test(t) || (opener !== "'" && t.includes("'")) || blockEnd.test(t)) return false;
  return codeCloser(t, opener) || (!closerOf(opener) && sameComment(t, opener));
}
// The ends of heredocs opened on these lines (<<EOF, <<-EOF, <<~EOF, PHP's
// <<<EOF, quoted or not; of <<"END OF TEXT" its first word; an end of other
// characters quoted right after <<, <<- or <<~, as <<"}", or after spaces
// below a # trailer, where no C++ << "}" stands): whether a line after the
// trailer starts with one (and goes on with no letter, digit or _), which
// may end a string, so the trailer is not moved past it.
function heredocEnds(lines, spaced) {
  const words = new Set(), others = new Set();
  const other = spaced ? /<<[-~]?[ \t]*(["'])([^\w\s"'`][^\s"'`]*)\1/g : /<<[-~]?(["'])([^\w\s"'`][^\s"'`]*)\1/g;
  for (const { text } of lines) {
    for (const m of text.matchAll(/<<(?:<|[-~])?[ \t]*["'`]?\\?([A-Za-z_]\w*)/g)) words.add(m[1]);
    for (const m of text.matchAll(other)) others.add(m[2]);
  }
  const rest = [...others];
  return t => words.has(/^[A-Za-z_]\w*/.exec(t)?.[0]) || rest.some(end => t.startsWith(end) && !/\w/.test(t.charAt(end.length)));
}
// Files whose code blocks sit in markup (Razor, MDX, Astro, Svelte): after a
// code block's closing brace (or End Code) comes page text, so only a comment
// of the markup (or Razor's @* *@) moves below it. Markdown too: a line there
// that looks like a line comment is text (# is a heading).
const markupHost = /\.(?:razor|cshtml|vbhtml|mdx|astro|svelte|md|markdown)$/i;
// Files where a bracket may end a literal or a comment (Ruby's %w[ ] and
// %q{ }, Perl's qw( ), Elixir's ~w[ ], Pascal's { }, Tcl's { } string): no
// line with a bracket in it is a closer there.
const bracketLiterals = /(?:\.(?:rb|rbi|rbw|rake|gemspec|podspec|jbuilder|rabl|builder|thor|ru|cr|ex|exs|pl|pm|t|psgi|cgi|pas|pp|dpr|dpk|lpr|tcl|tk|exp)|(?:^|[\\/])(?:Rakefile|Gemfile|Guardfile|Vagrantfile|Podfile|Fastfile|Brewfile|Capfile|Dangerfile|Berksfile|Thorfile))$/i;

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
// them changes nothing else) and end no heredoc opened above; below a // or /*
// trailer with no block comment open above it, whole /* ... */ comments on
// such a line are read away first (#endif /* A_H */). No line a backslash
// continues may run into a trailer line (once the trailer is gone it would
// run into the next line). The trailer is not moved in YAML, nor, unless it
// is a comment of the markup, in a file whose code sits in markup or in
// Markdown (markupHost), nor below a bracket where a bracket may end a
// literal (bracketLiterals); in YAML and
// Markdown, where an indented line is text, it must not be indented. The
// rewrite keeps the comment's own opener (the worker chose the syntax), adds
// a missing closer, and goes after the last nonempty line (where it was, when
// nothing nonempty follows it) in the agreed form;
// the file's last line ending (or its lack of one) stays at the end. A JSON
// file carries no trailer (noTrailer): its trailer comments are taken out,
// unless one holds a TODO(port) note. It is used only when the result passes
// and nothing but the trailer changed.
// target: the unit's target path (markerEvidence reads its extension).
export function repairTrailer(config, content, target) {
  const evidence = markerEvidence(config, content, target);
  if (!evidence || evidence.valid) return null;
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = splitLines(content.slice(bom.length));
  const at = lines.flatMap((l, i) => l.text.includes(STATUS) ? [i] : []);
  const found = trailerLines(lines);
  if (!at.length || at.some(i => !found.has(i))) return null;
  if ([...found].some(i => i > 0 && /\\$/.test(lines[i - 1].text.trimEnd()))) return null;
  const checked = text => markerEvidence(config, text, target)?.valid && sameButTrailer(content, text) ? text : null;
  if (evidence.noTrailer) return [...found].some(i => lines[i].text.includes('TODO(port)')) ? null : checked(bom + joinLines(lines.filter((_, i) => !found.has(i))));
  const comments = at.map(i => trailerComment(lines[i].text)), values = comments.map(c => trailerValues(c.body));
  if (values.some(v => !v) || new Set(values.map(v => `${v.confidence} ${v.todos}`)).size > 1 || new Set(comments.map(c => c.opener)).size > 1) return null;
  const [{ opener, closer }] = comments, [{ confidence, todos }] = values;
  const below = lines.flatMap((l, i) => i > at[0] && !found.has(i) && l.text.trim() ? [l.text.trim()] : []);
  if (/\.(?:ya?ml|md|markdown)$/i.test(target) && at.some(i => /^\s/.test(lines[i].text))) return null;
  if (below.length && (/\.ya?ml$/i.test(target) || (markupHost.test(target) && !markup.has(opener) && opener !== '@*') ||
    (bracketLiterals.test(target) && below.some(t => /[()[\]{}]/.test(t))))) return null;
  const above = lines.slice(0, at[0]), endsHeredoc = heredocEnds(above, opener.startsWith('#')), aboveText = below.length ? joinLines(above) : '';
  // A block-comment trailer may close a comment of its kind opened above it
  // (/* old, then /* PORT STATUS ... */): moved, it would leave that comment
  // open over the lines below.
  if (below.length && closer && commentOpen(aboveText, /^\/\*+$/.test(opener) ? '/*' : /^\(\*+$/.test(opener) ? '(*' : opener, closer)) return null;
  const inline = below.some(t => t.includes('/*')) && (opener.startsWith('//') || /^\/\*+$/.test(opener)) && !commentOpen(aboveText);
  if (below.some(t => !closes(t, opener, inline) || endsHeredoc(t))) return null;
  const kept = lines.filter((_, i) => !found.has(i));
  // After the last nonempty line; with nothing nonempty after the trailer,
  // where its last line was, so blank lines above it stay above (a YAML |+
  // block keeps them in its value).
  const place = below.length ? kept.findLastIndex(l => l.text.trim()) + 1 : lines.filter((_, i) => i < Math.max(...found) && !found.has(i)).length;
  const eol = lines[at[0]].eol || lines.find(l => l.eol)?.eol || '\n';
  // The trailer takes the file's last line ending when it becomes the last
  // line; the line it moves below gains one when it had none.
  if (place > 0 && !kept[place - 1].eol) kept[place - 1] = { text: kept[place - 1].text, eol };
  kept.splice(place, 0, { text: `${opener} PORT STATUS: confidence=${confidence} todos=${todos}${closer ? ` ${closer}` : ''}`,
    eol: place === kept.length ? lines[lines.length - 1].eol : eol });
  return checked(bom + joinLines(kept));
}
