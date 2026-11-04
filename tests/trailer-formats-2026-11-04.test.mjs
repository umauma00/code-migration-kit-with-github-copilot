// SPDX-License-Identifier: Apache-2.0
// 2026-11-04: a Windows run (phase 04, 98 of 554 units) sent Database.xml back
// to the fixer on every run. XML has no line comment, and the trailer had to
// end with its count, so `<!-- PORT STATUS: confidence=medium todos=2 -->`
// failed and only a file that was no longer XML (a bare line, an unclosed
// comment) could pass. Each run spent up to four fixer calls rewriting the
// whole file, then left it unfinished. A trailer may now end with the closer
// of a comment that ends on its line, a trailer line that opens a comment
// closes it there, and a JSON file carries none. A finished unit keeps its
// receipt: a trailer that passed before records exactly the same fields, and
// one the new rules refuse (a comment left open, a trailer in JSON) still
// holds for the content it was recorded with.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake, result, mini } from './helpers.mjs';
import { safePath, writeJSON, atomicWrite, readManifest, readJSON, unitState, statePath, fileHash, inputContext, done } from '../lib/core.mjs';
import { translate, approve, runStage, withoutFlags } from '../lib/pipeline.mjs';
import { reviewEvidence } from '../lib/review.mjs';
import { markerEvidence, finishedMarkerEvidence, markerError, trailerClosers, carriesNoTrailer, commentlessExtensions } from '../lib/markers.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';

const policy = { markerPolicy: 'todo-lines-v1' };
const file = (...lines) => lines.join('\n') + '\n';
const fields = ['policy', 'candidateHash', 'countingMethod', 'actual', 'claimed', 'valid'];

// The check of 0.45.0, kept here as it was: what finished units recorded.
const before = content => {
  const lines = content.split(/\r?\n/);
  const actual = lines.filter(line => line.includes('TODO(port)')).length;
  const trailers = lines.filter(line => line.includes('PORT STATUS:'));
  const match = trailers.length === 1 && trailers[0].match(/PORT STATUS:\s*confidence\s*=\s*\[?\s*(high|medium|low)\s*\]?\s+todos\s*=\s*\[?\s*(\d+)\s*\]?\s*$/);
  const claimed = match ? Number(match[2]) : null;
  const last = lines.findLast(line => line.trim());
  const valid = Boolean(match && Number.isSafeInteger(claimed) && last === trailers[0] && actual === claimed);
  return { policy: 'todo-lines-v1', candidateHash: crypto.createHash('sha256').update(content).digest('hex'), countingMethod: 'literal-lines-containing-TODO(port)', actual, claimed, valid };
};
// What unitDone asks of a receipt: valid evidence whose every field it recorded.
const holds = (content, target, recorded) => {
  const evidence = finishedMarkerEvidence(policy, content, target, recorded);
  return evidence.valid && Object.entries(evidence).every(([key, value]) => recorded?.[key] === value);
};

test('every trailer that passed before keeps its receipt; a new answer records the same fields unless it leaves a comment open or is JSON', () => {
  const bodies = [['class A {', '}'], ['class A {', '  // TODO(port): one', '  // TODO(port): two', '}'], ['{', '  "a": "TODO(port): x"', '}'], ['<root>', '  <!-- TODO(port): y -->', '</root>']];
  const trailers = n => [`// PORT STATUS: confidence=medium todos=${n}`, `# PORT STATUS: confidence=low todos=[${n}]`, `-- PORT STATUS: confidence=high todos=${n}  `,
    `PORT STATUS: confidence = [ medium ] todos = [ ${n} ]`, `<!-- PORT STATUS: confidence=medium todos=${n}`, `' PORT STATUS: confidence=low todos=${n}`];
  let compared = 0;
  for (const body of bodies) {
    const n = body.filter(line => line.includes('TODO(port)')).length, line = body.length + 1;
    for (const trailer of trailers(n)) for (const eol of ['\n', '\r\n']) for (const blank of ['', eol, `${eol}  ${eol}`]) {
      const content = [...body, trailer].join(eol) + eol + blank;
      const old = before(content);
      assert.equal(old.valid, true, JSON.stringify(content));
      for (const target of ['ported/A.java', 'ported/conf.json', 'ported/Database.xml', 'ported/page.jsp', undefined]) {
        const at = `${target}: ${JSON.stringify(content)}`;
        // A finished unit's receipt holds, whatever the target.
        assert.deepEqual(finishedMarkerEvidence(policy, content, target, old), old, at);
        assert.equal(holds(content, target, old), true, at);
        // A new answer records the same fields, except in JSON, which takes no
        // trailer, and on a line that opens a comment it does not close.
        const fresh = markerEvidence(policy, content, target);
        if (carriesNoTrailer(target)) assert.deepEqual(fresh, { ...old, valid: false, noTrailer: true, problem: `this format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line ${line})` }, at);
        else if (trailer.startsWith('<!--')) assert.deepEqual(fresh, { ...old, valid: false, problem: `the PORT STATUS line (line ${line}) opens a comment with "<!--" that does not end on that line: end the line with "-->"` }, at);
        else assert.deepEqual(fresh, old, at);
        compared++;
      }
    }
  }
  assert.equal(compared, 4 * 6 * 2 * 3 * 5);
});

test('formats without a line comment end the trailer with the closer of their comment', () => {
  const forms = {
    'ported/Database.xml': ['<?xml version="1.0" encoding="UTF-8"?>', '<sqlMap namespace="Area">', '  <!-- TODO(port): the cache size -->', '</sqlMap>', '<!-- PORT STATUS: confidence=medium todos=1 -->'],
    'ported/index.html': ['<html>', '</html>', '<!--PORT STATUS: confidence=high todos=0-->'],
    'ported/area.jsp': ['<%@ page contentType="text/html" %>', '<%-- TODO(port): the session scope --%>', '<%-- PORT STATUS: confidence=low todos=1 --%>'],
    'ported/site.css': ['a { color: red; }', '/* PORT STATUS: confidence=high todos=0 */'],
    'ported/doc.css': ['a { color: red; }', '/** PORT STATUS: confidence=high todos=0 */'],
    'ported/Area.cshtml': ['<p>@Model.Name</p>', '@* PORT STATUS: confidence=medium todos=0 *@'],
    'ported/area.html.j2': ['<p>{{ name }}</p>', '{# PORT STATUS: confidence=medium todos=0 #}'],
    'ported/area.html.erb': ['<p><%= name %></p>', '<%# PORT STATUS: confidence=medium todos=0 %>'],
    'ported/area.ml': ['let area = 1', '(* PORT STATUS: confidence=medium todos=0 *)'],
    // A comment opened on a line above and closed on the trailer's line.
    'ported/Split.xml': ['<root/>', '<!--', '  PORT STATUS: confidence=medium todos=[0] -->'],
    'ported/split.css': ['a { color: red; }', '/*', ' * PORT STATUS: confidence=medium todos=0 */'],
    // A line comment holding a comment that opens and closes on the line.
    'ported/a.js': ['export const a = 1;', '// <!-- PORT STATUS: confidence=medium todos=0 -->']
  };
  for (const [target, lines] of Object.entries(forms)) {
    for (const eol of ['\n', '\r\n']) {
      const evidence = markerEvidence(policy, lines.join(eol) + eol, target);
      assert.equal(evidence.valid, true, `${target}: ${evidence.problem}`);
      assert.deepEqual(Object.keys(evidence), fields, target);
    }
  }
  assert.deepEqual(trailerClosers, ['-->', '--%>', '%>', '*/', '*@', '#}', '*)']);
  for (const closer of trailerClosers) assert.equal(markerEvidence(policy, file('x', `PORT STATUS: confidence=low todos=0 ${closer}`), 'a.txt').valid, true, closer);
});

test('a trailer line that opens a comment closes it on that line; a finished unit that left it open keeps its receipt', () => {
  const comments = [['<!--', '-->'], ['<%--', '--%>'], ['<%#', '%>'], ['/*', '*/'], ['/**', '*/'], ['@*', '*@'], ['{#', '#}'], ['(*', '*)'], ['(**', '*)']];
  for (const [open, close] of comments) {
    const left = file('x', `${open} PORT STATUS: confidence=low todos=0`);
    const evidence = markerEvidence(policy, left, 'ported/a.txt');
    assert.equal(evidence.valid, false, open);
    assert.equal(evidence.problem, `the PORT STATUS line (line 2) opens a comment with "${open}" that does not end on that line: end the line with "${close}"`, open);
    // A unit 0.45.0 finished with it stays finished: its receipt holds.
    assert.equal(holds(left, 'ported/a.txt', before(left)), true, open);
    // Closed by its own closer it passes; by another comment's closer it does not.
    assert.equal(markerEvidence(policy, file('x', `${open} PORT STATUS: confidence=low todos=0 ${close}`), 'ported/a.txt').valid, true, open);
    for (const other of trailerClosers.filter(c => c !== close && !c.endsWith(close)))
      assert.match(markerEvidence(policy, file('x', `${open} PORT STATUS: confidence=low todos=0 ${other}`), 'ported/a.txt').problem, new RegExp(`end the line with "${close.replace(/[*()]/g, '\\$&')}"$`), `${open} ${other}`);
    // A closer that ends with its own closes it: ERB reads <%# ... --%> as closed at %>.
    for (const other of trailerClosers.filter(c => c !== close && c.endsWith(close)))
      assert.equal(markerEvidence(policy, file('x', `${open} PORT STATUS: confidence=low todos=0 ${other}`), 'ported/a.txt').valid, true, `${open} ${other}`);
  }
  assert.equal(markerEvidence(policy, file('<p><%= name %></p>', '<%# PORT STATUS: confidence=low todos=0 --%>'), 'ported/a.html.erb').valid, true);
  for (const line of ['<%-- PORT STATUS: confidence=low todos=0 %>', '<!-- PORT STATUS: confidence=low todos=0 --%>'])
    assert.equal(markerEvidence(policy, file('<p/>', line), 'ported/a.jsp').valid, false, line);
  // With other problems, each is named.
  assert.equal(markerEvidence(policy, file('<r>', '<!-- PORT STATUS: confidence=low todos=3', '</r>'), 'a.xml').problem,
    'the PORT STATUS line (line 2) opens a comment with "<!--" that does not end on that line: end the line with "-->"; the PORT STATUS line is line 2, but line 3 "</r>" follows it: move the trailer below it, after the final closing brace or tag, so it is the last nonempty line; it says todos=3 but 0 lines contain TODO(port): make the number 0, or change the TODO(port) lines');
  assert.equal(markerError(markerEvidence(policy, file('<r/>', '<!-- PORT STATUS: confidence=low todos=0'), 'a.xml')),
    'PORT STATUS count mismatch or invalid trailer: TODO(port) lines=0, claimed=0. The PORT STATUS line (line 2) opens a comment with "<!--" that does not end on that line: end the line with "-->". Return one final confidence/todos trailer matching the agreed marker policy.');
  // A receipt holds only for the content it was recorded with.
  const left = file('<r/>', '<!-- PORT STATUS: confidence=low todos=0');
  assert.equal(holds(file('<r/>', '<!-- PORT STATUS: confidence=high todos=0'), 'a.xml', before(left)), false);
  assert.equal(holds(left, 'a.xml', { ...before(left), valid: false }), false);
  assert.equal(holds(left, 'a.xml', undefined), false);
});

test('a brace, bracket or parenthesis after the count still fails: the trailer would sit inside code', () => {
  for (const tail of ['}', ')', '};', ');', '}}', '-- >', '*/ }', '--> x', '%']) {
    const evidence = markerEvidence(policy, file('class A {', `// PORT STATUS: confidence=low todos=0 ${tail}`), 'ported/A.java');
    assert.equal(evidence.valid, false, tail);
    assert.match(evidence.problem, /does not read "PORT STATUS: confidence=high\|medium\|low todos=<number>", with nothing after the number but the closer of a comment that ends on that line \("-->", "--%>", "%>", "\*\/", "\*@", "#\}", "\*\)"\)/, tail);
  }
  // Still exactly one trailer, on the last nonempty line, with the right count.
  assert.equal(markerEvidence(policy, file('<r>', '<!-- PORT STATUS: confidence=low todos=0 -->', '</r>'), 'a.xml').valid, false);
  assert.equal(markerEvidence(policy, file('<r>', '<!-- TODO(port): x -->', '</r>', '<!-- PORT STATUS: confidence=low todos=0 -->'), 'a.xml').valid, false);
  assert.match(markerEvidence(policy, file('<r/>', '<!-- PORT STATUS: confidence=low todos=0 -->', '<!-- PORT STATUS: confidence=low todos=0 -->'), 'a.xml').problem, /2 lines contain PORT STATUS/);
});

test('a comment closed on the line below the trailer is told to close on the trailer line', () => {
  const evidence = markerEvidence(policy, file('<root/>', '<!--', '  PORT STATUS: confidence=medium todos=0', '-->'), 'ported/Database.xml');
  assert.equal(evidence.valid, false);
  assert.equal(evidence.problem, 'the PORT STATUS line is line 3, but line 4 "-->" closes its comment below it: end the PORT STATUS line itself with "-->" and remove line 4, so the trailer is the last nonempty line');
  // Anything else after the trailer is moved below as before, braces or tags.
  assert.match(markerEvidence(policy, file('<root>', '<!-- PORT STATUS: confidence=medium todos=0 -->', '</root>'), 'a.xml').problem,
    /line 3 "<\/root>" follows it: move the trailer below it, after the final closing brace or tag, so it is the last nonempty line$/);
});

test('a JSON file carries no trailer: a new answer with one is told to remove it, a finished unit keeps its receipt', () => {
  const json = file('{', '  "name": "area",', '  "size": 2', '}');
  const none = markerEvidence(policy, json, 'ported/conf/app.json');
  assert.deepEqual({ ...none, candidateHash: null }, { policy: 'todo-lines-v1', candidateHash: null, countingMethod: 'literal-lines-containing-TODO(port)', actual: 0, claimed: null, valid: true, noTrailer: true });
  const listed = commentlessExtensions.split(/, | or /);
  assert.equal(listed.length, 11);
  for (const target of [...listed.map(ext => `ported/a${ext}`), 'a.JSON', 'App.Json', 'a.GeoJSON']) assert.equal(carriesNoTrailer(target), true, target);
  for (const target of ['a.json5', 'a.jsonc', 'a.json.txt', 'a.glb', 'a.xml', 'A.java', 'json', 'a.json/x.js', undefined, null]) assert.equal(carriesNoTrailer(target), false, String(target));
  // Other formats still need one.
  for (const target of ['ported/A.java', 'ported/a.xml', 'ported/a.json5', undefined]) {
    const missing = markerEvidence(policy, json, target);
    assert.equal(missing.valid, false, String(target));
    assert.equal(missing.noTrailer, undefined, String(target));
    assert.match(missing.problem, /^There is no PORT STATUS line: add one as the last nonempty line, in the file's line-comment syntax, such as "\/\/ PORT STATUS: confidence=medium todos=0" \(0 lines contain TODO\(port\)\); a format without line comments ends that line with the closer of its comment, such as "<!-- PORT STATUS: confidence=medium todos=0 -->"$/);
  }
  // Any trailer breaks JSON: it is a problem there, and the error says to remove it.
  for (const trailer of ['<!-- PORT STATUS: confidence=low todos=0 -->', '// PORT STATUS: confidence=low todos=0', 'PORT STATUS: confidence=low todos=0']) {
    const evidence = markerEvidence(policy, `${json}${trailer}\n`, 'ported/conf/app.json');
    assert.equal(evidence.valid, false, trailer); assert.equal(evidence.noTrailer, true, trailer);
    assert.equal(evidence.problem, 'this format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 5)', trailer);
    assert.equal(markerError(evidence), 'PORT STATUS count mismatch or invalid trailer: TODO(port) lines=0, claimed=0. This format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 5).', trailer);
  }
  assert.equal(markerError(markerEvidence(policy, `${json}// PORT STATUS: done\n`, 'a.json')), 'PORT STATUS count mismatch or invalid trailer: TODO(port) lines=0, claimed=missing. This format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 5).');
  assert.match(markerEvidence(policy, `${json}// PORT STATUS: confidence=low todos=0\n// PORT STATUS: confidence=low todos=0\n`, 'a.json').problem, /remove the PORT STATUS trailer \(lines 5, 6\)$/);
  // A receipt of 0.45.0 or earlier holds for the content it was recorded with.
  const legacy = `${json}// PORT STATUS: confidence=low todos=0\n`;
  const recorded = before(legacy);
  assert.deepEqual(finishedMarkerEvidence(policy, legacy, 'a.json', recorded), recorded);
  assert.equal(holds(legacy, 'a.json', recorded), true);
  // No other receipt does: an invalid one, none, one of other content, or one no earlier kit could record.
  for (const other of [{ ...recorded, valid: false }, null, undefined, 'valid']) {
    assert.equal(finishedMarkerEvidence(policy, legacy, 'a.json', other).valid, false, JSON.stringify(other));
    assert.equal(holds(legacy, 'a.json', other), false, JSON.stringify(other));
  }
  assert.equal(holds(legacy, 'a.json', { ...recorded, candidateHash: before(json).candidateHash }), false);
  const closed = `${json}<!-- PORT STATUS: confidence=low todos=0 -->\n`;
  assert.equal(holds(closed, 'a.json', { ...before(closed), valid: true }), false);
  // A valid answer is its own receipt, as for any target.
  for (const target of ['A.java', 'a.xml']) assert.deepEqual(finishedMarkerEvidence(policy, legacy, target, recorded), markerEvidence(policy, legacy, target), target);
  assert.deepEqual(finishedMarkerEvidence(policy, json, 'a.json', recorded), markerEvidence(policy, json, 'a.json'));
  assert.equal(finishedMarkerEvidence({}, legacy, 'a.json', recorded), null);
  // Elsewhere the error keeps its words.
  assert.equal(markerError(markerEvidence(policy, file('class A {', '}', '// PORT STATUS: confidence=low todos=3'), 'A.java')),
    'PORT STATUS count mismatch or invalid trailer: TODO(port) lines=0, claimed=3. It says todos=3 but 0 lines contain TODO(port): make the number 0, or change the TODO(port) lines. Return one final confidence/todos trailer matching the agreed marker policy.');
});

test('the kit\'s flags in these comments are flags: a fix that changed only them changed nothing else', () => {
  const pairs = [
    ['<%-- TODO(port): the session scope --%>\n<p/>\n<%-- PORT STATUS: confidence=low todos=1 --%>', '<p/>'],
    ['<%# TODO(port): x %>\n<p/>\n<%# PORT STATUS: confidence=low todos=1 %>', '<p/>'],
    ['@* TODO(port): x *@\n<p/>\n@* PORT STATUS: confidence=low todos=1 *@', '<p/>'],
    ['{# TODO(port): x #}\n<p/>\n{# PORT STATUS: confidence=low todos=1 #}', '<p/>'],
    ['(* TODO(port): x *)\nlet a = 1\n(* PORT STATUS: confidence=low todos=1 *)', 'let a = 1'],
    ['<p>a</p> <%-- TODO(port): x --%> <b/>', '<p>a</p> <b/>'],
    ['<p>{# TODO(port): x #}</p>', '<p></p>'],
    ['  {# TODO(port): x', ''],
    ['<!-- TODO(port): x -->\n<r/>\n<!-- PORT STATUS: confidence=low todos=1 -->', '<r/>']
  ];
  for (const [text, stripped] of pairs) assert.equal(withoutFlags(text), stripped, text);
  // Inside quotes or after other code they stay text, as before. { followed
  // by # is code in Python or Ruby (a dict or hash, then a line comment)
  // unless it starts the line or #} closes it on the line.
  for (const text of ['s = "<%-- TODO(port): x --%>"', "s = '{# TODO(port): x #}'", 'f(** TODO(port): x *)', 'config = {# TODO(port): add keys', 'h = {#TODO(port): x'])
    assert.equal(withoutFlags(text), text, text);
});

test('writing roles are told the forms; reviewers and the arbiter are told they are not defects', () => {
  const unit = { source: 'src/Database.xml', target: 'ported/Database.xml', id: 'x' };
  const json = 'a JSON file (.json, .jsonl, .ndjson, .geojson, .topojson, .jsonld, .webmanifest, .ipynb, .har, .sarif or .gltf), which has no comments';
  for (const role of ['implementer', 'fixer']) {
    const extra = role === 'fixer' ? { confirmedFindings: [] } : {};
    const prompt = agentPrompt({ role, unit, extra, markerPolicy: 'todo-lines-v1' });
    assert.ok(prompt.includes(` Unless the target is ${json} and carries no trailer, the LAST nonempty line of content is exactly one status trailer in the target's line-comment syntax, after the final closing brace (never inside a class or function), for example \`// PORT STATUS: confidence=medium todos=2\``), role);
    assert.ok(prompt.includes(' A format without line comments puts the trailer in one comment that opens and ends on that last line, after everything else: `<!-- PORT STATUS: confidence=medium todos=2 -->` in XML or HTML (after the closing root tag, also in an HTML template such as Handlebars), `<%-- PORT STATUS: confidence=medium todos=2 --%>` in JSP, `/* PORT STATUS: confidence=medium todos=2 */` in CSS; only these closers end it: --> --%> %> */ *@ #} *).'), role);
    assert.doesNotMatch(agentPrompt({ role, unit, extra }), /PORT STATUS/, role);
  }
  for (const role of ['reviewer-rules', 'reviewer-semantics']) {
    const prompt = agentPrompt({ role, unit, reviewInput: '{}', markerPolicy: 'todo-lines-v1' });
    assert.ok(prompt.includes(`In a format without line comments the PORT STATUS trailer is one comment that ends on the last line, such as \`<!-- PORT STATUS: confidence=medium todos=2 -->\` in XML or HTML, and ${json}, carries none: report neither form as a defect (markerEvidence in the input is the coordinator's own count).`), role);
    assert.doesNotMatch(agentPrompt({ role, unit, reviewInput: '{}' }), /one comment that ends on the last line/, role);
  }
  const arbiter = agentPrompt({ role: 'arbiter', unit, extra: { references: ['reviewer-rules:F1'] }, markerPolicy: 'todo-lines-v1' });
  assert.ok(arbiter.includes(`and ${json}, carries none: do not confirm a finding against either form.`));
  assert.doesNotMatch(agentPrompt({ role: 'arbiter', unit, extra: { references: [] } }), /one comment that ends on the last line/);
  for (const role of ['surveyor', 'preparation-auditor']) assert.doesNotMatch(agentPrompt({ role, unit, frozenInput: '{}', markerPolicy: 'todo-lines-v1' }), /one comment that ends on the last line/, role);
});

test('both RULEBOOK templates show the same comment forms and say a JSON file carries none', () => {
  const template = name => fs.readFileSync(path.join(import.meta.dirname, '..', 'templates', name), 'utf8');
  const en = template('RULEBOOK.md'), ja = template('RULEBOOK.ja.md');
  for (const literal of ['// PORT STATUS: confidence=medium todos=2', '`<!-- PORT STATUS: confidence=medium todos=2 -->`',
    '`<%-- PORT STATUS: confidence=medium todos=2 --%>`', '`/* PORT STATUS: confidence=medium todos=2 */`'])
    assert.ok(en.includes(literal) && ja.includes(literal), literal);
  // Each form passes the coordinator's check as the template shows it.
  for (const [target, trailer] of [['a.xml', '<!-- PORT STATUS: confidence=medium todos=2 -->'], ['a.jsp', '<%-- PORT STATUS: confidence=medium todos=2 --%>'], ['a.css', '/* PORT STATUS: confidence=medium todos=2 */']])
    assert.equal(markerEvidence(policy, file('x', 'TODO(port): a', 'TODO(port): b', trailer), target).valid, true, target);
  assert.match(en, /Every translated file, except a JSON file, ends with a status trailer:/);
  assert.match(en, /one comment that opens and ends on that same\nline/);
  assert.match(en, /A JSON file\n\(`\.json`, `\.jsonl` and the other JSON formats\) has no comments, so it carries\nno trailer\./);
  assert.match(en, /\(a JSON file keeps none\)/);
  assert.match(ja, /翻訳したファイルは（JSON ファイルを除き）、最後に状態の行を付けて終えます。/);
  assert.match(ja, /その行の中で開いて閉じる\n1つのコメント/);
  assert.match(ja, /JSON ファイル\n（`\.json`・`\.jsonl` などの JSON の形式）はコメントを書けないので、この行を付けません。/);
  assert.match(ja, /（JSON ファイルには置きません）/);
});

// A project of three units, Database.xml, a JSON file and the fixture's JS.
async function formats(t) {
  const f = prepare(t, { count: 1, executionMode: 'continuous' });
  f.config.markerPolicy = 'todo-lines-v1'; f.config.fixPolicy = 'single-pass'; f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  atomicWrite(safePath(f.root, 'src/Database.xml'), '<?xml version="1.0"?>\n<sqlMap namespace="Area">\n</sqlMap>\n');
  atomicWrite(safePath(f.root, 'src/app.json'), '{\n  "name": "area"\n}\n');
  atomicWrite(safePath(f.root, 'migration/manifest.tsv'), 'source\ttarget\nsrc/math_ops.py\tported/math_ops.mjs\nsrc/Database.xml\tported/Database.xml\nsrc/app.json\tported/app.json\n');
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: { 'src/math_ops.py': [], 'src/Database.xml': [], 'src/app.json': [] } });
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Trailer formats fixture only');
  const units = readManifest(f.root, f.config);
  const [js, xml, json] = ['ported/math_ops.mjs', 'ported/Database.xml', 'ported/app.json'].map(target => units.find(u => u.target === target));
  return { ...f, units, js, xml, json };
}
const written = {
  'ported/math_ops.mjs': () => `${fs.readFileSync(path.join(mini, 'expected/math_ops.mjs'), 'utf8').replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd()}\n// PORT STATUS: confidence=high todos=0\n`,
  'ported/Database.xml': () => '<?xml version="1.0"?>\n<sqlMap namespace="Area">\n</sqlMap>\n<!-- PORT STATUS: confidence=high todos=0 -->\n',
  'ported/app.json': () => '{\n  "name": "area"\n}\n'
};
const answer = (call, value) => ({ result: value, requestedModel: 'test-double', observedModel: null, tokens: null, aiCredits: null });
const writes = call => answer(call, result(call.role, call.unit, { content: written[call.unit.target]() }));
const finish = f => translate(f.root, f.config, async call => call.role === 'implementer' ? writes(call) : fake(call));
const removeIt = 'The PORT STATUS trailer is wrong: this format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 4)';

test('Database.xml and a JSON file finish on their first answer, and stay finished', async t => {
  const f = await formats(t);
  const calls = [], inputs = {};
  const report = await translate(f.root, f.config, async call => {
    calls.push(`${call.role} ${call.unit.target}`);
    if (call.role.startsWith('reviewer-')) inputs[call.unit.target] = JSON.parse(call.reviewInput);
    if (call.role === 'implementer' || call.role === 'fixer') return writes(call);
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  // Nothing was asked again or sent back for its trailer.
  assert.equal(report.selfRepairs, undefined);
  assert.deepEqual(calls.filter(c => c.startsWith('fixer')), []);
  assert.equal(calls.filter(c => c.startsWith('implementer')).length, 3);
  const context = inputContext(f.root, f.config);
  for (const unit of f.units) assert.equal(done(f.root, unit, context), true, unit.target);
  assert.equal(unitState(f.root, f.json).markerEvidence.noTrailer, true);
  assert.equal(unitState(f.root, f.xml).markerEvidence.valid, true);
  // The reviewers were given the coordinator's count as valid.
  assert.deepEqual([inputs['ported/Database.xml'].markerEvidence.valid, inputs['ported/app.json'].markerEvidence.valid, inputs['ported/app.json'].markerEvidence.noTrailer], [true, true, true]);
  // Tool-assisted review evidence (a file too large to inline) carries the same.
  const large = `{\n  "name": "area",\n  "notes": "${'x'.repeat(3000)}"\n}\n`;
  atomicWrite(safePath(f.root, f.json.target), large);
  const assisted = reviewEvidence(f.root, { ...f.config, maxReviewInputBytes: 2000 }, f.json);
  assert.equal(assisted.mode, 'tool-assisted');
  assert.deepEqual(JSON.parse(assisted.text).markerEvidence, { ...markerEvidence(policy, large, f.json.target), valid: true, noTrailer: true });
  // A trailer that would break the JSON file is sent back to be removed.
  atomicWrite(safePath(f.root, 'ported/app.json'), '{\n  "name": "area"\n}\n<!-- PORT STATUS: confidence=high todos=0 -->\n');
  assert.equal(done(f.root, f.json, inputContext(f.root, f.config)), false);
});

test('a JSON file finished with a trailer by an earlier kit stays finished; removing it by hand reviews it once', async t => {
  const f = await formats(t);
  await finish(f);
  // What 0.45.0 recorded for a JSON file it finished: the trailer it asked for.
  const legacy = '{\n  "name": "area"\n}\n// PORT STATUS: confidence=high todos=0\n';
  atomicWrite(safePath(f.root, f.json.target), legacy);
  const state = unitState(f.root, f.json);
  writeJSON(statePath(f.root, f.json), { ...state, outputHash: fileHash(safePath(f.root, f.json.target)), markerEvidence: before(legacy) });
  assert.equal(done(f.root, f.json, inputContext(f.root, f.config)), true);
  const calls = [];
  const adapter = async call => { calls.push(`${call.role} ${call.unit.target}`); return call.role === 'implementer' || call.role === 'fixer' ? writes(call) : fake(call); };
  assert.equal((await translate(f.root, f.config, adapter)).done, 3);
  assert.deepEqual(calls, []);
  // Without the trailer it is reviewed again, and finishes with no trailer.
  atomicWrite(safePath(f.root, f.json.target), '{\n  "name": "area"\n}\n');
  assert.equal(done(f.root, f.json, inputContext(f.root, f.config)), false);
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  assert.deepEqual(calls.sort(), ['reviewer-rules ported/app.json', 'reviewer-semantics ported/app.json']);
  assert.equal(unitState(f.root, f.json).markerEvidence.noTrailer, true);
});

test('a trailer fix stopped under an earlier kit is checked again: what passes now is reviewed with no fixer call', async t => {
  const f = await formats(t);
  await finish(f);
  // As 0.45.0 left them when the run was stopped during a trailer fix: the
  // stage fix, no reviews, the finding in that kit's words.
  const stopped = (unit, message) => {
    const { arbitration, singlePass, markerEvidence: recorded, ...state } = unitState(f.root, unit);
    writeJSON(statePath(f.root, unit), { ...state, status: 'blocked', stage: 'fix', outputHash: fileHash(safePath(f.root, unit.target)), reviewMap: {}, reviews: [], reviewEvidence: [],
      markerRepair: { runId: 'earlier', count: 2 }, error: 'PORT STATUS count mismatch or invalid trailer',
      confirmed: [{ id: 'M1', reference: 'marker:M1', message: `The PORT STATUS trailer is wrong: ${message}`, evidence: 'earlier kit', rule: 'markerPolicy todo-lines-v1: exactly one PORT STATUS trailer, on the last nonempty line, whose todos is the number of lines containing TODO(port)' }] });
  };
  const { js, xml, json } = f;
  stopped(xml, 'the PORT STATUS line (line 4) does not read "PORT STATUS: confidence=high|medium|low todos=<number>"');
  stopped(json, 'There is no PORT STATUS line: add one as the last nonempty line, in the file\'s line-comment syntax, such as "// PORT STATUS: confidence=medium todos=0" (0 lines contain TODO(port))');
  // One still wrong under this kit: its fixer hears today's problem.
  atomicWrite(safePath(f.root, js.target), written[js.target]().replace('todos=0', 'todos=3'));
  stopped(js, 'an older wording');
  const calls = [], fixes = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(`${call.role} ${call.unit.target}`);
    if (call.role === 'fixer') { fixes.push(call.extra.confirmedFindings); return writes(call); }
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  assert.deepEqual(calls.filter(c => c.startsWith('fixer')), ['fixer ported/math_ops.mjs']);
  assert.equal(fixes[0].length, 1);
  assert.equal(fixes[0][0].message, 'The PORT STATUS trailer is wrong: it says todos=3 but 0 lines contain TODO(port): make the number 0, or change the TODO(port) lines');
  assert.match(fixes[0][0].rule, /a JSON file carries none/);
  for (const unit of [js, xml, json]) assert.deepEqual(calls.filter(c => c.endsWith(` ${unit.target}`) && c.startsWith('reviewer')).sort(), [`reviewer-rules ${unit.target}`, `reviewer-semantics ${unit.target}`], unit.target);
  const context = inputContext(f.root, f.config);
  for (const unit of f.units) assert.equal(done(f.root, unit, context), true, unit.target);
});

test('units an earlier kit left unfinished resume under these rules: Database.xml blocked after two trailer fixes is reviewed, a JSON file reviewed with a trailer is fixed once', async t => {
  const f = await formats(t);
  await finish(f);
  // Database.xml as 0.45.0 blocked it: its third wrong trailer in one run
  // stopped it at the review stage, before any review of the fixed file.
  const { arbitration, singlePass, markerEvidence: recorded, ...state } = unitState(f.root, f.xml);
  writeJSON(statePath(f.root, f.xml), { ...state, status: 'blocked', stage: 'review', reviewMap: {}, reviews: [], reviewEvidence: [], markerRepair: { runId: 'earlier', count: 2 },
    error: 'PORT STATUS count mismatch or invalid trailer: TODO(port) lines=0, claimed=null. The PORT STATUS line (line 4) does not read "PORT STATUS: confidence=high|medium|low todos=<number>".',
    confirmed: [{ id: 'M1', reference: 'marker:M1', message: 'The PORT STATUS trailer is wrong: the PORT STATUS line (line 4) does not read "PORT STATUS: confidence=high|medium|low todos=<number>"', evidence: 'earlier kit', rule: 'markerPolicy todo-lines-v1' }] });
  // A JSON file 0.45.0 reviewed with the trailer it asked for, stopped while
  // it was being validated: not finished, so this kit holds it to its rules.
  atomicWrite(safePath(f.root, f.json.target), '{\n  "name": "area"\n}\n// PORT STATUS: confidence=high todos=0\n');
  const json = unitState(f.root, f.json);
  writeJSON(statePath(f.root, f.json), { ...json, status: 'validating', stage: 'done', outputHash: fileHash(safePath(f.root, f.json.target)) });
  const calls = [], fixes = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(`${call.role} ${call.unit.target}`);
    if (call.role === 'fixer') { fixes.push(call.extra.confirmedFindings); return writes(call); }
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  assert.deepEqual(calls.filter(c => c.endsWith(' ported/Database.xml')).sort(), ['reviewer-rules ported/Database.xml', 'reviewer-semantics ported/Database.xml']);
  assert.deepEqual(calls.filter(c => c.endsWith(' ported/app.json')).map(c => c.startsWith('reviewer-') ? 'reviewer' : c), ['fixer ported/app.json', 'reviewer', 'reviewer']);
  assert.deepEqual(calls.filter(c => c.endsWith(' ported/math_ops.mjs')), []);
  assert.equal(fixes[0][0].message, removeIt);
  assert.equal(report.selfRepairs.markerFixes, 1);
  const context = inputContext(f.root, f.config);
  for (const unit of f.units) assert.equal(done(f.root, unit, context), true, unit.target);
  assert.equal(unitState(f.root, f.json).markerEvidence.noTrailer, true);
});

test('a JSON file with a trailer is sent to the fixer to remove it, then finishes', async t => {
  const f = await formats(t);
  const fixes = [];
  const report = await translate(f.root, f.config, async call => {
    if (call.role === 'fixer') { fixes.push(call.extra.confirmedFindings); return writes(call); }
    if (call.role === 'implementer') return answer(call, result(call.role, call.unit, { content: call.unit.target === 'ported/app.json' ? '{\n  "name": "area"\n}\n// PORT STATUS: confidence=high todos=0\n' : written[call.unit.target]() }));
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0][0].reference, 'marker:M1');
  assert.equal(fixes[0][0].message, removeIt);
  assert.match(fixes[0][0].rule, /a format without line comments ends it with the closer of its comment; a JSON file carries none/);
});

test('a JSON file\'s fixer is not told to count a TODO(port) line in the trailer it does not have', async t => {
  const f = await formats(t);
  const fixers = [];
  const report = await translate(f.root, f.config, async call => {
    if (call.role === 'implementer') return writes(call);
    if (call.role === 'reviewer-rules' && call.unit.target === 'ported/app.json') return answer(call, result(call.role, call.unit, { findings: [{ id: 'F1', message: 'The name differs from the source', evidence: 'src/app.json:2 names area', rule: 'Keep names' }] }));
    if (call.role === 'fixer') { fixers.push(call); return answer(call, result(call.role, call.unit, { content: fixers.length === 1 ? written['ported/app.json']() : '{\n  "name": "Area"\n}\n' })); }
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  assert.equal(fixers.length, 2);
  assert.equal(fixers[1].extra.correction, 'You returned the current candidate unchanged, but the findings in extra.confirmedFindings are still open. Change the file for each one. When one cannot be fixed in this file (it needs an inventory or RULEBOOK change, or a change in another file), add a line "TODO(port): <its reference>: <what is needed>" where it applies, instead of returning the file unchanged. Return the complete file again with this corrected.');
  assert.equal(done(f.root, f.json, inputContext(f.root, f.config)), true);
});
