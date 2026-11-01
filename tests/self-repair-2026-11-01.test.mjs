// 2026-11-01: a Mac run (kit 0.31.0) ended phase 04 with 19 of 347 units
// blocked, and the person had to rerun translate three times and ask what to
// do: 14 arbiters copied a placeholder reference, 2 trailers sat above the
// closing brace (reviewers saw only "invalid" and the unit looped through
// review), 2 fixers returned the file unchanged for an inventory gap they
// could not fix, and 1 reviewer added text after its JSON. The runner now
// repairs these slips itself: it asks the same role once more, saying what was
// wrong, sends a wrong trailer back to the fixer, and gives slipped units one
// more pass before the run ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake, result, finding, mini } from './helpers.mjs';
import { safePath, writeJSON, readJSON, unitState, contextHash, done } from '../lib/core.mjs';
import { translate, approve, runStage, contractSlip, unitSlip } from '../lib/pipeline.mjs';
import { markerEvidence, markerError } from '../lib/markers.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';
import { parseResult } from '../lib/results.mjs';

const policy = { markerPolicy: 'todo-lines-v1' };
const body = () => fs.readFileSync(path.join(mini, 'expected/math_ops.mjs'), 'utf8').replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd();
const good = () => `${body()}\n// PORT STATUS: confidence=high todos=0\n`;
// The trailer above the final closing brace, as the 0.31.0 fixers wrote it.
const inside = () => { const b = body(), i = b.lastIndexOf('}'); return `${b.slice(0, i)}// PORT STATUS: confidence=high todos=0\n}\n`; };
const answer = (call, value) => ({ result: value, requestedModel: 'test-double', observedModel: null, tokens: null, aiCredits: null });
const content = (call, text) => answer(call, result(call.role, call.unit, { content: text }));

async function setup(t, { single = true, typecheck = null, executionMode, count, overrides = {} } = {}) {
  const f = prepare(t, { ...(executionMode ? { executionMode } : {}), ...(count ? { count } : {}) });
  f.config.markerPolicy = 'todo-lines-v1';
  if (single) f.config.fixPolicy = 'single-pass';
  f.config.commands.typecheck = typecheck;
  Object.assign(f.config, overrides);
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Self-repair fixture only');
  return f;
}
const summary = (f, report) => readJSON(safePath(f.root, `migration/runs/${report.runId}/summary.json`));
// The two reviewers run side by side: their order is not part of the contract.
const roles = calls => calls.map(c => c.role.startsWith('reviewer-') ? 'reviewer' : c.role);

test('an invalid trailer says why; a valid one keeps exactly the recorded fields', () => {
  const valid = markerEvidence(policy, good());
  assert.deepEqual(Object.keys(valid), ['policy', 'candidateHash', 'countingMethod', 'actual', 'claimed', 'valid'], 'finished receipts compare every field');
  assert.equal(valid.valid, true);

  const above = markerEvidence(policy, inside());
  assert.equal(above.valid, false); assert.equal(above.actual, 0); assert.equal(above.claimed, 0);
  const trailerLine = inside().split('\n').findIndex(l => l.includes('PORT STATUS')) + 1;
  assert.match(above.problem, new RegExp(`the PORT STATUS line is line ${trailerLine}, but line ${trailerLine + 1} "}" follows it: move the trailer below it`));
  // The message keeps its old start (guidance and records match it) and adds the reason.
  const message = markerError(above);
  assert.match(message, /^PORT STATUS count mismatch or invalid trailer: TODO\(port\) lines=0, claimed=0\. The PORT STATUS line is line \d+/);
  assert.equal(failureGuidance(message).id, 'unit-slip');

  const counted = markerEvidence(policy, `${body()}\n// TODO(port): one\n// TODO(port): two\n// PORT STATUS: confidence=low todos=3\n`);
  assert.match(counted.problem, /it says todos=3 but 2 lines contain TODO\(port\): make the number 2/);
  assert.match(markerEvidence(policy, `${body()}\n`).problem, /There is no PORT STATUS line: add one as the last nonempty line.*todos=0/);
  assert.match(markerEvidence(policy, `// PORT STATUS: confidence=low todos=0\n${body()}\n// PORT STATUS: confidence=low todos=0\n`).problem, /2 lines contain PORT STATUS \(lines 1, \d+\): keep exactly one/);
  assert.match(markerEvidence(policy, `${body()}\n// PORT STATUS: done\n`).problem, /does not read "PORT STATUS: confidence=high\|medium\|low todos=<number>"/);
  // Several problems are all named.
  const both = markerEvidence(policy, `${body().slice(0, body().lastIndexOf('}'))}// TODO(port): x\n// PORT STATUS: confidence=low todos=0\n}\n`);
  assert.match(both.problem, /follows it: move the trailer below it.*; it says todos=0 but 1 lines contain TODO\(port\)/);
});

test('slip classes: contract slips are asked again; arbitration and unchanged fixes get one more pass; a trailer does not', () => {
  for (const m of ['Agent did not return one valid JSON object; no completion recorded', 'Copilot JSONL is incomplete: successful result and final assistant message required', 'Result schemaVersion/target mismatch', 'Expected implementation result',
    'Result requires content', 'Invalid review result', 'Duplicate finding id', 'Review verdict contradicts findings', 'Invalid arbitration result', 'Arbitration requires confirmed boolean']) {
    assert.equal(contractSlip(new Error(m)), true, m); assert.equal(unitSlip(m), true, m);
  }
  assert.equal(contractSlip(Object.assign(new Error('anything'), { code: 'INVALID_AGENT_RESULT' })), true);
  for (const m of ['Unknown/duplicate arbitration finding', 'Arbiter omitted findings', 'Fixer returned the reviewed candidate unchanged; confirmed findings remain open (fixPolicy single-pass)']) {
    assert.equal(contractSlip(new Error(m)), false, m); assert.equal(unitSlip(m), true, m);
  }
  for (const m of ['PORT STATUS count mismatch or invalid trailer: TODO(port) lines=1, claimed=2.', 'Fix-round limit reached; review recurring problems and propose a rule amendment',
    'Copilot reviewer-rules failed (exit 1): session.error rate_limit 429', 'Migration inputs changed; fresh approval required', 'Unit typecheck failed (exit 1)']) {
    assert.equal(contractSlip(new Error(m)), false, m); assert.equal(unitSlip(m), false, m);
  }
  // The parser's reason travels with the stable message.
  const e = (() => { try { parseResult('{"a":1}]}'); } catch (x) { return x; } })();
  assert.equal(e.message, 'Agent did not return one valid JSON object; no completion recorded');
  assert.match(e.parseError, /JSON/);
});

test('prompts: the fixer flags what this file cannot fix; a correction reaches every role', () => {
  const unit = { source: 'src/a.cs', target: 'ported/A.java', id: 'x' };
  const fixer = agentPrompt({ role: 'fixer', unit, extra: { confirmedFindings: [] }, markerPolicy: 'todo-lines-v1' });
  assert.match(fixer, /cannot be fixed in this file \(it needs an inventory or RULEBOOK change, or a change in another file\), do not return the file unchanged: add a line "TODO\(port\): <its reference>: <what is needed>"/);
  for (const role of ['implementer', 'fixer', 'arbiter']) {
    const extra = role === 'fixer' ? { confirmedFindings: [] } : {};
    assert.doesNotMatch(agentPrompt({ role, unit, extra }), /previous answer was rejected/, role);
    const asked = agentPrompt({ role, unit, extra: { ...extra, correction: 'Text followed the JSON object.' } });
    assert.match(asked, /Your previous answer was rejected: extra\.correction says why\. Return the whole answer again with that corrected\.\nSet target to/, role);
    assert.match(asked, /"correction":"Text followed the JSON object\."/, role);
  }
  // Reviewers do not see extra task data, so the correction is written out.
  assert.doesNotMatch(agentPrompt({ role: 'reviewer-rules', unit, reviewInput: '{}' }), /Correction:/);
  assert.match(agentPrompt({ role: 'reviewer-rules', unit, reviewInput: '{}', extra: { correction: 'Your previous answer was rejected: Text followed the JSON object.' } }),
    /\nCorrection: Your previous answer was rejected: Text followed the JSON object\.\nSet target to "ported\/A\.java"\.$/);
});

test('an implementer whose trailer sits above the closing brace is told where and asked once more', async t => {
  const f = await setup(t);
  const calls = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, call.extra.correction ? good() : inside());
    return fake(call);
  });
  assert.equal(report.done, 1);
  const implementers = calls.filter(c => c.role === 'implementer');
  assert.equal(implementers.length, 2);
  assert.equal(implementers[0].extra.correction, undefined);
  assert.match(implementers[1].extra.correction, /^The PORT STATUS trailer of your content is wrong: the PORT STATUS line is line \d+, but line \d+ "}" follows it: move the trailer below it.*Return the complete file again with this corrected\.$/);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), good());
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 1, markerFixes: 0 });
});

test('a trailer still wrong after its correction goes to the fixer as a finding at once; only the fixed file is reviewed', async t => {
  const f = await setup(t);
  const calls = [];
  // The implementer keeps the trailer inside the function, also after the correction.
  const report = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, inside());
    if (call.role === 'fixer') return content(call, good());
    return fake(call);
  });
  assert.equal(report.done, 1);
  const fixers = calls.filter(c => c.role === 'fixer');
  assert.equal(fixers.length, 1);
  const [m1] = fixers[0].extra.confirmedFindings;
  assert.equal(m1.reference, 'marker:M1');
  assert.match(m1.message, /^The PORT STATUS trailer is wrong: the PORT STATUS line is line \d+, but line \d+ "}" follows it/);
  // No review of the file with the wrong trailer: the fixed file has its own reviews.
  assert.deepEqual(roles(calls), ['implementer', 'implementer', 'fixer', 'reviewer', 'reviewer']);
  const context = contextHash(f.root, f.config), state = unitState(f.root, f.units[0]);
  assert.equal(done(f.root, f.units[0], context), true);
  assert.equal(state.markerEvidence.valid, true); assert.equal(state.markerEvidence.problem, undefined);
  // The trailer fix is not a fix round.
  assert.equal(state.round, 0);
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 1, markerFixes: 1 });
});

test('a file reviewed with a wrong trailer (written by an earlier run) goes to the fixer, and the fixed file is reviewed again', async t => {
  const f = await setup(t);
  // The 0.31.0 runs left such files behind: reviewed, then looping review -> done.
  fs.mkdirSync(path.dirname(safePath(f.root, f.units[0].target)), { recursive: true });
  fs.writeFileSync(safePath(f.root, f.units[0].target), inside());
  const calls = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'fixer') return content(call, good());
    return fake(call);
  });
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['reviewer', 'reviewer', 'fixer', 'reviewer', 'reviewer']);
  assert.equal(calls[2].extra.confirmedFindings[0].reference, 'marker:M1');
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), good());
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 0, markerFixes: 1 });
});

test('a trailer the fixer cannot place blocks after two fixes in the run, with the reason, and gets no extra pass', async t => {
  const f = await setup(t);
  const calls = [];
  const error = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'implementer' || call.role === 'fixer') return content(call, inside());
    return fake(call);
  }).catch(e => e);
  assert.match(error.message, /PORT STATUS count mismatch or invalid trailer: TODO\(port\) lines=0, claimed=0\. The PORT STATUS line is line \d+, but line \d+ "}" follows it/);
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.status, 'blocked'); assert.equal(state.markerRepair.count, 2);
  // Two marker fixes, each asked once more: four fixer calls, no third round.
  assert.equal(calls.filter(c => c.role === 'fixer').length, 4);
  assert.equal(calls.filter(c => c.role === 'implementer').length, 2);
  assert.equal(error.report.selfRepairs.markerFixes, 2); assert.equal(error.report.selfRepairs.repass, undefined);
  assert.equal(failureGuidance(error.report.errors[0].error).id, 'unit-slip');
});

test('a single-pass fixer that returns the file unchanged is told to flag what it cannot fix, and the unit finishes', async t => {
  const f = await setup(t);
  const calls = [];
  const flagged = `${body()}\n// TODO(port): reviewer-rules:F1: the inventory needs a nullability decision\n// PORT STATUS: confidence=medium todos=1\n`;
  const report = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, good());
    if (call.role.startsWith('reviewer-')) return answer(call, result(call.role, call.unit, { findings: [finding] }));
    if (call.role === 'fixer') return content(call, call.extra.correction ? flagged : good());
    return fake(call);
  });
  assert.equal(report.done, 1);
  const fixers = calls.filter(c => c.role === 'fixer');
  assert.equal(fixers.length, 2);
  assert.match(fixers[1].extra.correction, /^You returned the current candidate unchanged, but the findings in extra\.confirmedFindings are still open\..*add a line "TODO\(port\): <its reference>: <what is needed>" where it applies and count it in the PORT STATUS trailer/);
  const context = contextHash(f.root, f.config), state = unitState(f.root, f.units[0]);
  assert.equal(done(f.root, f.units[0], context), true);
  // The receipt binds the second fixer answer, the one written.
  assert.equal(readJSON(safePath(f.root, state.singlePass.fix.path)).extra, undefined);
  assert.equal(readJSON(safePath(f.root, state.singlePass.fix.path)).result.content, flagged);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), flagged);
});

test('a reviewer whose JSON has text after it is asked once more with the parser reason', async t => {
  const f = await setup(t);
  const calls = [];
  let slipped = false;
  const report = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, good());
    if (call.role === 'reviewer-semantics' && !slipped) {
      slipped = true;
      throw Object.assign(new Error('Agent did not return one valid JSON object; no completion recorded'), { code: 'INVALID_AGENT_RESULT', parseError: 'Unexpected non-whitespace character after JSON at position 3846' });
    }
    return fake(call);
  });
  assert.equal(report.done, 1);
  const semantics = calls.filter(c => c.role === 'reviewer-semantics');
  assert.equal(semantics.length, 2);
  assert.equal(semantics[1].extra.correction, 'Your previous answer was rejected: Agent did not return one valid JSON object; no completion recorded (Unexpected non-whitespace character after JSON at position 3846). Return exactly one JSON object in the contract\'s form, with nothing before or after it.');
  // The corrected review is the one bound to the receipt; both share the frozen input.
  assert.equal(semantics[0].reviewInput, semantics[1].reviewInput);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
});

// One finding, rejected, so the unit needs only the arbiter after review.
const arbitrated = answers => {
  const calls = [];
  const adapter = async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, good());
    if (call.role === 'reviewer-rules') return answer(call, result(call.role, call.unit, { findings: [finding] }));
    if (call.role === 'arbiter') {
      const ref = answers[calls.filter(c => c.role === 'arbiter').length - 1] ?? answers.at(-1);
      return answer(call, result(call.role, call.unit, { decisions: [{ finding: ref, confirmed: false, reason: 'not shown by the source' }] }));
    }
    return fake(call);
  };
  return { calls, adapter };
};

test('a unit whose arbiter slips twice gets one more pass before the run ends, and the run succeeds', async t => {
  const f = await setup(t, { executionMode: 'continuous' });
  const progress = [];
  const { calls, adapter } = arbitrated(['reviewer-role:F1', 'reviewer-role:F1', 'reviewer-rules:F1']);
  const report = await translate(f.root, f.config, adapter, { onProgress: e => progress.push(e.stage) });
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.equal(calls.filter(c => c.role === 'arbiter').length, 3);
  // The last pass resumes at arbitration: the reviews are not repeated.
  assert.equal(calls.filter(c => c.role.startsWith('reviewer-')).length, 2);
  assert.ok(progress.some(s => /^one more pass for 1 unit\(s\) blocked by a slip in an answer$/.test(s)));
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 0, markerFixes: 0, repass: { units: 1, done: 1 } });
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
});

test('the extra pass happens once; a unit that slips again stays blocked with its error', async t => {
  const f = await setup(t, { executionMode: 'continuous' });
  const { calls, adapter } = arbitrated(['reviewer-role:F1']);
  const error = await translate(f.root, f.config, adapter).catch(e => e);
  assert.match(error.message, /Unknown\/duplicate arbitration finding/);
  assert.equal(calls.filter(c => c.role === 'arbiter').length, 4);
  assert.equal(error.report.errors.length, 1);
  assert.deepEqual(error.report.selfRepairs, { corrections: 0, markerFixes: 0, repass: { units: 1, done: 0 } });
  assert.equal(unitState(f.root, f.units[0]).status, 'blocked');
});

test('a repair run does not add the extra pass', async t => {
  const f = await setup(t, { executionMode: 'continuous' });
  await translate(f.root, f.config, async call => call.role === 'implementer' ? content(call, good()) : fake(call));
  fs.writeFileSync(safePath(f.root, 'migration/diagnostic.txt'), 'Check the division rounding again.\n');
  const { calls, adapter } = arbitrated(['reviewer-role:F1']);
  const error = await translate(f.root, f.config, adapter, { onlyTarget: f.units[0].target, evidence: 'migration/diagnostic.txt' }).catch(e => e);
  assert.match(error.message, /Unknown\/duplicate arbitration finding/);
  assert.equal(calls.filter(c => c.role === 'arbiter').length, 2);
  assert.equal(error.report.selfRepairs?.repass, undefined);
});

test('a unit waiting on a slipped dependency runs once the extra pass finishes it', async t => {
  const f = prepare(t, { count: 3, executionMode: 'continuous' });
  f.config.markerPolicy = 'todo-lines-v1'; f.config.fixPolicy = 'single-pass'; f.config.commands.typecheck = null; f.config.dependencyOrder = 'reviewed';
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Self-repair fixture only');
  const main = f.units.find(u => u.target.endsWith('main.mjs')), math = f.units.find(u => u.target.endsWith('math_ops.mjs'));
  let mathArbiters = 0;
  const order = [];
  const report = await translate(f.root, f.config, async call => {
    order.push(`${call.role} ${path.basename(call.unit.target)}`);
    if (call.role === 'implementer' || call.role === 'fixer') {
      const expected = fs.readFileSync(path.join(mini, 'expected', path.basename(call.unit.target)), 'utf8').replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd();
      return content(call, `${expected}\n// PORT STATUS: confidence=high todos=0\n`);
    }
    if (call.role === 'reviewer-rules' && call.unit.target === math.target) return answer(call, result(call.role, call.unit, { findings: [finding] }));
    if (call.role === 'arbiter') {
      const ref = ++mathArbiters <= 2 ? 'reviewer-role:F1' : 'reviewer-rules:F1';
      return answer(call, result(call.role, call.unit, { decisions: [{ finding: ref, confirmed: false, reason: 'not shown' }] }));
    }
    return fake(call);
  });
  assert.equal(report.done, 3); assert.deepEqual(report.errors, []);
  // main.py depends on math_ops.py: it starts only after the last pass finished math_ops.
  assert.ok(order.lastIndexOf('arbiter math_ops.mjs') < order.indexOf('implementer main.mjs'), order.join(' | '));
  assert.equal(mathArbiters, 3);
  assert.equal(done(f.root, main, contextHash(f.root, f.config)), true);
  assert.deepEqual(summary(f, report).selfRepairs.repass, { units: 1, done: 1 });
});

// A reviewed candidate with a code change, and the same with the trailer above the closing brace.
const changed = () => `${body()}\nexport const reviewed = true;`;
const fixedGood = () => `${changed()}\n// PORT STATUS: confidence=high todos=0\n`;
const fixedInside = () => { const b = changed(), i = b.lastIndexOf('}'); return `${b.slice(0, i)}// PORT STATUS: confidence=high todos=0\n${b.slice(i)}\n`; };
// reviewer-rules raises the given findings on its first call only.
const firstReview = (findings, fixer, implementer = () => good()) => {
  const calls = [];
  const adapter = async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, implementer(call));
    if (call.role === 'reviewer-rules' && calls.filter(c => c.role === 'reviewer-rules').length === 1) return answer(call, result(call.role, call.unit, { findings }));
    if (call.role === 'fixer') return content(call, fixer(call, calls.filter(c => c.role === 'fixer').length));
    return fake(call);
  };
  return { calls, adapter };
};
const slip = () => Object.assign(new Error('Agent did not return one valid JSON object; no completion recorded'), { code: 'INVALID_AGENT_RESULT', parseError: 'Unexpected end of JSON input' });

test('a trailer fix is not held to maxFixRounds: a bounded unit whose rounds are used still gets its trailer fixed', async t => {
  const f = await setup(t, { executionMode: 'bounded', overrides: { maxFixRounds: 1 } });
  // The single-pass fix uses the one round and keeps the trailer above the brace.
  const { calls, adapter } = firstReview([finding], (call, n) => n <= 2 ? fixedInside() : fixedGood());
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(roles(calls), ['implementer', 'reviewer', 'reviewer', 'arbiter', 'fixer', 'fixer', 'fixer', 'reviewer', 'reviewer']);
  assert.equal(calls.filter(c => c.role === 'fixer')[2].extra.confirmedFindings[0].reference, 'marker:M1');
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.round, 1, 'the trailer fix is not a fix round');
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 1, markerFixes: 1 });
});

test('a trailer the fixer cannot place under the bounded limit blocks with the trailer reason, never the fix-round limit', async t => {
  const f = await setup(t, { executionMode: 'bounded', overrides: { maxFixRounds: 1 } });
  const { calls, adapter } = firstReview([finding], () => fixedInside());
  const error = await translate(f.root, f.config, adapter).catch(e => e);
  assert.match(error.message, /PORT STATUS count mismatch or invalid trailer: TODO\(port\) lines=0, claimed=0\. The PORT STATUS line is line \d+/);
  assert.doesNotMatch(error.message, /Fix-round limit reached/);
  assert.equal(failureGuidance(error.report.errors[0].error).id, 'unit-slip');
  // One reviewed fix and two trailer fixes, each asked once more; one review only.
  assert.equal(calls.filter(c => c.role === 'fixer').length, 6);
  assert.equal(calls.filter(c => c.role.startsWith('reviewer-')).length, 2);
  assert.equal(unitState(f.root, f.units[0]).markerRepair.count, 2);
});

test('with fixPolicy rereview a fix whose trailer is still wrong goes to the fixer before it is reviewed', async t => {
  const f = await setup(t, { single: false });
  const { calls, adapter } = firstReview([finding], (call, n) => n <= 2 ? fixedInside() : fixedGood());
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 1);
  assert.deepEqual(roles(calls), ['implementer', 'reviewer', 'reviewer', 'arbiter', 'fixer', 'fixer', 'fixer', 'reviewer', 'reviewer']);
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.singlePass, undefined); assert.equal(state.round, 1);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[0].target), 'utf8'), fixedGood());
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 1, markerFixes: 1 });
});

test('a fixer that slips during a trailer fix resumes at the fix on the last pass, not at review', async t => {
  const f = await setup(t, { executionMode: 'continuous' });
  const calls = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'implementer') return content(call, inside());
    if (call.role === 'fixer') { if (calls.filter(c => c.role === 'fixer').length <= 2) throw slip(); return content(call, good()); }
    return fake(call);
  });
  assert.equal(report.done, 1); assert.deepEqual(report.errors, []);
  assert.deepEqual(roles(calls), ['implementer', 'implementer', 'fixer', 'fixer', 'fixer', 'reviewer', 'reviewer']);
  assert.equal(calls.filter(c => c.role === 'fixer')[2].extra.confirmedFindings[0].reference, 'marker:M1');
  assert.deepEqual(summary(f, report).selfRepairs, { corrections: 2, markerFixes: 1, repass: { units: 1, done: 1 } });
});

test('the last pass keeps every unit\'s error: its breaker counts afresh, and a unit it never restarts keeps the first error', async t => {
  const f = await setup(t, { executionMode: 'bounded', count: 2, overrides: { concurrency: 1, maxConsecutiveFailures: 3 } });
  const slipping = async call => { if (call.role === 'implementer') throw slip(); return fake(call); };
  const error = await translate(f.root, f.config, slipping).catch(e => e);
  // Two units, two failures each pass: the breaker does not trip on the last pass.
  assert.deepEqual(error.report.errors.map(e => e.target).sort(), f.units.map(u => u.target).sort());
  assert.ok(error.report.errors.every(e => /^Agent did not return one valid JSON object/.test(e.error)));
  assert.deepEqual(error.report.selfRepairs, { corrections: 4, markerFixes: 0, repass: { units: 2, done: 0 } });

  // The call budget ends the last pass after its first unit: the other keeps its error.
  const g = await setup(t, { executionMode: 'bounded', count: 2, overrides: { concurrency: 1, maxConsecutiveFailures: 3 } });
  const stopped = await translate(g.root, g.config, slipping, { maxCalls: 5 }).catch(e => e);
  assert.equal(stopped.report.errors.length, 2);
  const limited = stopped.report.errors.find(e => /Agent call limit reached/.test(e.error));
  const kept = stopped.report.errors.find(e => /^Agent did not return one valid JSON object/.test(e.error));
  assert.ok(limited && kept, JSON.stringify(stopped.report.errors));
  assert.notEqual(limited.target, kept.target);
  assert.equal(unitState(g.root, g.units.find(u => u.target === kept.target)).status, 'blocked');
});

test('a single-pass fix refused for changing nothing does not use up a fix round', async t => {
  const f = await setup(t, { executionMode: 'bounded', overrides: { maxFixRounds: 1 } });
  const unchanged = firstReview([finding], () => good());
  const error = await translate(f.root, f.config, unchanged.adapter).catch(e => e);
  assert.match(error.message, /Fixer returned the reviewed candidate unchanged/);
  assert.equal(failureGuidance(error.report.errors[0].error).id, 'unit-slip');
  // Two refused fixes (the last pass included), each asked once more.
  assert.equal(unchanged.calls.filter(c => c.role === 'fixer').length, 4);
  assert.equal(unitState(f.root, f.units[0]).round, 0);
  // A rerun resumes at the fix with its round still free.
  const fixing = firstReview([], () => fixedGood());
  const report = await translate(f.root, f.config, fixing.adapter);
  assert.equal(report.done, 1);
  assert.deepEqual(roles(fixing.calls), ['fixer']);
  assert.equal(unitState(f.root, f.units[0]).round, 1);
});

test('a single-pass fix that only adds an unnamed TODO(port) line is asked to fix or name the finding; what it leaves open is reported', async t => {
  const f = await setup(t);
  const named = `${body()}\n// TODO(port): reviewer-rules:F1: the inventory needs a rounding decision\n// PORT STATUS: confidence=medium todos=1\n`;
  const { calls, adapter } = firstReview([finding], (call, n) => n === 1 ? `${body()}\n// TODO(port): needs a decision\n// PORT STATUS: confidence=medium todos=1\n` : named);
  const report = await translate(f.root, f.config, adapter);
  assert.equal(report.done, 1);
  const fixers = calls.filter(c => c.role === 'fixer');
  assert.equal(fixers.length, 2);
  assert.match(fixers[1].extra.correction, /^Your change fixes no code \(it changes only TODO\(port\) lines or the trailer\), so reviewer-rules:F1 is neither fixed nor named\. Fix each finding in extra\.confirmedFindings in the code; only when this file cannot fix one, name its reference in its TODO\(port\) line .* and count it in the PORT STATUS trailer\. Return the complete file again with this corrected\.$/);
  const state = unitState(f.root, f.units[0]);
  assert.deepEqual(state.singlePass.flagged, ['reviewer-rules:F1']);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  const recorded = summary(f, report);
  assert.deepEqual(recorded.selfRepairs.flagged, [{ target: f.units[0].target, references: ['reviewer-rules:F1'] }]);
  assert.ok(recorded.warnings.some(w => w === `${f.units[0].target}: its single-pass fix left reviewer-rules:F1 unfixed (flagged with TODO(port), or no code changed for it); no review follows a single-pass fix`), recorded.warnings);
});

test('what a single-pass fix leaves open: named flags next to a code change; nothing for a code fix or a trailer fix', async t => {
  const second = { ...finding, id: 'F2', message: 'Null input is not handled', evidence: 'src/math_ops.py:2 has no null check' };
  const cases = [
    { name: 'code change and one flag', findings: [finding, second], fixed: `${changed()}\n// TODO(port): reviewer-rules:F2: the inventory needs a null decision\n// PORT STATUS: confidence=medium todos=1\n`, flagged: ['reviewer-rules:F2'] },
    { name: 'code change only', findings: [finding], fixed: fixedGood(), flagged: undefined },
    { name: 'trailer only', findings: [{ ...finding, message: 'The PORT STATUS confidence should be medium: the rounding is unverified', evidence: 'last line' }], fixed: `${body()}\n// PORT STATUS: confidence=medium todos=0\n`, flagged: undefined }];
  for (const c of cases) {
    const f = await setup(t);
    const { calls, adapter } = firstReview(c.findings, () => c.fixed);
    const report = await translate(f.root, f.config, adapter);
    assert.equal(report.done, 1, c.name);
    assert.equal(calls.filter(x => x.role === 'fixer').length, 1, `${c.name}: no correction`);
    assert.deepEqual(unitState(f.root, f.units[0]).singlePass.flagged, c.flagged, c.name);
    assert.deepEqual(summary(f, report).selfRepairs?.flagged, c.flagged && [{ target: f.units[0].target, references: c.flagged }], c.name);
  }
});

test('an answer that ended without a final message is asked again', async t => {
  const f = await setup(t);
  const calls = [];
  const report = await translate(f.root, f.config, async call => {
    calls.push(call);
    if (call.role === 'implementer') {
      if (calls.length === 1) throw new Error('Copilot JSONL is incomplete: successful result and final assistant message required');
      return content(call, good());
    }
    return fake(call);
  });
  assert.equal(report.done, 1);
  const implementers = calls.filter(c => c.role === 'implementer');
  assert.equal(implementers.length, 2);
  assert.equal(implementers[1].extra.correction, 'Your previous answer was rejected: Copilot JSONL is incomplete: successful result and final assistant message required. It ended without a final answer (an empty message or a tool call): your last message must be exactly one JSON object in the contract\'s form.');
  assert.equal(failureGuidance('Copilot JSONL is incomplete: successful result and final assistant message required').id, 'worker-output');
});
