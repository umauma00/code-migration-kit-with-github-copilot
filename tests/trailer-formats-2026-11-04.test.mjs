// SPDX-License-Identifier: Apache-2.0
// 2026-11-04: a Windows run (phase 04, 98 of 554 units) sent Database.xml back
// to the fixer on every run. XML has no line comment, and the trailer had to
// end with its count, so `<!-- PORT STATUS: confidence=medium todos=2 -->`
// failed and only a file that was no longer XML (a bare line, an unclosed
// comment) could pass. Each run spent up to four fixer calls rewriting the
// whole file, then left it unfinished. A trailer may now end with the closer
// of a comment that ends on its line; a JSON file carries none. A trailer that
// passed before passes with exactly the same recorded fields, so finished
// units keep their receipts (a JSON file finished with one too).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake, result, mini } from './helpers.mjs';
import { safePath, writeJSON, atomicWrite, readManifest, readJSON, unitState, statePath, fileHash, inputContext, done } from '../lib/core.mjs';
import { translate, approve, runStage, withoutFlags } from '../lib/pipeline.mjs';
import { markerEvidence, finishedMarkerEvidence, markerError, trailerClosers, carriesNoTrailer } from '../lib/markers.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';

const policy = { markerPolicy: 'todo-lines-v1' };
const file = (...lines) => lines.join('\n') + '\n';

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

test('every trailer that passed before passes with the same recorded fields; in JSON only a finished unit keeps it', () => {
  const bodies = [['class A {', '}'], ['class A {', '  // TODO(port): one', '  // TODO(port): two', '}'], ['{', '  "a": "TODO(port): x"', '}'], ['<root>', '  <!-- TODO(port): y -->', '</root>']];
  const trailers = n => [`// PORT STATUS: confidence=medium todos=${n}`, `# PORT STATUS: confidence=low todos=[${n}]`, `-- PORT STATUS: confidence=high todos=${n}  `,
    `PORT STATUS: confidence = [ medium ] todos = [ ${n} ]`, `<!-- PORT STATUS: confidence=medium todos=${n}`, `' PORT STATUS: confidence=low todos=${n}`];
  let compared = 0;
  for (const body of bodies) {
    const n = body.filter(line => line.includes('TODO(port)')).length;
    for (const trailer of trailers(n)) for (const eol of ['\n', '\r\n']) for (const blank of ['', eol, `${eol}  ${eol}`]) {
      const content = [...body, trailer].join(eol) + eol + blank;
      const old = before(content);
      assert.equal(old.valid, true, JSON.stringify(content));
      for (const target of ['ported/A.java', 'ported/conf.json', 'ported/Database.xml', 'ported/page.jsp', undefined]) {
        // A finished unit's receipt holds, whatever the target.
        assert.deepEqual(finishedMarkerEvidence(policy, content, target, old), old, `${target}: ${JSON.stringify(content)}`);
        // A new answer passes as before, except in JSON, which takes no trailer.
        if (carriesNoTrailer(target)) assert.match(markerEvidence(policy, content, target).problem, /^this format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer \(line \d+\)$/);
        else assert.deepEqual(markerEvidence(policy, content, target), old, `${target}: ${JSON.stringify(content)}`);
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
    'ported/Area.cshtml': ['<p>@Model.Name</p>', '@* PORT STATUS: confidence=medium todos=0 *@'],
    'ported/area.html.j2': ['<p>{{ name }}</p>', '{# PORT STATUS: confidence=medium todos=0 #}'],
    'ported/area.html.erb': ['<p><%= name %></p>', '<%# PORT STATUS: confidence=medium todos=0 %>'],
    'ported/area.ml': ['let area = 1', '(* PORT STATUS: confidence=medium todos=0 *)'],
    // A comment opened on a line above and closed on the trailer's line.
    'ported/Split.xml': ['<root/>', '<!--', '  PORT STATUS: confidence=medium todos=[0] -->']
  };
  for (const [target, lines] of Object.entries(forms)) {
    for (const eol of ['\n', '\r\n']) {
      const evidence = markerEvidence(policy, lines.join(eol) + eol, target);
      assert.equal(evidence.valid, true, `${target}: ${evidence.problem}`);
      assert.deepEqual(Object.keys(evidence), ['policy', 'candidateHash', 'countingMethod', 'actual', 'claimed', 'valid'], target);
    }
  }
  assert.deepEqual(trailerClosers, ['-->', '--%>', '%>', '*/', '*@', '#}', '*)']);
  for (const closer of trailerClosers) assert.equal(markerEvidence(policy, file('x', `PORT STATUS: confidence=low todos=0 ${closer}`), 'a.txt').valid, true, closer);
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
  assert.deepEqual({ ...none, candidateHash: null }, { policy: 'todo-lines-v1', candidateHash: null, countingMethod: 'literal-lines-containing-TODO(port)', actual: 0, claimed: null, valid: true,
    noTrailer: 'this format has no comments, so the file carries no PORT STATUS trailer' });
  for (const target of ['a.JSON', 'a.jsonl', 'a.ndjson', 'a.geojson', 'site.webmanifest']) assert.equal(carriesNoTrailer(target), true, target);
  for (const target of ['a.json5', 'a.jsonc', 'a.json.txt', 'a.xml', 'A.java', undefined, null]) assert.equal(carriesNoTrailer(target), false, String(target));
  // Other formats still need one.
  for (const target of ['ported/A.java', 'ported/a.xml', 'ported/a.json5', undefined]) {
    const missing = markerEvidence(policy, json, target);
    assert.equal(missing.valid, false, String(target));
    assert.match(missing.problem, /^There is no PORT STATUS line: add one as the last nonempty line, in the file's line-comment syntax, such as "\/\/ PORT STATUS: confidence=medium todos=0" \(0 lines contain TODO\(port\)\); a format without line comments ends that line with the closer of its comment, such as "<!-- PORT STATUS: confidence=medium todos=0 -->"$/);
  }
  // Any trailer breaks JSON: it is a problem there, and the error says to remove it.
  for (const trailer of ['<!-- PORT STATUS: confidence=low todos=0 -->', '// PORT STATUS: confidence=low todos=0', 'PORT STATUS: confidence=low todos=0']) {
    const evidence = markerEvidence(policy, `${json}${trailer}\n`, 'ported/conf/app.json');
    assert.equal(evidence.valid, false, trailer);
    assert.equal(evidence.problem, 'this format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 5)', trailer);
    assert.equal(markerError(evidence), 'PORT STATUS count mismatch or invalid trailer: TODO(port) lines=0, claimed=0. This format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 5).', trailer);
  }
  assert.equal(markerError(markerEvidence(policy, `${json}// PORT STATUS: done\n`, 'a.json')), 'PORT STATUS count mismatch or invalid trailer: TODO(port) lines=0, claimed=missing. This format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 5).');
  assert.match(markerEvidence(policy, `${json}// PORT STATUS: confidence=low todos=0\n// PORT STATUS: confidence=low todos=0\n`, 'a.json').problem, /remove the PORT STATUS trailer \(lines 5, 6\)$/);
  // A receipt of 0.45.0 or earlier (valid, no noTrailer) holds while the file passes that check.
  const legacy = `${json}// PORT STATUS: confidence=low todos=0\n`;
  const recorded = before(legacy);
  assert.deepEqual(finishedMarkerEvidence(policy, legacy, 'a.json', recorded), recorded);
  // No other receipt does: a 0.45.1 one (noTrailer), an invalid one, none, or a file that check refuses.
  for (const other of [{ ...recorded, noTrailer: 'x' }, { ...recorded, valid: false }, null, undefined, 'valid'])
    assert.equal(finishedMarkerEvidence(policy, legacy, 'a.json', other).valid, false, JSON.stringify(other));
  const closed = `${json}<!-- PORT STATUS: confidence=low todos=0 -->\n`;
  assert.equal(finishedMarkerEvidence(policy, closed, 'a.json', { ...before(closed), valid: true }).valid, false);
  // Elsewhere a receipt is checked as any answer is.
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
    ['<!-- TODO(port): x -->\n<r/>\n<!-- PORT STATUS: confidence=low todos=1 -->', '<r/>']
  ];
  for (const [text, stripped] of pairs) assert.equal(withoutFlags(text), stripped, text);
  // Inside quotes or after other code they stay text, as before.
  for (const text of ['s = "<%-- TODO(port): x --%>"', "s = '{# TODO(port): x #}'", 'f(** TODO(port): x *)']) assert.equal(withoutFlags(text), text, text);
});

test('writing roles are told the forms; reviewers and the arbiter are told they are not defects', () => {
  const unit = { source: 'src/Database.xml', target: 'ported/Database.xml', id: 'x' };
  for (const role of ['implementer', 'fixer']) {
    const extra = role === 'fixer' ? { confirmedFindings: [] } : {};
    const prompt = agentPrompt({ role, unit, extra, markerPolicy: 'todo-lines-v1' });
    assert.match(prompt, /A format without line comments puts the trailer in one comment that ends on that last line, after everything else: `<!-- PORT STATUS: confidence=medium todos=2 -->` in XML or HTML \(after the closing root tag\), `<%-- PORT STATUS: confidence=medium todos=2 --%>` in JSP, `\/\* PORT STATUS: confidence=medium todos=2 \*\/` in CSS\. A JSON file has no comments: it carries no trailer\./, role);
    assert.doesNotMatch(agentPrompt({ role, unit, extra }), /PORT STATUS/, role);
  }
  for (const role of ['reviewer-rules', 'reviewer-semantics']) {
    const prompt = agentPrompt({ role, unit, reviewInput: '{}', markerPolicy: 'todo-lines-v1' });
    assert.match(prompt, /In a format without line comments the PORT STATUS trailer is one comment that ends on the last line, such as `<!-- PORT STATUS: confidence=medium todos=2 -->` in XML or HTML, and a JSON file carries none: report neither form as a defect \(markerEvidence in the input is the coordinator's own count\)\./, role);
    assert.doesNotMatch(agentPrompt({ role, unit, reviewInput: '{}' }), /one comment that ends on the last line/, role);
  }
  const arbiter = agentPrompt({ role: 'arbiter', unit, extra: { references: ['reviewer-rules:F1'] }, markerPolicy: 'todo-lines-v1' });
  assert.match(arbiter, /and a JSON file carries none: do not confirm a finding against either form\./);
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
  assert.match(en, /A JSON file has\nno comments, so it carries no trailer\./);
  assert.match(ja, /JSON ファイルは\nコメントを書けないので、この行を付けません。/);
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
  return { ...f, units: readManifest(f.root, f.config) };
}
const written = {
  'ported/math_ops.mjs': () => `${fs.readFileSync(path.join(mini, 'expected/math_ops.mjs'), 'utf8').replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd()}\n// PORT STATUS: confidence=high todos=0\n`,
  'ported/Database.xml': () => '<?xml version="1.0"?>\n<sqlMap namespace="Area">\n</sqlMap>\n<!-- PORT STATUS: confidence=high todos=0 -->\n',
  'ported/app.json': () => '{\n  "name": "area"\n}\n'
};
const answer = (call, value) => ({ result: value, requestedModel: 'test-double', observedModel: null, tokens: null, aiCredits: null });

test('Database.xml and a JSON file finish on their first answer, and stay finished', async t => {
  const f = await formats(t);
  const calls = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(`${call.role} ${call.unit.target}`);
    if (call.role === 'implementer' || call.role === 'fixer') return answer(call, result(call.role, call.unit, { content: written[call.unit.target]() }));
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  // Nothing was asked again or sent back for its trailer.
  assert.equal(report.selfRepairs, undefined);
  assert.deepEqual(calls.filter(c => c.startsWith('fixer')), []);
  assert.equal(calls.filter(c => c.startsWith('implementer')).length, 3);
  const context = inputContext(f.root, f.config);
  for (const unit of f.units) assert.equal(done(f.root, unit, context), true, unit.target);
  const json = f.units.find(u => u.target === 'ported/app.json');
  assert.equal(unitState(f.root, json).markerEvidence.noTrailer, 'this format has no comments, so the file carries no PORT STATUS trailer');
  // The reviewers were given the coordinator's count as valid.
  const xml = f.units.find(u => u.target === 'ported/Database.xml');
  const review = readJSON(safePath(f.root, unitState(f.root, xml).reviews[0]));
  assert.match(review.reviewInputHash, /^[a-f0-9]{64}$/);
  assert.equal(unitState(f.root, xml).markerEvidence.valid, true);
  // A trailer that would break the JSON file is sent back to be removed.
  atomicWrite(safePath(f.root, 'ported/app.json'), '{\n  "name": "area"\n}\n<!-- PORT STATUS: confidence=high todos=0 -->\n');
  assert.equal(done(f.root, json, inputContext(f.root, f.config)), false);
});

test('a JSON file finished with a trailer by an earlier kit stays finished; removing it by hand reviews it once', async t => {
  const f = await formats(t);
  await translate(f.root, f.config, async call => call.role === 'implementer' ? answer(call, result(call.role, call.unit, { content: written[call.unit.target]() })) : fake(call));
  // What 0.45.0 recorded for a JSON file it finished: the trailer it asked for.
  const json = f.units.find(u => u.target === 'ported/app.json');
  const legacy = '{\n  "name": "area"\n}\n// PORT STATUS: confidence=high todos=0\n';
  atomicWrite(safePath(f.root, json.target), legacy);
  const state = unitState(f.root, json);
  writeJSON(statePath(f.root, json), { ...state, outputHash: fileHash(safePath(f.root, json.target)), markerEvidence: before(legacy) });
  assert.equal(done(f.root, json, inputContext(f.root, f.config)), true);
  const calls = [];
  const adapter = async call => { calls.push(`${call.role} ${call.unit.target}`); return call.role === 'implementer' || call.role === 'fixer' ? answer(call, result(call.role, call.unit, { content: written[call.unit.target]() })) : fake(call); };
  assert.equal((await translate(f.root, f.config, adapter)).done, 3);
  assert.deepEqual(calls, []);
  // Without the trailer it is reviewed again, and finishes with no trailer.
  atomicWrite(safePath(f.root, json.target), '{\n  "name": "area"\n}\n');
  assert.equal(done(f.root, json, inputContext(f.root, f.config)), false);
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  assert.deepEqual(calls.sort(), ['reviewer-rules ported/app.json', 'reviewer-semantics ported/app.json']);
  assert.equal(unitState(f.root, json).markerEvidence.noTrailer, 'this format has no comments, so the file carries no PORT STATUS trailer');
});

test('a trailer fix stopped under an earlier kit is checked again: what passes now is reviewed with no fixer call', async t => {
  const f = await formats(t);
  await translate(f.root, f.config, async call => call.role === 'implementer' ? answer(call, result(call.role, call.unit, { content: written[call.unit.target]() })) : fake(call));
  // As 0.45.0 left them when the run was stopped during a trailer fix: the
  // stage fix, no reviews, the finding in that kit's words.
  const stopped = (unit, message) => {
    const { arbitration, singlePass, markerEvidence: recorded, ...state } = unitState(f.root, unit);
    writeJSON(statePath(f.root, unit), { ...state, status: 'blocked', stage: 'fix', outputHash: fileHash(safePath(f.root, unit.target)), reviewMap: {}, reviews: [], reviewEvidence: [],
      markerRepair: { runId: 'earlier', count: 2 }, error: 'PORT STATUS count mismatch or invalid trailer',
      confirmed: [{ id: 'M1', reference: 'marker:M1', message: `The PORT STATUS trailer is wrong: ${message}`, evidence: 'earlier kit', rule: 'markerPolicy todo-lines-v1: exactly one PORT STATUS trailer, on the last nonempty line, whose todos is the number of lines containing TODO(port)' }] });
  };
  const [js, xml, json] = ['ported/math_ops.mjs', 'ported/Database.xml', 'ported/app.json'].map(target => f.units.find(u => u.target === target));
  stopped(xml, 'the PORT STATUS line (line 4) does not read "PORT STATUS: confidence=high|medium|low todos=<number>"');
  stopped(json, 'There is no PORT STATUS line: add one as the last nonempty line, in the file\'s line-comment syntax, such as "// PORT STATUS: confidence=medium todos=0" (0 lines contain TODO(port))');
  // One still wrong under this kit: its fixer hears today's problem.
  atomicWrite(safePath(f.root, js.target), written[js.target]().replace('todos=0', 'todos=3'));
  stopped(js, 'an older wording');
  const calls = [], fixes = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(`${call.role} ${call.unit.target}`);
    if (call.role === 'fixer') { fixes.push(call.extra.confirmedFindings); return answer(call, result(call.role, call.unit, { content: written[call.unit.target]() })); }
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

test('a JSON file with a trailer is sent to the fixer to remove it, then finishes', async t => {
  const f = await formats(t);
  const fixes = [];
  const report = await translate(f.root, f.config, async call => {
    if (call.role === 'fixer') { fixes.push(call.extra.confirmedFindings); return answer(call, result(call.role, call.unit, { content: written[call.unit.target]() })); }
    if (call.role === 'implementer') return answer(call, result(call.role, call.unit, { content: call.unit.target === 'ported/app.json' ? '{\n  "name": "area"\n}\n// PORT STATUS: confidence=high todos=0\n' : written[call.unit.target]() }));
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0][0].reference, 'marker:M1');
  assert.equal(fixes[0][0].message, 'The PORT STATUS trailer is wrong: this format has no comments, so the file carries no PORT STATUS trailer: remove the PORT STATUS trailer (line 4)');
  assert.match(fixes[0][0].rule, /a format without line comments ends it with the closer of its comment; a JSON file carries none/);
});
