// SPDX-License-Identifier: Apache-2.0
// 2026-11-04 (0.46.0): on the Windows run (phase 04, 98 of 554 units) one
// wrong PORT STATUS line made a worker return the whole file again, more than
// once: the answer was asked again, then the trailer went to the fixer as
// marker:M1, and the fixed file had both reviews again from the start. A
// trailer wrong only in its form or place (capitals, punctuation, the line
// above the final closing brace or tag, a block comment left open, the same
// trailer twice, a trailer in a JSON file) is now rewritten by the runner,
// with no worker call. A count that differs from the TODO(port) lines still
// goes to a worker: it may be a TODO(port) line left out. After a single-pass
// fix, a fix of the trailer alone keeps that fix's reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake, result, finding, mini } from './helpers.mjs';
import { safePath, writeJSON, readJSON, unitState, statePath, fileHash, inputContext, done, hash } from '../lib/core.mjs';
import { translate, approve, runStage } from '../lib/pipeline.mjs';
import { markerEvidence } from '../lib/markers.mjs';
import { repairTrailer, trailerless, sameButTrailer } from '../lib/trailer-repair.mjs';

const policy = { markerPolicy: 'todo-lines-v1' };

test('the runner rewrites a trailer wrong only in its form or place, and nothing else', () => {
  const cases = [
    ['above the closing brace', 'ported/a.mjs', 'a();\n  // PORT STATUS: confidence=high todos=0\n}\n', 'a();\n}\n// PORT STATUS: confidence=high todos=0\n'],
    ['above closers, one with a comment, with a TODO(port) counted', 'ported/A.cs', 'class A {\n  // TODO(port): x\n  // PORT STATUS: confidence=medium todos=1\n  }\n} // namespace N\n',
      'class A {\n  // TODO(port): x\n  }\n} // namespace N\n// PORT STATUS: confidence=medium todos=1\n'],
    ['no final newline', 'ported/a.mjs', 'a();\n// PORT STATUS: confidence=high todos=0\n}', 'a();\n}\n// PORT STATUS: confidence=high todos=0'],
    ['CRLF', 'ported/a.mjs', 'a();\r\n// PORT STATUS: confidence=high todos=0\r\n}\r\n', 'a();\r\n}\r\n// PORT STATUS: confidence=high todos=0\r\n'],
    ['a byte order mark', 'ported/a.mjs', '\uFEFFa();\n// PORT STATUS: confidence=high todos=0\n}\n', '\uFEFFa();\n}\n// PORT STATUS: confidence=high todos=0\n'],
    ['blank lines at the end', 'ported/a.mjs', 'a();\n// PORT STATUS: confidence=high todos=0\n}\n\n', 'a();\n}\n// PORT STATUS: confidence=high todos=0\n\n'],
    ['capitals and punctuation', 'ported/a.mjs', 'x();\n// PORT STATUS: Confidence=HIGH, todos: 0.\n', 'x();\n// PORT STATUS: confidence=high todos=0\n'],
    ['quotes, the other order', 'ported/a.py', 'x()\n# PORT STATUS: todos="0" confidence="low"\n', 'x()\n# PORT STATUS: confidence=low todos=0\n'],
    ['the same trailer twice', 'ported/a.mjs', 'a();\n// PORT STATUS: confidence=low todos=0\n}\n// PORT STATUS: confidence=low todos=0\n', 'a();\n}\n// PORT STATUS: confidence=low todos=0\n'],
    ['VB', 'ported/A.vb', "Class A\n  ' PORT STATUS: confidence=high todos=0\nEnd Class\n", "Class A\nEnd Class\n' PORT STATUS: confidence=high todos=0\n"],
    ['Ruby', 'ported/a.rb', 'def f\n  1\n  # PORT STATUS: confidence=high todos=0\nend\n', 'def f\n  1\nend\n# PORT STATUS: confidence=high todos=0\n'],
    ['a header guard', 'ported/a.h', '#ifndef A_H\n#define A_H\n// PORT STATUS: confidence=high todos=0\n#endif // A_H\n', '#ifndef A_H\n#define A_H\n#endif // A_H\n// PORT STATUS: confidence=high todos=0\n'],
    ['XML above the closing root tag', 'ported/Database.xml', '<root>\n  <!-- PORT STATUS: confidence=high todos=0 -->\n</root>\n', '<root>\n</root>\n<!-- PORT STATUS: confidence=high todos=0 -->\n'],
    ['an XML comment left open', 'ported/Database.xml', '<root>\n</root>\n<!-- PORT STATUS: confidence=high todos=0\n', '<root>\n</root>\n<!-- PORT STATUS: confidence=high todos=0 -->\n'],
    ['an XML comment closed on the line below', 'ported/Database.xml', '<root>\n</root>\n<!-- PORT STATUS: confidence=high todos=0\n-->\n', '<root>\n</root>\n<!-- PORT STATUS: confidence=high todos=0 -->\n'],
    ['JSP above closing tags', 'ported/a.jsp', '<html>\n<%-- PORT STATUS: confidence=High todos=0 --%>\n</body></html>\n', '<html>\n</body></html>\n<%-- PORT STATUS: confidence=high todos=0 --%>\n'],
    ['Razor in a code block', 'ported/A.razor', '<p/>\n@code {\n  @* PORT STATUS: confidence=high todos=0 *@\n}\n', '<p/>\n@code {\n}\n@* PORT STATUS: confidence=high todos=0 *@\n'],
    ['a closer drawn with asterisks', 'ported/a.ml', 'let x = 1\n(** PORT STATUS: Confidence=high todos=0 **)\n', 'let x = 1\n(** PORT STATUS: confidence=high todos=0 *)\n'],
    ['a CSS comment left open', 'ported/a.css', 'a {}\n/* PORT STATUS: confidence=high todos=0\n', 'a {}\n/* PORT STATUS: confidence=high todos=0 */\n'],
    ['a JSON file\'s trailer', 'ported/app.json', '{\n  "a": 1\n}\n// PORT STATUS: confidence=high todos=0\n', '{\n  "a": 1\n}\n'],
    ['a JSON file\'s two trailers', 'ported/app.json', '{\n  "a": 1\n// PORT STATUS: x\n}\n<!-- PORT STATUS: y -->\n', '{\n  "a": 1\n}\n'],
    ['SQL above END;', 'ported/a.sql', 'BEGIN\n  x;\n-- PORT STATUS: confidence=high todos=0\nEND;\n', 'BEGIN\n  x;\nEND;\n-- PORT STATUS: confidence=high todos=0\n'],
    ['YAML, the form alone at the end', 'ported/a.yml', 'a: 1\n# PORT STATUS: Confidence=High todos=0\n', 'a: 1\n# PORT STATUS: confidence=high todos=0\n'],
    ['a shift is no heredoc', 'ported/a.cpp', 'int f() {\n  return 1 << 2;\n// PORT STATUS: confidence=high todos=0\n}\n', 'int f() {\n  return 1 << 2;\n}\n// PORT STATUS: confidence=high todos=0\n'],
    ['HTML above its body and html tags', 'ported/a.html', '<body>\n<p/>\n<!-- PORT STATUS: confidence=high todos=0 -->\n</body>\n</html>\n', '<body>\n<p/>\n</body>\n</html>\n<!-- PORT STATUS: confidence=high todos=0 -->\n'],
    ['no final newline, the form alone', 'ported/a.mjs', 'x();\n// PORT STATUS: Confidence=HIGH todos=0', 'x();\n// PORT STATUS: confidence=high todos=0'],
    ['the whole in brackets', 'ported/a.mjs', 'x();\n// PORT STATUS: (Confidence=High, todos=0)\n', 'x();\n// PORT STATUS: confidence=high todos=0\n'],
    ['values in brackets, todo, no equals sign', 'ported/a.mjs', 'x();\n// PORT STATUS: confidence [High] todo (0)\n', 'x();\n// PORT STATUS: confidence=high todos=0\n'],
    ['VB, an apostrophe in the comment after End Class', 'ported/A.vb', "Class A\n  ' PORT STATUS: confidence=High todos=0\nEnd Class ' it's done\n", "Class A\nEnd Class ' it's done\n' PORT STATUS: confidence=high todos=0\n"],
    ['shell fi, a heredoc closed above', 'ported/a.sh', 'cat <<EOF\nhi\nEOF\nif true; then\n  # PORT STATUS: confidence=High todos=0\nfi\n', 'cat <<EOF\nhi\nEOF\nif true; then\nfi\n# PORT STATUS: confidence=high todos=0\n'],
    ['CMake endif()', 'ported/CMakeLists.txt', 'if(X)\n  # PORT STATUS: confidence=High todos=0\nendif()\n', 'if(X)\nendif()\n# PORT STATUS: confidence=high todos=0\n'],
    ['Razor, an HTML comment above a closing tag', 'ported/A.razor', '<div>\n<!-- PORT STATUS: confidence=High todos=0 -->\n</div>\n', '<div>\n</div>\n<!-- PORT STATUS: confidence=high todos=0 -->\n'],
    ['XML, a comment closed on its own line above the root tag', 'ported/Database.xml', '<root>\n<!-- PORT STATUS: confidence=High todos=0\n-->\n</root>\n', '<root>\n</root>\n<!-- PORT STATUS: confidence=high todos=0 -->\n']];
  for (const [name, target, before, after] of cases) {
    assert.equal(markerEvidence(policy, before, target).valid, false, `${name}: the check refuses it`);
    assert.equal(repairTrailer(policy, before, target), after, name);
    assert.equal(markerEvidence(policy, after, target).valid, true, `${name}: the rewrite passes`);
    assert.equal(sameButTrailer(before, after), true, `${name}: only the trailer changed`);
    assert.equal(repairTrailer(policy, after, target), null, `${name}: a valid trailer is left alone`);
  }
  // Without the marker policy nothing is rewritten.
  assert.equal(repairTrailer({}, cases[0][2], 'ported/a.mjs'), null);
});

test('a trailer only a worker can settle, or one the runner cannot move safely, is left to the worker', () => {
  const cases = [
    ['a count that differs: a TODO(port) line may be missing', 'ported/a.mjs', 'x();\n// PORT STATUS: confidence=high todos=2\n'],
    ['a count that differs, above the brace', 'ported/a.mjs', 'a();\n// PORT STATUS: confidence=high todos=1\n}\n'],
    ['no trailer: the confidence is the worker\'s', 'ported/a.mjs', 'x();\n'],
    ['trailers that disagree', 'ported/a.mjs', 'a();\n// PORT STATUS: confidence=low todos=0\n}\n// PORT STATUS: confidence=high todos=0\n'],
    ['no confidence', 'ported/a.mjs', 'x();\n// PORT STATUS: todos=0\n'],
    ['two confidences', 'ported/a.mjs', 'x();\n// PORT STATUS: confidence=high/medium todos=0\n'],
    ['words besides the values', 'ported/a.mjs', 'x();\n// PORT STATUS: confidence=high todos=0 (all done)\n'],
    ['code after the trailer', 'ported/a.mjs', 'class A {\n// PORT STATUS: confidence=high todos=0\n}\nclass B {}\n'],
    ['inside a Python string', 'ported/a.py', 's = """\n# PORT STATUS: confidence=high todos=0\n"""\n'],
    ['inside a template literal', 'ported/a.mjs', 'const s = `\n// PORT STATUS: confidence=high todos=0\n`;\n'],
    ['inside a Lua long string', 'ported/a.lua', 's = [[\n-- PORT STATUS: confidence=high todos=0\n]]\n'],
    ['inside a Lua long string that ends after a parenthesis', 'ported/a.lua', 's = f([[\n-- PORT STATUS: confidence=high todos=0\n)]])\n'],
    ['inside a heredoc that ends with END', 'ported/a.rb', 's = <<~END\n# PORT STATUS: confidence=high todos=0\nEND\n'],
    ['before PHP\'s closing tag (after it the line would be output)', 'ported/a.php', '<?php\necho 1;\n// PORT STATUS: confidence=high todos=0\n?>\n'],
    ['a line comment above a closing tag (inside a script element)', 'ported/a.html', '<script>\n// PORT STATUS: confidence=high todos=0\n</script>\n'],
    ['a comment left open that hides what follows', 'ported/Database.xml', '<root>\n<!-- PORT STATUS: confidence=high todos=0\n<a/>\n</root>\n'],
    ['a line comment inside an XML comment', 'ported/Database.xml', '<root/>\n<!--\n-- PORT STATUS: confidence=high todos=0\n-->\n'],
    ['a line comment inside a Jinja comment', 'ported/page.html', '<p/>\n{#\n# PORT STATUS: confidence=high todos=0\n#}\n'],
    ['a line comment above the end of a block comment', 'ported/a.c', 'x;\n/*\n// PORT STATUS: confidence=high todos=0\n// end */\n'],
    ['a trailer on a line of code', 'ported/a.py', 'x = 1 # PORT STATUS: Confidence=high todos=0\n'],
    ['a line comment a backslash continues', 'ported/a.c', 'a();\n// PORT STATUS: confidence=high todos=0 \\\n}\n'],
    ['a quote that is more likely a string', 'ported/a.py', "x = [\n'PORT STATUS: confidence=high todos=0',\n]\n"],
    ['a comment block\'s inner line', 'ported/A.java', '/**\n * PORT STATUS: confidence=high todos=0\n */\n'],
    ['a JSON value that holds the words', 'ported/app.json', '{\n  "a": "PORT STATUS: x"\n}\n'],
    ['a JSON trailer after a value on its line', 'ported/app.json', '{\n  "a": 1\n} // PORT STATUS: confidence=high todos=0\n'],
    // Ends of strings, heredocs and comments of another kind that look like closers.
    ['inside a PHP heredoc that ends with END;', 'ported/a.php', '<?php\n$s = <<<END\n// PORT STATUS: confidence=high todos=0\nEND;\n'],
    ['inside a PHP nowdoc', 'ported/a.php', "<?php\n$s = <<<'END'\n// PORT STATUS: confidence=high todos=0\nEND;\n"],
    ['inside a Makefile define', 'ported/Makefile', 'define SCRIPT\n# PORT STATUS: confidence=high todos=0\nendef\n'],
    ['inside a Ruby heredoc that ends with end', 'ported/a.rb', 's = <<~end\n# PORT STATUS: confidence=high todos=0\nend\n'],
    ['inside a shell heredoc that ends with done', 'ported/a.sh', 'cat <<done\n# PORT STATUS: confidence=high todos=0\ndone\n'],
    ['inside a quoted shell heredoc that ends with fi', 'ported/a.sh', 'cat <<-"fi"\n# PORT STATUS: confidence=high todos=0\nfi\n'],
    ['a line a backslash continues into the trailer', 'ported/a.sh', 'f() {\n  echo hi \\\n# PORT STATUS: confidence=High todos=0\n}\n'],
    ['inside a textarea', 'ported/a.html', '<textarea>\n<!-- PORT STATUS: confidence=high todos=0 -->\n</textarea>\n'],
    ['inside a pre element', 'ported/a.html', '<pre>\n<!-- PORT STATUS: confidence=high todos=0 -->\n</pre>\n'],
    ['inside a YAML block scalar, above a brace', 'ported/a.yml', 'cmd: |\n  # PORT STATUS: confidence=high todos=0\n  }\n'],
    ['indented in YAML (a block scalar\'s last line)', 'ported/a.yaml', 'cmd: |\n  echo\n  # PORT STATUS: Confidence=High todos=0\n'],
    ['indented in Markdown (a code block)', 'ported/a.md', 'text\n\n    <!-- PORT STATUS: Confidence=High todos=0 -->\n'],
    ['inside a PowerShell block comment', 'ported/a.ps1', '<#\n# PORT STATUS: confidence=high todos=0\n#>\n'],
    ['inside a Lua block comment', 'ported/a.lua', '--[[\n-- PORT STATUS: confidence=high todos=0\n--]]\n'],
    // A code block in markup: after its brace (or End Code) comes page text.
    ['Razor, a C# comment in @code', 'ported/Counter.razor', '<h1>Counter</h1>\n@code {\n    private int count;\n    // PORT STATUS: confidence=high todos=0\n}\n'],
    ['Razor, a block comment in @code', 'ported/Counter.razor', '<h1>Counter</h1>\n@code {\n    /* PORT STATUS: confidence=high todos=0 */\n}\n'],
    ['cshtml, a C# comment in @{ }', 'ported/Index.cshtml', '<p>hi</p>\n@{\n    // PORT STATUS: confidence=high todos=0\n}\n'],
    ['vbhtml, a VB comment above End Code', 'ported/Index.vbhtml', "<p>Hi</p>\n@Code\n    ' PORT STATUS: confidence=high todos=0\nEnd Code\n"],
    ['MDX, a comment in an exported function', 'ported/page.mdx', '# Title\n\nexport function Note() {\n  // PORT STATUS: confidence=high todos=0\n}\n'],
    ['Svelte, a comment in an expression', 'ported/A.svelte', '{(() => {\n  // PORT STATUS: confidence=high todos=0\n})()}\n'],
    // A closer line with a quote or backtick may end a string opened above.
    ['a Python string that ends after a parenthesis', 'ported/a.py', "x = '''\n# PORT STATUS: confidence=high todos=0\n)'''\n"],
    ['a Python string whose last line looks like a comment', 'ported/a.py', 'x = """\n# PORT STATUS: confidence=high todos=0\n# end"""\n'],
    ['an awk program in quotes', 'ported/a.sh', "awk '{\n  print $1\n# PORT STATUS: confidence=high todos=0\n}' file\n"],
    ['a template literal whose last line looks like a comment', 'ported/a.mjs', 'const s = `\n// PORT STATUS: confidence=high todos=0\n// do not edit`;\n'],
    ['an SQL string that ends after end', 'ported/a.sql', "INSERT INTO t VALUES ('abc\n-- PORT STATUS: confidence=high todos=0\nend');\n"],
    ['an apostrophe after a closer', 'ported/a.c', "int f() {\n// PORT STATUS: confidence=high todos=0\n} // it's done\n"],
    // The trailer's own line may end a string or a literal.
    ['the trailer line ends a Python string', 'ported/a.py', 'x = """\n# PORT STATUS: confidence=High todos=0"""\n'],
    ['the trailer line ends a template literal', 'ported/a.mjs', 'const s = `\n// PORT STATUS: confidence=High todos=0`;\n'],
    ['a quoted value, then the end of a Python string', 'ported/a.py', 'x = """\n# PORT STATUS: confidence="High" todos="0"""\n'],
    ['the trailer line ends a Lua block comment', 'ported/a.lua', '--[[\n-- PORT STATUS: confidence=High todos=0]]\n'],
    ['the trailer line ends a Ruby word array', 'ported/a.rb', 'x = %w[\n# PORT STATUS: confidence=High todos=0]\n'],
    ['a bracket left open', 'ported/a.mjs', 'x();\n// PORT STATUS: (confidence=High todos=0\n'],
    // Heredocs, literals and keywords.
    ['inside a shell heredoc that ends with end', 'ported/a.sh', 'cat <<end\n# PORT STATUS: confidence=high todos=0\nend\n'],
    ['inside a Perl heredoc with a quoted terminator', 'ported/a.pl', 'print <<"END OF TEXT";\n# PORT STATUS: confidence=high todos=0\nEND OF TEXT\n'],
    ['inside a Ruby word array', 'ported/a.rb', 'WORDS = %w[\n  foo\n  # PORT STATUS: confidence=high todos=0\n]\n'],
    ['inside a Ruby %q string', 'ported/a.rb', 's = %q{\n# PORT STATUS: confidence=high todos=0\n}\n'],
    ['inside a Perl qw list', 'ported/a.pl', 'my @a = qw(\n  a b\n  # PORT STATUS: confidence=high todos=0\n);\n'],
    ['Ruby end with a bracket after it', 'ported/a.rb', 'f(proc do\n  # PORT STATUS: confidence=high todos=0\nend)\n'],
    ['an identifier that starts with end', 'ported/a.py', 'def f():\n    # PORT STATUS: confidence=high todos=0\n    end_time\n'],
    ['done below a // comment', 'ported/a.mjs', 'x();\n// PORT STATUS: confidence=high todos=0\ndone;\n'],
    // Other block comments.
    ['inside a MATLAB block comment', 'ported/a.m', '%{\n% PORT STATUS: confidence=high todos=0\n%}\n'],
    ['inside a Pascal brace comment', 'ported/a.pas', '{\n// PORT STATUS: confidence=high todos=0\n}\n'],
    ['inside a C block comment ended after a brace', 'ported/a.c', '/*\n// PORT STATUS: confidence=high todos=0\n} // */\n'],
    ['inside a Haskell block comment', 'ported/a.hs', '{-\n-- PORT STATUS: confidence=high todos=0\n-- x -}\n'],
    ['inside a Julia block comment', 'ported/a.jl', '#=\n# PORT STATUS: confidence=high todos=0\n=#\n'],
    ['a JSON trailer line that holds a TODO(port) note', 'ported/app.json', '{\n  "a": 1\n}\n// PORT STATUS: confidence=low todos=1 TODO(port): keys\n']];
  for (const [name, target, content] of cases) {
    assert.equal(markerEvidence(policy, content, target).valid, false, `${name}: the check refuses it`);
    assert.equal(repairTrailer(policy, content, target), null, name);
  }
});

test('a long line after the trailer is read in linear time', () => {
  // A closer followed by a long run of spaces and then text once took seconds.
  for (const [head, target, comment] of [['}', 'ported/a.mjs', '// PORT STATUS: confidence=high todos=0'], ['end', 'ported/a.mjs', '// PORT STATUS: confidence=high todos=0'],
    ['End Class', 'ported/a.mjs', '// PORT STATUS: confidence=high todos=0'], ['fi', 'ported/a.sh', '# PORT STATUS: confidence=high todos=0'],
    ['</a>', 'ported/a.xml', '<!-- PORT STATUS: confidence=high todos=0 -->']]) {
    const started = Date.now();
    assert.equal(repairTrailer(policy, `a();\n${comment}\n${head}${' '.repeat(100000)}!\n`, target), null, head);
    assert.ok(Date.now() - started < 2000, `${head}: ${Date.now() - started} ms`);
  }
});

test('a change of the trailer alone is told apart from any other change', () => {
  for (const [name, a, b] of [
    ['moved below the brace', 'a\n// PORT STATUS: x\n}\n', 'a\n}\n// PORT STATUS: y\n'],
    ['moved below the last line, which gains its line ending', 'a\n// PORT STATUS: x\n}', 'a\n}\n// PORT STATUS: y'],
    ['the count', 'a\n// PORT STATUS: confidence=high todos=1\n', 'a\n// PORT STATUS: confidence=high todos=0\n'],
    ['one added where none was', 'a\n', 'a\n// PORT STATUS: confidence=high todos=0\n'],
    ['another comment syntax', 'a\n# PORT STATUS: x\n', 'a\n// PORT STATUS: x\n'],
    ['an open comment closed on its own line', '<r/>\n<!-- PORT STATUS: x\n-->\n', '<r/>\n<!-- PORT STATUS: x -->\n']]) {
    assert.equal(sameButTrailer(a, b), true, name);
  }
  for (const [name, a, b] of [
    ['code', 'a\n// PORT STATUS: x\n', 'b\n// PORT STATUS: x\n'],
    ['code on the trailer\'s line', '} // PORT STATUS: x\n', '}} // PORT STATUS: x\n'],
    ['a TODO(port) line', 'a\n// PORT STATUS: confidence=high todos=0\n', 'a\n// TODO(port): y\n// PORT STATUS: confidence=high todos=1\n'],
    ['a blank line', 'a\nb\n// PORT STATUS: x\n', 'a\n\nb\n// PORT STATUS: x\n'],
    ['line endings', 'a\r\n// PORT STATUS: x\r\n', 'a\n// PORT STATUS: x\n'],
    ['the kind of the last line ending', 'a\r\nb\r\n// PORT STATUS: x', 'a\r\nb\n// PORT STATUS: x'],
    ['an open comment that hid code', '<!-- PORT STATUS: x\n<a/>\n', '<!-- PORT STATUS: x -->\n<a/>\n'],
    ['a continued comment that hid the brace', 'a\n// PORT STATUS: x \\\n}\n', 'a\n}\n// PORT STATUS: x\n'],
    ['the byte order mark', '\uFEFFa\n// PORT STATUS: x\n', 'a\n// PORT STATUS: x\n'],
    ['the words in a string', 'log("PORT STATUS: a");\n', 'log("PORT STATUS: b");\n']]) {
    assert.equal(sameButTrailer(a, b), false, name);
  }
  assert.equal(trailerless('a\n// PORT STATUS: x\n}\n'), 'a\n}\n');
});

// The pipeline, as tests/self-repair-2026-11-01.test.mjs drives it.
const body = () => fs.readFileSync(path.join(mini, 'expected/math_ops.mjs'), 'utf8').replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd();
const trailer = (todos = 0) => `// PORT STATUS: confidence=high todos=${todos}`;
const good = () => `${body()}\n${trailer()}\n`;
const above = text => { const i = text.lastIndexOf('}'); return `${text.slice(0, i)}${trailer()}\n${text.slice(i)}\n`; };
// The single-pass fix: a change inside the function, so its trailer above the
// brace has only the brace after it.
const fixedBody = () => body().replace('return [quotient', 'const checked = true;\n  return [quotient');
const fixedGood = () => `${fixedBody()}\n${trailer()}\n`;
const answer = (call, value) => ({ result: value, requestedModel: 'test-double', observedModel: null, tokens: null, aiCredits: null });
const content = (call, text) => answer(call, result(call.role, call.unit, { content: text }));
const roles = calls => calls.map(c => c.role.startsWith('reviewer-') ? 'reviewer' : c.role);
const summary = (f, report) => readJSON(safePath(f.root, `migration/runs/${report.runId}/summary.json`));
async function setup(t, { single = true, typecheck = null, executionMode } = {}) {
  const f = prepare(t, executionMode ? { executionMode } : {});
  f.config.markerPolicy = 'todo-lines-v1';
  if (single) f.config.fixPolicy = 'single-pass';
  f.config.commands.typecheck = typecheck;
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Trailer rewrite fixture only');
  return f;
}
// reviewer-rules raises F1 on its first call only; the fixer answers fix(n), n from 1.
const firstReview = fix => {
  const calls = [], stages = [];
  const adapter = async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, good());
    if (call.role === 'reviewer-rules' && calls.filter(c => c.role === 'reviewer-rules').length === 1) return answer(call, result(call.role, call.unit, { findings: [finding] }));
    if (call.role === 'fixer') return content(call, fix(calls.filter(c => c.role === 'fixer').length, call));
    return fake(call);
  };
  return { calls, stages, adapter, onProgress: e => stages.push(e.stage) };
};

test('an answer whose trailer is wrong only in its form or place is written rewritten, with no call; the reviews see the rewritten file', async t => {
  const f = await setup(t);
  const calls = [], stages = [];
  const report = await translate(f.root, f.config, async call => { calls.push(call); return call.role === 'implementer' ? content(call, above(body()).replace('confidence=high', 'Confidence=High')) : fake(call); }, { onProgress: e => stages.push(e.stage) });
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['implementer', 'reviewer', 'reviewer']);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), good());
  for (const review of calls.slice(1)) assert.equal(JSON.parse(review.reviewInput).markerEvidence.valid, true);
  assert.ok(stages.includes('trailer rewritten by the runner'), stages.join(' | '));
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 0, markerFixes: 0, markerRewrites: 1 });
  const state = unitState(f.root, f.units[0]);
  // The implementer's record keeps what it answered.
  assert.match(readJSON(safePath(f.root, state.implementation)).result.content, /Confidence=High/);
  assert.equal(done(f.root, f.units[0], inputContext(f.root, f.config)), true);
});

test('without the marker policy the runner never touches a trailer', async t => {
  const f = prepare(t);
  f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Trailer rewrite fixture only');
  const written = above(body());
  const report = await translate(f.root, f.config, async call => call.role === 'implementer' ? content(call, written) : fake(call));
  assert.equal(report.done, 1);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), written);
  assert.equal(report.selfRepairs, undefined);
});

test('a single-pass fix whose trailer is wrong only in its form or place is rewritten; the receipt notes it and still binds the fix', async t => {
  const f = await setup(t);
  const { calls, adapter } = firstReview(() => above(fixedBody()));
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(roles(calls), ['implementer', 'reviewer', 'reviewer', 'arbiter', 'fixer']);
  const out = safePath(f.root, f.units[0].target), state = unitState(f.root, f.units[0]);
  assert.equal(fs.readFileSync(out, 'utf8'), fixedGood());
  assert.equal(state.singlePass.trailerFixedBy, 'runner');
  assert.equal(readJSON(safePath(f.root, state.singlePass.fix.path)).result.content, above(fixedBody()));
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 0, markerFixes: 0, markerRewrites: 1 });
  const context = () => inputContext(f.root, f.config);
  assert.equal(done(f.root, f.units[0], context()), true);
  // The receipt binds the fix's code: another change, recorded as if the
  // runner wrote it, does not finish; nor does the change without its note.
  fs.writeFileSync(out, fixedGood().replace('const checked = true;', 'const checked = false;'));
  writeJSON(statePath(f.root, f.units[0]), { ...state, outputHash: fileHash(out), markerEvidence: markerEvidence(policy, fs.readFileSync(out, 'utf8'), f.units[0].target) });
  assert.equal(done(f.root, f.units[0], context()), false);
  fs.writeFileSync(out, fixedGood());
  const { trailerFixedBy, ...pass } = state.singlePass;
  writeJSON(statePath(f.root, f.units[0]), { ...state, singlePass: pass });
  assert.equal(done(f.root, f.units[0], context()), false);
  writeJSON(statePath(f.root, f.units[0]), state);
  assert.equal(done(f.root, f.units[0], context()), true);
});

test('after a single-pass fix, a fix of the trailer alone keeps its reviews', async t => {
  const f = await setup(t);
  // The fix keeps a wrong count, also when asked again; the trailer fix corrects only the count.
  const { calls, stages, adapter, onProgress } = firstReview(n => n <= 2 ? `${fixedBody()}\n${trailer(1)}\n` : fixedGood());
  const report = await translate(f.root, f.config, adapter, { onProgress });
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(roles(calls), ['implementer', 'reviewer', 'reviewer', 'arbiter', 'fixer', 'fixer', 'fixer']);
  assert.equal(calls.filter(c => c.role === 'fixer')[2].extra.confirmedFindings[0].reference, 'marker:M1');
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.singlePass.trailerFixedBy, 'fixer');
  assert.equal(state.reviewEvidence.length, 2);
  assert.deepEqual(state.singlePass.confirmed, ['reviewer-rules:F1']);
  assert.equal(readJSON(safePath(f.root, state.singlePass.fix.path)).result.content, `${fixedBody()}\n${trailer(1)}\n`);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), fixedGood());
  assert.ok(stages.includes('trailer fixed alone; the single-pass reviews stand'), stages.join(' | '));
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 1, markerFixes: 1, reviewsKept: 1 });
  assert.equal(done(f.root, f.units[0], inputContext(f.root, f.config)), true);
});

test('a fix of marker:M1 after a single-pass fix that changes more than the trailer is reviewed as before', async t => {
  for (const [name, fix] of [
    ['a TODO(port) line added for the count', () => `${fixedBody()}\n// TODO(port): reviewer-rules:F1: confirm the rounding\n${trailer(1)}\n`],
    ['code changed too', () => `${fixedBody()}\nexport const extra = 1;\n${trailer()}\n`],
    ['the single-pass fix undone', () => good()]]) {
    const f = await setup(t);
    const { calls, adapter } = firstReview(n => n <= 2 ? `${fixedBody()}\n${trailer(1)}\n` : fix());
    const report = await translate(f.root, f.config, adapter);
    assert.equal(report.done, 1, name); assert.deepEqual(report.errors, [], name);
    assert.deepEqual(roles(calls), ['implementer', 'reviewer', 'reviewer', 'arbiter', 'fixer', 'fixer', 'fixer', 'reviewer', 'reviewer'], name);
    const state = unitState(f.root, f.units[0]);
    assert.equal(state.singlePass, undefined, name);
    assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), fix(), name);
    assert.equal(summary(f, report).selfRepairs.reviewsKept, undefined, name);
    assert.equal(done(f.root, f.units[0], inputContext(f.root, f.config)), true, name);
  }
});

test('a run stopped before the trailer fix after a single-pass fix resumes at the fix, with the reviews kept', async t => {
  const f = await setup(t);
  const first = firstReview(() => `${fixedBody()}\n${trailer(1)}\n`);
  // Six calls: implementer, two reviewers, arbiter, the fix and its correction.
  const stopped = await translate(f.root, f.config, first.adapter, { maxCalls: 6 }).catch(e => e);
  assert.match(stopped.message, /Agent call limit reached/);
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.stage, 'fix'); assert.equal(state.confirmed[0].reference, 'marker:M1');
  assert.equal(state.reviewEvidence.length, 2); assert.ok(state.singlePass.fix.path);
  const calls = [];
  const report = await translate(f.root, f.config, async call => { calls.push(call); return call.role === 'fixer' ? content(call, fixedGood()) : fake(call); });
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['fixer']);
  assert.equal(unitState(f.root, f.units[0]).singlePass.trailerFixedBy, 'fixer');
  assert.equal(done(f.root, f.units[0], inputContext(f.root, f.config)), true);
});

test('with fixPolicy rereview a trailer fix is reviewed as before', async t => {
  const f = await setup(t, { single: false });
  const { calls, adapter } = firstReview(n => n <= 2 ? `${fixedBody()}\n${trailer(1)}\n` : fixedGood());
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['implementer', 'reviewer', 'reviewer', 'arbiter', 'fixer', 'fixer', 'fixer', 'reviewer', 'reviewer']);
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 1, markerFixes: 1 });
});

test('a target that is not UTF-8 is never rewritten: its trailer goes to the fixer', async t => {
  const f = await setup(t);
  const out = safePath(f.root, f.units[0].target);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Latin-1 bytes (café): the runner would have to re-encode the file.
  const latin = Buffer.from(above(body().replace('export function', '// café\nexport function')), 'latin1');
  fs.writeFileSync(out, latin);
  const calls = [];
  const report = await translate(f.root, f.config, async call => { calls.push(call); return call.role === 'fixer' ? content(call, good()) : fake(call); });
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['fixer', 'reviewer', 'reviewer']);
  assert.equal(calls[0].extra.confirmedFindings[0].reference, 'marker:M1');
  assert.equal(summary(f, report).selfRepairs.markerRewrites, undefined);
});

test('a unit an earlier kit stopped during a trailer fix, or before completing a single-pass fix, is rewritten on resume with no call', async t => {
  // 0.45.x stopped during a trailer fix: the stage fix, no reviews.
  const f = await setup(t);
  await translate(f.root, f.config, async call => call.role === 'implementer' ? content(call, good()) : fake(call));
  const out = safePath(f.root, f.units[0].target);
  fs.writeFileSync(out, above(body()));
  const { arbitration, singlePass, markerEvidence: recorded, ...state } = unitState(f.root, f.units[0]);
  writeJSON(statePath(f.root, f.units[0]), { ...state, status: 'blocked', stage: 'fix', outputHash: fileHash(out), reviewMap: {}, reviews: [], reviewEvidence: [],
    confirmed: [{ id: 'M1', reference: 'marker:M1', message: 'The PORT STATUS trailer is wrong: an older wording', evidence: 'earlier kit', rule: 'markerPolicy todo-lines-v1' }] });
  const calls = [];
  const report = await translate(f.root, f.config, async call => { calls.push(call); return fake(call); });
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['reviewer', 'reviewer']);
  assert.equal(fs.readFileSync(out, 'utf8'), good());
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 0, markerFixes: 0, markerRewrites: 1 });

  // 0.45.x wrote a single-pass fix with its trailer above the brace and was
  // stopped in verify-fix: completing it rewrites the trailer, keeping the reviews.
  const g = await setup(t, { typecheck: [process.execPath, '--check', '{target}'] });
  const run = firstReview(() => fixedGood());
  assert.equal((await translate(g.root, g.config, run.adapter)).done, 1);
  const gout = safePath(g.root, g.units[0].target), finished = unitState(g.root, g.units[0]);
  const fixRecord = readJSON(safePath(g.root, finished.singlePass.fix.path));
  writeJSON(safePath(g.root, finished.singlePass.fix.path), { ...fixRecord, result: { ...fixRecord.result, content: above(fixedBody()) } });
  fs.writeFileSync(gout, above(fixedBody()));
  writeJSON(statePath(g.root, g.units[0]), { ...finished, status: 'blocked', stage: 'verify-fix', outputHash: fileHash(gout),
    singlePass: { ...finished.singlePass, fix: { path: finished.singlePass.fix.path, hash: fileHash(safePath(g.root, finished.singlePass.fix.path)) } } });
  const resumed = [];
  const again = await translate(g.root, g.config, async call => { resumed.push(call); return fake(call); });
  assert.equal(again.done, 1);
  assert.deepEqual(resumed, []);
  assert.equal(fs.readFileSync(gout, 'utf8'), fixedGood());
  const after = unitState(g.root, g.units[0]);
  assert.equal(after.singlePass.trailerFixedBy, 'runner'); assert.equal(after.typecheck.code, 0);
  assert.equal(hash(fs.readFileSync(gout)), after.outputHash);
  assert.equal(done(g.root, g.units[0], inputContext(g.root, g.config)), true);
});

test('a trailer the fixer leaves wrong after a single-pass fix keeps the reviews but is not counted; blocked after two fixes, the next run starts at the fix', async t => {
  const f = await setup(t);
  const first = firstReview(() => `${fixedBody()}\n${trailer(1)}\n`);
  const error = await translate(f.root, f.config, first.adapter, { onProgress: first.onProgress }).catch(e => e);
  const { report } = error;
  assert.equal(report.done, 0);
  assert.match(report.errors[0].error, /PORT STATUS count mismatch/);
  assert.deepEqual(roles(first.calls), ['implementer', 'reviewer', 'reviewer', 'arbiter', 'fixer', 'fixer', 'fixer', 'fixer', 'fixer', 'fixer']);
  assert.ok(!first.stages.includes('trailer fixed alone; the single-pass reviews stand'), first.stages.join(' | '));
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 3, markerFixes: 2 });
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.stage, 'fix'); assert.equal(state.confirmed[0].reference, 'marker:M1');
  assert.equal(state.reviewEvidence.length, 2); assert.ok(state.singlePass.fix.path);
  const calls = [];
  const again = await translate(f.root, f.config, async call => { calls.push(call); return call.role === 'fixer' ? content(call, fixedGood()) : fake(call); });
  assert.equal(again.done, 1);
  assert.deepEqual(roles(calls), ['fixer']);
  assert.deepEqual(summary(f, again).selfRepairs, { corrections: 0, markerFixes: 0, reviewsKept: 1 });
  assert.equal(unitState(f.root, f.units[0]).singlePass.trailerFixedBy, 'fixer');
  assert.equal(done(f.root, f.units[0], inputContext(f.root, f.config)), true);
});

test('after fixPolicy changes to rereview, a trailer fix after a single-pass fix is reviewed', async t => {
  const f = await setup(t);
  const first = firstReview(() => `${fixedBody()}\n${trailer(1)}\n`);
  await translate(f.root, f.config, first.adapter, { maxCalls: 6 }).catch(e => e);
  assert.equal(unitState(f.root, f.units[0]).stage, 'fix');
  f.config.fixPolicy = 'rereview';
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  const calls = [];
  const report = await translate(f.root, f.config, async call => { calls.push(call); return call.role === 'fixer' ? content(call, fixedGood()) : fake(call); });
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['fixer', 'reviewer', 'reviewer']);
  assert.equal(unitState(f.root, f.units[0]).singlePass, undefined);
  assert.equal(done(f.root, f.units[0], inputContext(f.root, f.config)), true);
});
