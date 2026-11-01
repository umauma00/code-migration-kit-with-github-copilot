// SPDX-License-Identifier: Apache-2.0
// 0.41.1: on 2026-11-01 (Windows, kit 0.40.0, auto mode) phase 03 had just
// started when the agent added the formal judge result to judge-report.md,
// which phase 00b's prompt had told it to fill with "any deferred formal
// validation". The 00b record binds that file, so 00b to 02 had to be recorded
// again; after pilot prepare the same edit would also have ended the pilot.
// The prompts now keep such notes out of recorded reports. When one is added
// anyway, phase next, the gate errors, the guidance, the pilot and the fast
// status say first to remove it (with a file edit, not git, which the
// guardrails deny), which keeps every record and the pilot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, mini } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, contextHash, loadConfig, phaseReports as coreReports } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { install } from '../scripts/install.mjs';
import { phaseStaleness, phaseReports, requirePhase } from '../lib/phases.mjs';
import { runStage, currentRecord } from '../lib/pipeline.mjs';
import { preparePilot, requirePilot } from '../lib/pilot.mjs';
import { installGuardrails, guardrailDecision } from '../lib/guardrails.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { failureGuidance } from '../lib/guidance.mjs';
import { initSourceSpec } from '../lib/source-spec.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kitText = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const report = 'migration/judge-report.md';
const deferred = '# Judge report\nScope: three files. Formal judge: deferred until after phase 02.\n';
const noted = '# Judge report\nScope: three files. Formal judge: passed (preparation validated, equivalence unverified).\n';
const removeFirst = /first remove exactly what you added with your file edit tool, not git \(byte for byte, line endings included; the migration guardrails may deny git restore and git checkout\)/;

// Phases 00 to 02 recorded in strict order and the formal judge run, as at the
// start of phase 03.
async function atPhase03(t) {
  const f = prepare(t, { count: 3 });
  f.config.phasePolicy = 'strict';
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  atomicWrite(safePath(f.root, report), deferred);
  for (const name of ['migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, name), 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await runStage(f.root, f.config, 'judge');
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '03');
  return f;
}
const judgeCurrent = f => Boolean(currentRecord(f.root, f.config, 'judge', contextHash(f.root, f.config), false));
const receipts = (root, ids) => ids.map(id => fs.readFileSync(safePath(root, `migration/phases/${id}.json`), 'utf8'));
const gateError = fn => { try { fn(); } catch (e) { return e; } assert.fail('the gate let it through'); };
// Written a few seconds after the record, as a real edit is (the fast view
// compares file times with a one-second margin).
const writeLater = (root, rel, text) => { atomicWrite(safePath(root, rel), text); const at = new Date(Date.now() + 5000); fs.utimesSync(safePath(root, rel), at, at); };

test('a note added to a recorded report: removing it comes first everywhere, and removing it restores the records', async t => {
  const f = await atPhase03(t);
  installGuardrails(f.root, kitRoot);
  // The guardrails deny the git commands an undo might reach for.
  assert.match(guardrailDecision({ toolName: 'bash', toolArgs: { command: 'git restore migration/judge-report.md' }, cwd: f.root }), /"git restore" is denied/);
  writeLater(f.root, report, noted);
  const next = phaseCommand(f.root, f.config, 'next');
  assert.equal(next.next, '00b');
  assert.equal(next.stale.action, 'record-again');
  assert.equal(next.stale.reportsOnly, true);
  assert.deepEqual(next.stale.reasons.map(r => [r.kind, r.files]), [['evidence', [report]]]);
  assert.deepEqual(next.stale.later, ['01', '02']);
  assert.equal(next.stale.pilots, undefined, 'no pilot was prepared');
  // Removing comes before recording again, and auto mode is told to do it.
  assert.match(next.stale.next, new RegExp(`^Phase 00b was recorded, then migration/judge-report\\.md changed; the source files, settings and verification files did not\\. If you made that edit only to note progress or a later result \\(such as the formal judge outcome\\), ${removeFirst.source}.*this record is then current again without recording anything, and so are the later ones unless something else changed in them \\(phase next shows it\\)\\. Otherwise, or if phase next still shows this record out of date, check only that change .*then record again with phase complete 00b --note TEXT .*then phases 01, 02 in order\\. This is not a new review of the whole phase\\. In auto mode do this without asking`));
  assert.ok(next.stale.next.indexOf('first remove') < next.stale.next.indexOf('record again with'));
  // The formal judge does not depend on the report.
  assert.ok(judgeCurrent(f));
  // A gate reached first (phase start 03) names the cause, 00b, with the same text.
  const gate = gateError(() => phaseCommand(f.root, f.config, 'start', '03'));
  assert.match(gate.message, /^Phase 02's record is out of date because phase 00b's record is\. Phase 00b was recorded, then migration\/judge-report\.md changed/);
  assert.match(gate.message, removeFirst);
  assert.doesNotMatch(gate.message, /only phase 01's record/);
  assert.match(gateError(() => requirePhase(f.root, f.config, '01')).message, /^Phase 01's record is out of date because phase 00b's record is\./);
  // The phase-order guidance recommends removing the note.
  const guide = failureGuidance(gate, { root: f.root, language: 'en' });
  assert.equal(guide.id, 'phase-order');
  assert.equal(guide.recommended, 'remove-report-note');
  assert.match(guide.options[0].label, /If only a note was added to phase 00b's report, remove it \(nothing is recorded again\)/);
  assert.match(guide.options[0].reason, /Do not use git restore/);
  assert.equal(failureGuidance(gate, { root: f.root, language: 'ja' }).options[0].label, '工程 00b の報告に足したメモだけなら、それを取り除く（記録し直しは不要）');
  // The fast view flags the file while it differs.
  assert.deepEqual(statusSnapshot(f.root).workflow.changedSinceRecord, [{ phase: '00b', files: [report] }]);
  // A removal that is not byte for byte (line endings changed) leaves the
  // record out of date, and the same text then says to record again.
  writeLater(f.root, report, deferred.replace(/\n/g, '\r\n'));
  const crlf = phaseCommand(f.root, f.config, 'next');
  assert.equal(crlf.next, '00b');
  assert.match(crlf.stale.next, /Otherwise, or if phase next still shows this record out of date, check only that change/);
  // Removing the note exactly: every record is current again, nothing recorded.
  const before = receipts(f.root, ['00b', '01', '02']);
  writeLater(f.root, report, deferred);
  const back = phaseCommand(f.root, f.config, 'next');
  assert.equal(back.next, '03');
  assert.equal(back.stale, undefined);
  assert.deepEqual(receipts(f.root, ['00b', '01', '02']), before);
  assert.ok(judgeCurrent(f));
  // The fast view no longer flags the report: its bytes are the recorded ones.
  const fast = statusSnapshot(f.root);
  assert.equal(fast.workflow.changedSinceRecord, undefined);
  assert.ok(!fast.nextActions.some(a => /Files changed after phase/.test(a)));
  assert.equal(fast.phases.find(p => p.id === '00b').status, 'recorded (not revalidated)');
});

test('no removal hint once a later record no longer names the one before it', async t => {
  const f = await atPhase03(t);
  // The note is recorded with 00b only: 01 and 02 must be recorded again
  // whatever is removed, so taking the note out is not offered as the way.
  atomicWrite(safePath(f.root, report), noted);
  phaseCommand(f.root, f.config, 'complete', '00b', { note: 'Judge result noted in the report; plan unchanged' });
  atomicWrite(safePath(f.root, report), deferred);
  const removed = phaseStaleness(f.root, f.config, '00b');
  assert.deepEqual(removed.reasons.map(r => r.kind), ['evidence']);
  assert.equal(removed.reportsOnly, undefined);
  assert.doesNotMatch(removed.next, /remove exactly/);
  assert.match(removed.next, /Check only that change.*then record again with phase complete 00b --note TEXT/);
  // A phase whose own report changed after its predecessor was recorded again
  // gets no hint either (removing would not make it current).
  atomicWrite(safePath(f.root, report), noted);
  const depmap = 'migration/depmap/report.md', map = fs.readFileSync(safePath(f.root, depmap), 'utf8');
  atomicWrite(safePath(f.root, depmap), `${map}Formal judge passed.\n`);
  const one = phaseStaleness(f.root, f.config, '01');
  assert.deepEqual(one.reasons.map(r => r.kind).sort(), ['evidence', 'predecessor']);
  assert.equal(one.reportsOnly, undefined);
  assert.doesNotMatch(one.next, /remove exactly/);
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '01');
  // The gate names 01 as the cause, without the hint.
  const gate = gateError(() => requirePhase(f.root, f.config, '02'));
  assert.match(gate.message, /^Phase 02's record is out of date because phase 01's record is\. /);
  assert.doesNotMatch(gate.message, /remove exactly/);
  assert.notEqual(failureGuidance(gate, { root: f.root, language: 'en' }).recommended, 'remove-report-note');
});

test('a pilot prepared on phase 02: named, kept by removing the note, ended by recording again', async t => {
  const f = await atPhase03(t), child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable trial of one file' });
  const config = loadConfig(child), real = fs.realpathSync(child);
  assert.ok(requirePilot(child, config));
  atomicWrite(safePath(f.root, report), noted);
  // The pilot says what to do instead of only asking for a new one.
  const error = gateError(() => requirePilot(child, config));
  assert.equal(error.code, 'pilot-parent-stale');
  assert.match(error.message, new RegExp(`^Pilot parent phase 02 is out of date since this pilot was prepared: in ${escape(fs.realpathSync(f.root))}, migration/judge-report\\.md changed after phase 00b was recorded\\. If that edit only noted progress or a later result \\(such as the formal judge outcome\\), remove exactly what was added with a file edit tool, not git, and this pilot works again; phase next in .* says the same\\. Recording those phases again instead ends this pilot \\(pilot prepare and pilot run again\\)\\.$`));
  // So does its status.
  const pilotStatus = migrationStatus(child);
  assert.equal(pilotStatus.nextActions.length, 1);
  assert.match(pilotStatus.nextActions[0], /^Bring the parent project .* up to date as its phase next says \(if it says to remove a note added to a report, that keeps this pilot\)/);
  assert.ok(!pilotStatus.nextActions.some(a => /Prepare a new authorized pilot/.test(a)));
  const stale = phaseCommand(f.root, f.config, 'next').stale;
  assert.deepEqual(stale.pilots, [real]);
  assert.match(stale.next, new RegExp(`Recording phase 02 again ends the pilot prepared at ${escape(real)} \\(pilot prepare and pilot run again\\); removing the note does not\\.`));
  // A pilot that has already ended is not named: its judge receipt changed,
  // or its copied grant no longer matches the parent's.
  const judgeFile = safePath(f.root, 'migration/results/judge.json'), judgeBytes = fs.readFileSync(judgeFile);
  const reformatted = `${JSON.stringify(JSON.parse(judgeBytes.toString('utf8')), null, 1)}\n`;
  assert.notEqual(reformatted, judgeBytes.toString('utf8'));
  atomicWrite(judgeFile, reformatted);
  assert.equal(phaseCommand(f.root, f.config, 'next').stale.pilots, undefined);
  assert.throws(() => requirePilot(child, config), /Pilot parent preparation or judge changed; prepare a new isolated pilot/);
  atomicWrite(judgeFile, judgeBytes);
  const grantFile = safePath(child, 'migration/pilot.json'), grantBytes = fs.readFileSync(grantFile);
  atomicWrite(grantFile, `${grantBytes.toString('utf8')}\n`);
  assert.equal(phaseCommand(f.root, f.config, 'next').stale.pilots, undefined);
  atomicWrite(grantFile, grantBytes);
  assert.deepEqual(phaseCommand(f.root, f.config, 'next').stale.pilots, [real]);
  // Removing the note: the pilot works again.
  atomicWrite(safePath(f.root, report), deferred);
  assert.ok(requirePilot(child, config));
  // Recording 00b with the note: 01 and 02 must be recorded again anyway, so
  // the pilot no longer suggests removing it, and nothing names the pilot.
  atomicWrite(safePath(f.root, report), noted);
  phaseCommand(f.root, f.config, 'complete', '00b', { note: 'Judge result noted in the report; plan unchanged' });
  assert.throws(() => requirePilot(child, config), /^Error: Pilot parent phase 02 is out of date since this pilot was prepared; phase next in .* says what to record again, which ends this pilot \(pilot prepare and pilot run again\)\.$/);
  atomicWrite(safePath(f.root, report), deferred);
  assert.equal(phaseStaleness(f.root, f.config, '00b').pilots, undefined);
  atomicWrite(safePath(f.root, report), noted);
  // Recording again: the records are current, the pilot has ended.
  for (const id of ['01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Recorded again after 00b' });
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '03');
  assert.throws(() => requirePilot(child, config), /Pilot parent preparation or judge changed; prepare a new isolated pilot/);
  assert.ok(judgeCurrent(f));
  // A later note no longer names the ended pilot.
  atomicWrite(safePath(f.root, report), `${noted}Another note.\n`);
  assert.equal(phaseCommand(f.root, f.config, 'next').stale.pilots, undefined);
});

test('only report edits get the hint; a removed pilot workspace or unreadable pilots are not named', async t => {
  const f = await atPhase03(t);
  assert.deepEqual(phaseReports, ['migration/feasibility.md', 'migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md', 'migration/stress-test/report.md']);
  assert.equal(phaseReports, coreReports, 'one list for phase next and the fast view');
  // feasibility.md is 00's report: everything after it is named, with the hint.
  const feasibility = fs.readFileSync(safePath(f.root, 'migration/feasibility.md'), 'utf8');
  atomicWrite(safePath(f.root, 'migration/feasibility.md'), `${feasibility}Formal judge passed.\n`);
  const zero = phaseCommand(f.root, f.config, 'next').stale;
  assert.equal(zero.phase, '00'); assert.equal(zero.reportsOnly, true);
  assert.deepEqual(zero.later, ['00b', '01', '02']);
  assert.match(zero.next, removeFirst);
  atomicWrite(safePath(f.root, 'migration/feasibility.md'), feasibility);
  // manifest.tsv is not a report: no hint (its change is real input).
  const manifest = fs.readFileSync(safePath(f.root, 'migration/manifest.tsv'), 'utf8');
  const changed = manifest.endsWith('\n') ? `${manifest.slice(0, -1)}\r\n` : `${manifest}\r\n`;
  assert.notEqual(changed, manifest);
  atomicWrite(safePath(f.root, 'migration/manifest.tsv'), changed);
  const map = phaseStaleness(f.root, f.config, '01');
  assert.equal(map.action, 'record-again');
  assert.equal(map.reportsOnly, undefined);
  assert.doesNotMatch(map.next, /remove exactly/);
  atomicWrite(safePath(f.root, 'migration/manifest.tsv'), manifest);
  // A source change is redone, never removed by the hint.
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), '# changed\n');
  const source = phaseCommand(f.root, f.config, 'next').stale;
  assert.equal(source.action, 'redo');
  assert.equal(source.reportsOnly, undefined);
  assert.doesNotMatch(source.next, /remove exactly/);
  // A pilot whose workspace was removed after the trial is not named.
  const g = await atPhase03(t), child = `${g.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(g.root, g.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable trial of one file' });
  fs.rmSync(child, { recursive: true, force: true });
  atomicWrite(safePath(g.root, report), noted);
  const gone = phaseCommand(g.root, g.config, 'next').stale;
  assert.equal(gone.reportsOnly, true);
  assert.equal(gone.pilots, undefined);
  assert.doesNotMatch(gone.next, /ends the pilot/);
  // An unreadable pilots path does not hide the explanation.
  fs.rmSync(safePath(g.root, 'migration/pilots'), { recursive: true, force: true });
  fs.writeFileSync(safePath(g.root, 'migration/pilots'), 'not a directory\n');
  const odd = phaseCommand(g.root, g.config, 'next').stale;
  assert.equal(odd.reportsOnly, true);
  assert.equal(odd.pilots, undefined);
  assert.match(odd.next, removeFirst);
  // Phase 03's own report after 03 is recorded: 02 is not recorded again, so no pilot is named.
  const h = await atPhase03(t);
  atomicWrite(safePath(h.root, 'migration/stress-test/report.md'), 'Stress test report.\n');
  installGuardrails(h.root, kitRoot, { waiver: 'Test fixture: disposable sandbox, no real commands' });
  phaseCommand(h.root, h.config, 'start', '03');
  assert.ok(readJSON(safePath(h.root, 'migration/phases/starts/03.json')).executionId);
  phaseCommand(h.root, h.config, 'complete', '03', { note: 'Fixture stress test reviewed' });
  atomicWrite(safePath(h.root, 'migration/stress-test/report.md'), 'Stress test report.\nLater note.\n');
  const three = phaseCommand(h.root, h.config, 'next').stale;
  assert.equal(three.phase, '03'); assert.equal(three.reportsOnly, true);
  assert.equal(three.later, undefined);
  assert.equal(three.pilots, undefined);
});

test('a source-only source-as-spec project, as in the incident: the package is named and removing the note keeps it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-edit-spec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double', preparationProfile: 'source-as-spec' });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  atomicWrite(safePath(root, 'tests/README.md'), 'No original runtime; contracts live in migration/source-spec.\n');
  let config = loadConfig(root);
  initSourceSpec(root, config, { apply: true }); config = loadConfig(root);
  assert.equal(config.verificationMode, 'source-only');
  phaseCommand(root, config, 'init');
  atomicWrite(safePath(root, 'migration/feasibility.md'), 'Three files; no original runtime or spec.\n');
  phaseCommand(root, config, 'complete', '00', { note: 'User reviewed feasibility' });
  atomicWrite(safePath(root, report), 'Source-derived contracts for three files; equivalence unverified.\n');
  atomicWrite(safePath(root, 'migration/depmap/edges.tsv'), 'from\tto\nsrc/main.py\tsrc/math_ops.py\nsrc/main.py\tsrc/text_ops.py\n');
  atomicWrite(safePath(root, 'migration/depmap/order.txt'), 'src/math_ops.py\tsrc/text_ops.py\nsrc/main.py\n');
  atomicWrite(safePath(root, 'migration/depmap/report.md'), 'Python parser over src; no unsupported syntax.\n');
  atomicWrite(safePath(root, 'migration/gap-report.md'), 'Floor division and code-point length decided from source.\n');
  atomicWrite(safePath(root, 'migration/manifest.tsv'), 'source\ttarget\nsrc/math_ops.py\tported/math_ops.mjs\nsrc/text_ops.py\tported/text_ops.mjs\nsrc/main.py\tported/main.mjs\n');
  atomicWrite(safePath(root, 'migration/review-dependencies.json'), JSON.stringify({ schemaVersion: 1, dependencies: {
    'src/math_ops.py': [], 'src/text_ops.py': [], 'src/main.py': ['src/math_ops.py', 'src/text_ops.py'] } }));
  atomicWrite(safePath(root, 'migration/RULEBOOK.md'), '# Rules drafted from source\nPreserve floor division and code-point lengths.\n');
  atomicWrite(safePath(root, 'migration/inventory.tsv'), 'file\tissue\tdecision\nsrc/math_ops.py\tnegative division\tfloor\n');
  phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User reviewed the specification package' });
  assert.equal((await runStage(root, config, 'judge')).success, true);
  assert.equal(migrationStatus(root).workflow.next, '03');
  const original = fs.readFileSync(safePath(root, report), 'utf8');
  atomicWrite(safePath(root, report), `${original}Formal judge: passed.\n`);
  const next = phaseCommand(root, config, 'next');
  assert.equal(next.next, '00b');
  assert.equal(next.stale.record, 'phase complete 00b,01,02 --note TEXT');
  assert.equal(next.stale.reportsOnly, true);
  assert.match(next.stale.next, removeFirst);
  assert.match(next.stale.next, /record again with phase complete 00b,01,02 --note TEXT/);
  const gate = gateError(() => phaseCommand(root, config, 'start', '03'));
  assert.match(gate.message, /^Phase 02's record is out of date because phase 00b's record is\./);
  assert.equal(failureGuidance(gate, { root, language: 'en' }).recommended, 'remove-report-note');
  atomicWrite(safePath(root, report), original);
  assert.equal(phaseCommand(root, config, 'next').next, '03');
});

test('the prompts and docs keep progress notes out of recorded reports and say how to remove one', () => {
  const b = kitText('prompts/00b-judge-setup.md');
  assert.doesNotMatch(b, /deferred formal validation/, 'no pending-judge line that goes stale after 02');
  assert.match(b, /The formal judge runs after 02:\s+its receipt is `migration\/results\/judge\.json` and phase 03's report states its\s+result\. Write no pending-judge status here and never come back to update this\s+file for it: the 00b record binds the file/);
  const three = kitText('prompts/03-stress-test.md');
  assert.match(three, /State the formal judge result there\. Never edit the reports of recorded phases\s+\(feasibility\.md, judge-report\.md, depmap\/report\.md, gap-report\.md\) to note\s+progress or a result/);
  assert.match(three, /If you added a note by mistake,\s+remove exactly what you added with the file edit tool \(not git, which the\s+guardrails deny\): nothing is recorded again\./);
  const handoff = kitText('docs/PHASE-HANDOFF.md');
  assert.match(handoff, /A recorded phase's reports are its evidence: the record binds their bytes\. Never\s+edit/);
  assert.match(handoff, /authorization as required by the runner \(a recorded phase's report only to correct it,\s+never to note progress or a result/);
  assert.match(handoff, /For a report of 00 to 02 a prepared pilot cannot run\s+until the edit is undone, and recording again ends it/);
  assert.match(handoff, /removing exactly what was added\s+with a file edit \(byte for byte, line endings included; not git, which the\s+guardrails may deny\)/);
  for (const skill of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = kitText(skill);
    assert.match(text, /Never edit a recorded phase's report \(feasibility\.md, judge-report\.md,\s+depmap\/report\.md, gap-report\.md; stress-test\/report\.md once 03 is recorded\) to\s+note progress or a later result/, skill);
    assert.match(text, /\(for a report of 00 to 02 a prepared pilot cannot run until it is undone,\s+and recording again ends it\)\. Removing an added note byte for byte, with the\s+file edit tool rather than git, makes the record current again/, skill);
    // Auto mode is not told to record again before removing a note.
    assert.match(text, /Follow `stale\.next`: when only a report\s+changed it first says to remove a note you added \(with the file edit tool, not\s+git\), else to record again \(or redo\)\. In auto mode do that without asking;/, skill);
    assert.doesNotMatch(text, /in auto mode record again\s+\(or redo\) without asking/, skill);
  }
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.md'), /\| 1 \| 00〜02 の記録と judge の成功を確認する。judge の結果は 03 の報告に書き/);
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.en.md'), /\| 1 \| Confirm 00–02 are recorded and judge succeeded\. State the judge result in the 03 report/);
  // The gate error at 03 leads to the row that removes the note, and judge is
  // rerun only when it is out of date (rerunning ends a prepared pilot).
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.md'), /`Phase 02's record is out of date because phase 00b's record is`/);
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.en.md'), /`Phase 02's record is out of date because phase 00b's record is`/);
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.md'), /`judge` の再実行は、その後 `Run judge successfully for these inputs` と出たときだけ/);
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.en.md'), /Rerun `judge` only if it then says `Run judge successfully for these inputs`/);
  assert.match(kitText('docs/ORDERED-WORKFLOW.md'), /記録済みの工程の報告（feasibility\.md・judge-report\.md/);
  assert.match(kitText('docs/ORDERED-WORKFLOW.en.md'), /Never edit a recorded phase's report \(feasibility\.md, judge-report\.md/);
  for (const doc of ['docs/PHASE-HANDOFF.md', 'docs/ORDERED-WORKFLOW.en.md', 'skills/code-migration/SKILL.md', 'prompts/03-stress-test.md']) {
    assert.doesNotMatch(kitText(doc), /every later one be recorded again and ends a prepared pilot/, doc);
    assert.doesNotMatch(kitText(doc), /undo it exactly/, doc);
  }
});
