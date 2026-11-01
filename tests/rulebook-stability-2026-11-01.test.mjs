// 2026-11-01: a one-line RULEBOOK example fix sent 347 finished units back to
// review. Three causes: the template's `todos=[N]` was copied with its
// brackets, the arbiter example "reviewer-role:ID" was copied literally, and
// nothing kept the RULEBOOK from being edited after translation started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ready, prepare, fake, result, finding } from './helpers.mjs';
import { safePath, writeJSON, readJSON, unitState, contextHash, done } from '../lib/core.mjs';
import { translate, arbitrationProblem } from '../lib/pipeline.mjs';
import { markerEvidence } from '../lib/markers.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';
import { interactiveDecision, rulebookHistoryDir } from '../lib/guardrails.mjs';
import { autoModeFile } from '../lib/auto-mode.mjs';
import { kitRoot } from '../scripts/install.mjs';

const policy = { markerPolicy: 'todo-lines-v1' };
const file = (...lines) => lines.join('\n') + '\n';

test('a trailer with the template brackets counts like the plain one; real slips still fail', () => {
  const body = ['class A {', '  // TODO(port): one', '  // TODO(port): two', '}'];
  for (const trailer of ['// PORT STATUS: confidence=medium todos=2', '// PORT STATUS: confidence=medium todos=[2]', '// PORT STATUS: confidence=[low] todos=[2]',
    '// PORT STATUS: confidence = high todos = 2', '// PORT STATUS: confidence=[ medium ] todos=[ 2 ]', '# PORT STATUS: confidence=low todos=[2]']) {
    const evidence = markerEvidence(policy, file(...body, trailer));
    assert.equal(evidence.valid, true, trailer); assert.equal(evidence.claimed, 2, trailer);
  }
  // A wrong count, a trailer inside the class and a missing count still fail.
  assert.equal(markerEvidence(policy, file(...body, '// PORT STATUS: confidence=medium todos=[3]')).valid, false);
  assert.equal(markerEvidence(policy, file(body[0], body[1], body[2], '  // PORT STATUS: confidence=medium todos=2', '}')).valid, false);
  assert.equal(markerEvidence(policy, file(...body, '// PORT STATUS: confidence=medium todos=[N]')).claimed, null);
  // Any count, bracketed or not, as long as it matches the lines.
  for (const n of [0, 1, 10, 123]) {
    const lines = Array.from({ length: n }, (_, i) => `// TODO(port): ${i}`);
    for (const shown of [`${n}`, `[${n}]`]) assert.equal(markerEvidence(policy, file('class A {', ...lines, '}', `// PORT STATUS: confidence=low todos=${shown}`)).valid, true, `${n} ${shown}`);
  }
});

test('the RULEBOOK templates show a concrete trailer, not bracketed placeholders', () => {
  for (const name of ['RULEBOOK.md', 'RULEBOOK.ja.md']) {
    const text = fs.readFileSync(path.join(kitRoot, 'templates', name), 'utf8');
    assert.ok(text.includes('// PORT STATUS: confidence=medium todos=2'), name);
    assert.ok(!/todos=\[/.test(text), name);
  }
});

test('writing roles get the trailer form and place under the count policy; the arbiter example is a real reference', () => {
  const unit = { source: 'src/a.cs', target: 'ported/A.java', id: 'x' };
  for (const role of ['implementer', 'fixer']) {
    const extra = role === 'fixer' ? { confirmedFindings: [] } : {};
    const counted = agentPrompt({ role, unit, extra, markerPolicy: 'todo-lines-v1' });
    assert.match(counted, /LAST nonempty line of content is exactly one status trailer/, role);
    assert.match(counted, /after the final closing brace \(never inside a class or function\)/, role);
    assert.match(counted, /without brackets/, role);
    assert.doesNotMatch(agentPrompt({ role, unit, extra }), /status trailer/, role);
  }
  const arbiter = agentPrompt({ role: 'arbiter', unit, extra: { references: ['reviewer-rules:F1'] } });
  assert.doesNotMatch(arbiter, /reviewer-role/);
  assert.match(arbiter, /"finding":"reviewer-semantics:F1"/);
  assert.match(arbiter, /copied exactly/);
});

test('arbitrationProblem names unknown, repeated and missing references', () => {
  const refs = ['reviewer-semantics:F1', 'reviewer-rules:F1'];
  assert.equal(arbitrationProblem(refs, refs.map(finding => ({ finding }))), null);
  const copied = arbitrationProblem(refs, [{ finding: 'reviewer-role:F1' }, { finding: 'reviewer-rules:F1' }]);
  assert.equal(copied.error, 'Unknown/duplicate arbitration finding');
  assert.match(copied.message, /Unknown finding "reviewer-role:F1"/); assert.match(copied.message, /Missing: "reviewer-semantics:F1"/);
  const twice = arbitrationProblem(refs, [{ finding: refs[0] }, { finding: refs[0] }, { finding: refs[1] }]);
  assert.equal(twice.error, 'Unknown/duplicate arbitration finding'); assert.match(twice.message, /Decided more than once: "reviewer-semantics:F1"/);
  const omitted = arbitrationProblem(refs, [{ finding: refs[1] }]);
  assert.equal(omitted.error, 'Arbiter omitted findings'); assert.match(omitted.message, /Missing: "reviewer-semantics:F1"/);
});

// One reviewer finding, so the arbiter is consulted; it is rejected, so the unit finishes without a fixer.
const arbitrated = arbiterAnswers => {
  const calls = [];
  const adapter = async call => {
    calls.push(call);
    if (call.role === 'reviewer-rules') return { result: result(call.role, call.unit, { findings: [finding] }), requestedModel: 'test-double', observedModel: null, tokens: null };
    if (call.role === 'arbiter') {
      const answer = arbiterAnswers[calls.filter(c => c.role === 'arbiter').length - 1];
      return { result: result(call.role, call.unit, { decisions: answer.map(ref => ({ finding: ref, confirmed: false, reason: 'not shown by the source' })) }), requestedModel: 'test-double', observedModel: null, tokens: null };
    }
    return fake(call);
  };
  return { calls, adapter };
};

test('an arbiter that copies the placeholder is asked once more and the unit finishes', async t => {
  const f = await ready(t);
  const { calls, adapter } = arbitrated([['reviewer-role:F1'], ['reviewer-rules:F1']]);
  const run = await translate(f.root, f.config, adapter);
  assert.equal(run.done, 1);
  const arbiters = calls.filter(c => c.role === 'arbiter');
  assert.equal(arbiters.length, 2);
  assert.deepEqual(arbiters[0].extra.references, ['reviewer-rules:F1']);
  assert.equal(arbiters[0].extra.correction, undefined);
  assert.match(arbiters[1].extra.correction, /Unknown finding "reviewer-role:F1"; Missing: "reviewer-rules:F1"/);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  const state = unitState(f.root, f.units[0]);
  assert.equal(readJSON(safePath(f.root, state.arbitration.path)).result.decisions[0].finding, 'reviewer-rules:F1');
});

test('a second miswritten arbitration still blocks the unit with the recorded wording', async t => {
  const f = await ready(t);
  const { calls, adapter } = arbitrated([['reviewer-role:F1'], ['reviewer-role:F1']]);
  const run = await translate(f.root, f.config, adapter).catch(e => e);
  assert.equal(calls.filter(c => c.role === 'arbiter').length, 2);
  const state = unitState(f.root, f.units[0]);
  assert.equal(state.status, 'blocked'); assert.equal(state.error, 'Unknown/duplicate arbitration finding');
  assert.notEqual(run?.done, 1);
});

const patch = target => `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch\n`;
const editRulebook = (f, how = 'patch') => interactiveDecision(how === 'patch'
  ? { toolName: 'apply_patch', toolArgs: patch('migration/RULEBOOK.md'), cwd: f.root }
  : { toolName: 'bash', toolArgs: { command: how }, cwd: f.root }, f.root);
const history = f => { try { return fs.readdirSync(safePath(f.root, rulebookHistoryDir)); } catch { return []; } };

test('before phase 01 is recorded the RULEBOOK is drafted freely and nothing is saved', t => {
  const f = prepare(t);
  assert.equal(editRulebook(f), null);
  assert.deepEqual(history(f), []);
});

test('after phase 01 an edit keeps the replaced version; after translation started it asks with the cost', t => {
  const f = prepare(t);
  writeJSON(safePath(f.root, 'migration/phases/01.json'), { schemaVersion: 1, phase: '01' });
  const before = fs.readFileSync(safePath(f.root, 'migration/RULEBOOK.md'), 'utf8');
  assert.equal(editRulebook(f), null);
  const saved = history(f);
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(safePath(f.root, `${rulebookHistoryDir}/${saved[0]}`), 'utf8'), before);
  // The same text is kept once, however often it is edited.
  editRulebook(f); assert.equal(history(f).length, 1);

  writeJSON(safePath(f.root, 'migration/gates/translation.json'), { schemaVersion: 1, stage: 'translation' });
  for (const [id, status] of [['a', 'done'], ['b', 'done'], ['c', 'blocked']]) writeJSON(safePath(f.root, `migration/state/units/${id}.json`), { status });
  const asked = editRulebook(f);
  assert.equal(asked.decision, 'ask');
  assert.match(asked.reason, /every finished unit \(2 now\) be reviewed again/);
  assert.match(asked.reason, /fixed by repair, not in the RULEBOOK/);
  assert.ok(asked.reason.includes(`${rulebookHistoryDir}/${saved[0]}`));
  // Real shell writes ask too; reads, copies out and quoted mentions do not.
  for (const command of ['echo rule >> migration/RULEBOOK.md', 'echo rule > migration/RULEBOOK.md', 'cat x | tee -a migration/RULEBOOK.md',
    'sed -i s/a/b/ migration/RULEBOOK.md', 'perl -pi -e s/a/b/ migration/RULEBOOK.md', 'cp /tmp/r.md migration/RULEBOOK.md',
    'mv migration/RULEBOOK.md /tmp/old.md', 'rm migration/RULEBOOK.md', 'Set-Content -Path migration/RULEBOOK.md -Value x',
    'Out-File -FilePath migration/RULEBOOK.md', 'git checkout -- migration/RULEBOOK.md', 'git restore migration/RULEBOOK.md',
    // Inside a shell's command string, a substitution, or an interpreter program that writes.
    'bash -lc "echo x > migration/RULEBOOK.md"', 'sh -c "sed -i s/a/b/ migration/RULEBOOK.md"', 'pwsh -Command "Set-Content migration/RULEBOOK.md x"',
    `powershell -NoProfile -Command "(Get-Content migration/RULEBOOK.md) -replace 'a','b' | Set-Content migration/RULEBOOK.md"`,
    `python3 -c "open('migration/RULEBOOK.md','w').write('x')"`, `python3 - <<'PY'\nfrom pathlib import Path\nPath('migration/RULEBOOK.md').write_text('x')\nPY`,
    `node -e "require('fs').writeFileSync('migration/RULEBOOK.md','x')"`, "[IO.File]::WriteAllText('migration/RULEBOOK.md', 'x')",
    'awk -i inplace "{print}" migration/RULEBOOK.md', 'sponge migration/RULEBOOK.md', 'dd if=/tmp/r of=migration/RULEBOOK.md', 'ln -sf /tmp/r migration/RULEBOOK.md',
    'New-Item -Path migration/RULEBOOK.md -ItemType File -Force', 'Copy-Item -Destination migration/RULEBOOK.md -Path /tmp/r.md',
    'New-Item -ItemType File -Force migration/RULEBOOK.md',
    "python3 <<'EOF'\nprint(1)\nEOF\npython3 <<'EOF'\nopen('migration/RULEBOOK.md','w').write('x')\nEOF",
    "cat <<'EOF' | python3\nopen('migration/RULEBOOK.md','w').write('x')\nEOF",
    `echo "open('migration/RULEBOOK.md','w').write('x')" | python3`,
    `node -e "require('fs').writeFileSync('migration/RULEBOOK.md','x')" scripts/run_migration.mjs`])
    assert.equal(editRulebook(f, command)?.decision, 'ask', command);
  for (const command of ['cat migration/RULEBOOK.md', 'rg -n PORT migration/RULEBOOK.md', 'sed -n 1,10p migration/RULEBOOK.md',
    "awk '/PORT/' migration/RULEBOOK.md", 'sha256sum migration/RULEBOOK.md', 'Get-Content migration/RULEBOOK.md',
    `python3 -c "print(open('migration/RULEBOOK.md').read())"`, 'cp migration/RULEBOOK.md /tmp/copy.md', 'git add migration/RULEBOOK.md',
    'git commit -am "update migration/RULEBOOK.md"', 'node migration-kit/scripts/run_migration.mjs repair --note "see migration/RULEBOOK.md"',
    'perl -Mstrict -ne print migration/RULEBOOK.md', 'ruby -rdigest -ne p migration/RULEBOOK.md', 'tee /tmp/x < migration/RULEBOOK.md',
    `python3 -c "print(open('migration/RULEBOOK.md').read())"`, 'bash -lc "sed -n 1,5p migration/RULEBOOK.md"',
    `python3 - <<'PY'\nfrom pathlib import Path\nrules = Path('migration/RULEBOOK.md').read_text()\nPath('migration/gap-report.md').write_text(rules[:10])\nPY`,
    'node migration-kit/scripts/run_migration.mjs repair --root . --note "writeFile slip in migration/RULEBOOK.md"',
    'python3 scripts/audit.py --out /tmp/r.md\ngrep -n writeFile migration/RULEBOOK.md', 'Copy-Item -Path migration/RULEBOOK.md -Destination /tmp/r.md',
    "New-Item -Path notes.txt -Value 'see migration/RULEBOOK.md'",
    "python3 <<'EOF'\nprint(open('migration/RULEBOOK.md').read())\nEOF\npython3 <<'EOF'\nopen('/tmp/out.txt','w').write('x')\nEOF"])
    assert.equal(editRulebook(f, command), null, command);
  // Other files are untouched by this check.
  assert.equal(interactiveDecision({ toolName: 'apply_patch', toolArgs: patch('migration/gap-report.md'), cwd: f.root }, f.root), null);

  const prefs = safePath(f.root, 'migration/preferences.json');
  writeJSON(prefs, { ...(fs.existsSync(prefs) ? readJSON(prefs) : { schemaVersion: 1 }), userLanguage: 'ja' });
  const ja = editRulebook(f);
  assert.equal(ja.decision, 'ask');
  assert.match(ja.reason, /完了済み 2 件のレビューのやり直し/);
});

test('the skill and the orchestrator say a blocked unit is repaired, not fixed in the RULEBOOK', () => {
  for (const rel of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md'])
    assert.match(fs.readFileSync(path.join(kitRoot, rel), 'utf8'), /repair that unit,\nnever edit the RULEBOOK for it/, rel);
  for (const rel of ['.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md'])
    assert.match(fs.readFileSync(path.join(kitRoot, rel), 'utf8'), /a unit blocked in translation is repaired, never fixed by editing the RULEBOOK/, rel);
});

test('in auto mode the edit is refused with the way on, since autopilot cannot show a confirmation', t => {
  const f = prepare(t);
  writeJSON(safePath(f.root, 'migration/phases/01.json'), { schemaVersion: 1, phase: '01' });
  writeJSON(safePath(f.root, 'migration/gates/translation.json'), { schemaVersion: 1, stage: 'translation' });
  writeJSON(safePath(f.root, 'migration/state/units/a.json'), { status: 'done' });
  writeJSON(safePath(f.root, autoModeFile), { schemaVersion: 1, enabledAt: new Date().toISOString() });
  const prefs = safePath(f.root, 'migration/preferences.json');
  writeJSON(prefs, { ...(fs.existsSync(prefs) ? readJSON(prefs) : { schemaVersion: 1, userLanguage: null }), phaseMode: 'auto' });
  const denied = editRulebook(f);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /Repair the blocked units without changing the RULEBOOK/);
  assert.match(denied.reason, /1 now/);
  assert.equal(editRulebook(f, 'sed -i s/a/b/ migration/RULEBOOK.md').decision, 'deny');
  assert.equal(editRulebook(f, 'sed -n 1,5p migration/RULEBOOK.md'), null);
  assert.equal(history(f).length, 1);
});
