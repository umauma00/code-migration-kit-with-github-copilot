// SPDX-License-Identifier: Apache-2.0
// 0.40.0: a RULEBOOK change after phase 02 no longer revokes every record and
// finished unit. As upstream (rule 6), the person sees the change and the
// units it may touch, accepts it, and only the chosen units are reviewed
// again; a kit update keeps finished work too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ready, fake } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, fileHash, contextHash, done, unitState, rulebookAmendmentsFile, rulebookHistoryDir } from '../lib/core.mjs';
import { autoModeReport } from '../lib/preferences.mjs';
import { runStage, approve, translate, requireGate } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { currentPhase, phaseStaleness } from '../lib/phases.mjs';
import { rulebookChanges, acceptRulebook, rulebookDiff, rulebookMarkdown } from '../lib/rulebook.mjs';
import { interactiveDecision } from '../lib/guardrails.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { autoModeFile } from '../lib/auto-mode.mjs';

const inventory = 'file\tsymbol\tsource_construct\tclassification\ttarget_translation\tevidence\tstatus\n' +
  'src/math_ops.py\tdivide\tfloor-division\tSEMANTIC\tMath.floor of the quotient\tsrc/math_ops.py:4\tconfirmed\n' +
  'src/text_ops.py\tlength\tunicode-length\tSEMANTIC\tcount code points\tsrc/text_ops.py:2\tconfirmed\n';
const rules = f => safePath(f.root, 'migration/RULEBOOK.md');
const amend = (f, text) => fs.appendFileSync(rules(f), text);

// Phases 00 to 02 recorded, translation approved and three units finished.
async function translated(t) {
  const f = await ready(t, { count: 3 });
  atomicWrite(safePath(f.root, 'migration/inventory.tsv'), inventory);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, name), 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Automated fixture approval for tests only');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await translate(f.root, f.config, fake);
  const context = contextHash(f.root, f.config);
  assert.ok(f.units.every(u => done(f.root, u, context)));
  return { ...f, context };
}
const finished = f => f.units.map(u => done(f.root, u, f.context));

test('the diff is per section, and a construct tag names what a section rules on', () => {
  const before = '# Rules\nKeep names.\n\n## Division\nconstruct: floor-division\nUse floor.\n\n## Text\nCount code points.\n';
  const after = '# Rules\nKeep names.\n\n## Division\nconstruct: floor-division\nUse floor; keep the divisor sign.\n\n## Text\nCount code points.\n\n## Errors\nKeep messages.\n';
  const changed = rulebookDiff(before, after);
  assert.deepEqual(changed.map(s => s.heading), ['Division', 'Errors']);
  assert.deepEqual(changed[0].added, ['Use floor; keep the divisor sign.']);
  assert.deepEqual(changed[0].removed, ['Use floor.']);
  assert.deepEqual(changed[0].tags, ['floor-division']);
  assert.equal(changed[1].new, true);
  assert.deepEqual(rulebookDiff(before, before), []);
});

test('accepting a RULEBOOK change keeps phases, approvals and finished units, and redoes only the listed ones', async t => {
  const f = await translated(t);
  amend(f, '\n## Division\nfloor-division keeps the sign of the divisor.\n');
  // Without acceptance the change revokes, as before, and says how to keep the work.
  assert.notEqual(contextHash(f.root, f.config), f.context);
  const stale = phaseStaleness(f.root, f.config, '02');
  assert.equal(stale.action, 'accept-rulebook');
  assert.match(stale.next, /rulebook changes.*rulebook accept --note TEXT --redo listed\|all\|none\|PATH/s);
  assert.equal(failureGuidance("Phase 02's record is out of date. x", { root: f.root }).options[0].id, 'accept-rulebook');
  // A translate refused for a stale approval offers the same way first, not a redo of judge and approval.
  await assert.rejects(translate(f.root, f.config, fake), /approval is stale/);
  assert.equal(failureGuidance('translation approval is stale; inputs or outputs changed', { root: f.root }).options[0].id, 'accept-rulebook');

  const changes = rulebookChanges(f.root, f.config);
  assert.equal(changes.changed, true);
  assert.match(changes.previous, /^migration\/rulebook-history\/RULEBOOK-[0-9a-f]{16}\.md$/);
  assert.deepEqual(changes.sections.map(s => s.heading), ['Division']);
  assert.deepEqual(changes.candidates, [{ target: 'ported/math_ops.mjs', source: 'src/math_ops.py', matched: ['floor-division'] }]);
  assert.deepEqual(changes.unmatched, []);
  assert.equal(changes.finished, 3);
  assert.match(rulebookMarkdown(changes), /## Division \(new\)\n- added: floor-division keeps the sign of the divisor\.[\s\S]*ported\/math_ops\.mjs \(floor-division\)/);

  const accepted = acceptRulebook(f.root, f.config, { note: 'Division keeps the divisor sign', redo: 'listed' });
  assert.deepEqual(accepted.redo, ['ported/math_ops.mjs']);
  assert.equal(accepted.kept, 2);
  // Every record made under the reviewed RULEBOOK holds again.
  assert.equal(contextHash(f.root, f.config), f.context);
  assert.ok(currentPhase(f.root, f.config, '02'));
  assert.doesNotThrow(() => requireGate(f.root, f.config, 'translation', f.context));
  assert.deepEqual(finished(f), [false, true, true]);
  assert.equal(unitState(f.root, f.units[0]).stage, 'review');
  const log = readJSON(safePath(f.root, rulebookAmendmentsFile)).log;
  assert.equal(log.length, 1); assert.equal(log[0].note, 'Division keeps the divisor sign'); assert.deepEqual(log[0].redo, ['ported/math_ops.mjs']);
  // Only the chosen unit is reviewed again: two reviewers, no implementer.
  const calls = [];
  const rerun = await translate(f.root, f.config, async args => { calls.push(args.role); return fake(args); });
  assert.deepEqual(calls.sort(), ['reviewer-rules', 'reviewer-semantics']);
  assert.equal(rerun.done, 3);
  assert.deepEqual(finished(f), [true, true, true]);
  assert.equal(rulebookChanges(f.root, f.config).changed, false);
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'again', redo: 'none' }), /nothing to accept/);
});

test('a second change is compared with the accepted version; every redo choice works', async t => {
  const f = await translated(t);
  amend(f, '\n## Division\nfloor-division keeps the sign of the divisor.\n');
  acceptRulebook(f.root, f.config, { note: 'first', redo: 'none' });
  assert.deepEqual(finished(f), [true, true, true]);
  amend(f, '\n## Text\nunicode-length counts code points, never UTF-16 units.\n');
  const second = rulebookChanges(f.root, f.config);
  assert.deepEqual(second.sections.map(s => s.heading), ['Text'], 'only the new edit, not the accepted one');
  assert.deepEqual(second.candidates.map(c => c.target), ['ported/text_ops.mjs']);
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'x', redo: 'ported/none.mjs' }), /Not manifest targets: ported\/none\.mjs/);
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'x' }), /--redo listed\|all\|none/);
  assert.throws(() => acceptRulebook(f.root, f.config, { redo: 'none' }), /--note/);
  const named = acceptRulebook(f.root, f.config, { note: 'second', redo: 'ported/main.mjs,ported/text_ops.mjs' });
  assert.deepEqual(named.redo.sort(), ['ported/main.mjs', 'ported/text_ops.mjs']);
  assert.deepEqual(finished(f), [true, false, false]);
  assert.equal(readJSON(safePath(f.root, rulebookAmendmentsFile)).log.length, 2);
  amend(f, '\nKeep error messages.\n');
  // A section matching no file is named; all sends every finished unit back.
  const third = rulebookChanges(f.root, f.config);
  assert.ok(third.unmatched.length >= 1);
  assert.match(third.next, /changed sections matching no file/);
  const all = acceptRulebook(f.root, f.config, { note: 'third', redo: 'all' });
  assert.deepEqual(all.redo, ['ported/math_ops.mjs', 'ported/text_ops.mjs', 'ported/main.mjs'], 'units waiting for review are sent back too');
  assert.equal(all.kept, 0);
  assert.deepEqual(finished(f), [false, false, false]);
});

test('a change to anything besides the RULEBOOK cannot be accepted, and nothing is written', async t => {
  const f = await translated(t);
  amend(f, '\n## Division\nfloor-division keeps the sign of the divisor.\n');
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), '# changed\n');
  const changes = rulebookChanges(f.root, f.config);
  assert.ok(changes.other.length);
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'x', redo: 'listed' }), /Besides the RULEBOOK/);
  assert.equal(fs.existsSync(safePath(f.root, rulebookAmendmentsFile)), false);
  assert.notEqual(phaseStaleness(f.root, f.config, '02').action, 'accept-rulebook');
});

test('without the reviewed version kept, listed is refused and the person names the units', async t => {
  const f = await translated(t);
  fs.rmSync(safePath(f.root, rulebookHistoryDir), { recursive: true, force: true });
  amend(f, '\n## Division\nfloor-division keeps the sign of the divisor.\n');
  const changes = rulebookChanges(f.root, f.config);
  assert.equal(changes.previous, null); assert.equal(changes.sections, null);
  assert.match(changes.next, /cannot be listed/);
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'x', redo: 'listed' }), /--redo listed needs the reviewed RULEBOOK version/);
  assert.deepEqual(acceptRulebook(f.root, f.config, { note: 'x', redo: 'ported/math_ops.mjs' }).redo, ['ported/math_ops.mjs']);
});

test('the hook asks before rulebook accept (unasked in auto mode) and keeps agents off its record', async t => {
  const f = await translated(t);
  const shell = command => interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: f.root }, f.root);
  const accept = 'node migration-kit/scripts/run_migration.mjs rulebook accept --note "Division keeps the divisor sign" --redo listed';
  const asked = shell(accept);
  assert.equal(asked.decision, 'ask');
  assert.match(asked.reason, /only the units in --redo are reviewed again/);
  assert.equal(shell('node migration-kit/scripts/run_migration.mjs rulebook changes --format markdown'), null);
  assert.equal(shell(`echo '{}' > ${rulebookAmendmentsFile}`).decision, 'deny');
  assert.equal(interactiveDecision({ toolName: 'apply_patch', toolArgs: `*** Begin Patch\n*** Add File: ${rulebookAmendmentsFile}\n+{}\n*** End Patch\n`, cwd: f.root }, f.root).decision, 'deny');
  writeJSON(safePath(f.root, autoModeFile), { schemaVersion: 1, enabledAt: new Date().toISOString() });
  const prefs = safePath(f.root, 'migration/preferences.json');
  writeJSON(prefs, { ...(fs.existsSync(prefs) ? readJSON(prefs) : { schemaVersion: 1, userLanguage: null }), phaseMode: 'auto' });
  assert.equal(shell(accept), null, 'auto mode records it unasked, like the other approvals');
  amend(f, '\n## Division\nfloor-division keeps the sign of the divisor.\n');
  // Auto mode takes the conservative scope only.
  // Auto mode never drops a listed file.
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'auto', redo: 'none' }), /In auto mode --redo none is refused while 1 listed file/);
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'auto', redo: 'ported/main.mjs' }), /keeps every listed file; missing: ported\/math_ops\.mjs/);
  assert.equal(acceptRulebook(f.root, f.config, { note: 'auto', redo: 'listed' }).auto, true, 'recorded as decided without the person');
  assert.equal(readJSON(safePath(f.root, rulebookAmendmentsFile)).log[0].auto, true);
  assert.ok(autoModeReport(f.root).records.includes('rulebook accept'), 'status lists it as decided without the person');
  // A section no file matches by words: not every unit. The agent reads it and
  // names the files it affects, or none when it cannot affect translated code.
  amend(f, '\nKeep error messages.\n');
  assert.deepEqual(rulebookChanges(f.root, f.config).candidates, []);
  assert.throws(() => acceptRulebook(f.root, f.config, { note: 'auto', redo: 'listed' }), /read the changed sections that match no file by words \(Division\)/);
  const named = acceptRulebook(f.root, f.config, { note: 'Error messages: only text_ops raises errors', redo: 'ported/text_ops.mjs' });
  assert.deepEqual(named.redo, ['ported/text_ops.mjs']);
  assert.deepEqual(finished(f), [false, false, true], 'math_ops from the first change and text_ops; main stays done');
  amend(f, '\nWording only.\n');
  assert.equal(acceptRulebook(f.root, f.config, { note: 'Wording only; no translated code is affected', redo: 'none' }).redo.length, 0);
  assert.equal(readJSON(safePath(f.root, rulebookAmendmentsFile)).log.length, 3);
});

test('an acceptance needs its log entry, and re-recording 02 leaves nothing to accept', async t => {
  const f = await translated(t);
  amend(f, '\n## Division\nfloor-division keeps the sign of the divisor.\n');
  // A mapping without the entry that accepted it (a forged file) is ignored.
  const raw = fileHash(rules(f)), identity = readJSON(safePath(f.root, 'migration/phases/02.json')).evidence.find(e => e[0] === 'migration/RULEBOOK.md')[1];
  writeJSON(safePath(f.root, rulebookAmendmentsFile), { schemaVersion: 1, accepted: { [raw]: identity }, log: [] });
  assert.notEqual(contextHash(f.root, f.config), f.context);
  fs.rmSync(safePath(f.root, rulebookAmendmentsFile));
  // Recording 02 again on the new RULEBOOK: the later phases are stale for the
  // predecessor, and accepting is no longer offered.
  phaseCommand(f.root, f.config, 'complete', '02', { note: 'Recorded again on the clarified division rule' });
  assert.equal(rulebookChanges(f.root, f.config).changed, false);
  assert.notEqual(phaseStaleness(f.root, f.config, '02')?.action, 'accept-rulebook');
});
