// SPDX-License-Identifier: Apache-2.0
// 0.41.1: on 2026-11-01 (Windows, kit 0.40.0, auto mode) phase 03 had just
// started when the agent added the formal judge result to judge-report.md,
// which phase 00b's prompt had told it to fill with "any deferred formal
// validation". The 00b record binds that file, so 00b to 02 had to be recorded
// again; after pilot prepare the same edit would also have ended the pilot.
// The prompts now keep such notes out of recorded reports, and the guidance
// says that undoing a note restores the records and does not end the pilot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, contextHash, loadConfig } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { phaseStaleness, phaseReports } from '../lib/phases.mjs';
import { runStage, currentRecord } from '../lib/pipeline.mjs';
import { preparePilot, requirePilot } from '../lib/pilot.mjs';
import { installGuardrails } from '../lib/guardrails.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kitText = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');
const report = 'migration/judge-report.md';
const deferred = '# Judge report\nScope: three files. Formal judge: deferred until after phase 02.\n';
const noted = '# Judge report\nScope: three files. Formal judge: passed (preparation validated, equivalence unverified).\n';

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

test('a note added to a recorded report: phase next says to undo it, and undoing restores the records', async t => {
  const f = await atPhase03(t);
  atomicWrite(safePath(f.root, report), noted);
  const next = phaseCommand(f.root, f.config, 'next');
  assert.equal(next.next, '00b');
  assert.equal(next.stale.action, 'record-again');
  assert.equal(next.stale.reportsOnly, true);
  assert.deepEqual(next.stale.reasons.map(r => [r.kind, r.files]), [['evidence', [report]]]);
  assert.deepEqual(next.stale.later, ['01', '02']);
  assert.equal(next.stale.pilots, undefined, 'no pilot was prepared');
  assert.match(next.stale.next, /If the edit only notes progress or a later result \(such as the formal judge outcome\), undo it exactly instead \(byte for byte, line endings included\).*nothing is recorded again\. If phase next still shows this record out of date, record again as above\./);
  // The 0.26.0 wording stays, in the same order.
  assert.match(next.stale.next, /the source files, settings and verification files did not\. Check only that change.*not a new review of the whole phase\. In auto mode do this without asking/);
  // The formal judge does not depend on the report.
  assert.ok(judgeCurrent(f));
  assert.throws(() => phaseCommand(f.root, f.config, 'start', '03'), /Phase 02's record is out of date/);
  // A source-as-spec package names the whole package with the same hint.
  const spec = phaseStaleness(f.root, { ...f.config, preparationProfile: 'source-as-spec' }, '00b');
  assert.equal(spec.record, 'phase complete 00b,01,02 --note TEXT');
  assert.match(spec.next, /undo it exactly instead/);
  // An undo that is not byte for byte (line endings changed) leaves the record
  // out of date, and the same text says to record again then.
  atomicWrite(safePath(f.root, report), deferred.replace(/\n/g, '\r\n'));
  const crlf = phaseCommand(f.root, f.config, 'next');
  assert.equal(crlf.next, '00b');
  assert.match(crlf.stale.next, /If phase next still shows this record out of date, record again as above\./);
  // Undoing the note exactly: every record is current again, nothing recorded.
  const receipts = ['00b', '01', '02'].map(id => fs.readFileSync(safePath(f.root, `migration/phases/${id}.json`), 'utf8'));
  atomicWrite(safePath(f.root, report), deferred);
  const back = phaseCommand(f.root, f.config, 'next');
  assert.equal(back.next, '03');
  assert.equal(back.stale, undefined);
  assert.deepEqual(['00b', '01', '02'].map(id => fs.readFileSync(safePath(f.root, `migration/phases/${id}.json`), 'utf8')), receipts);
  assert.ok(judgeCurrent(f));
  // A phase whose predecessor was recorded again is not current after an undo
  // of its own report, so it gets no undo hint.
  const depmap = 'migration/depmap/report.md', map = fs.readFileSync(safePath(f.root, depmap), 'utf8');
  atomicWrite(safePath(f.root, report), noted);
  atomicWrite(safePath(f.root, depmap), `${map}Formal judge passed.\n`);
  phaseCommand(f.root, f.config, 'complete', '00b', { note: 'Judge result noted in the report; plan unchanged' });
  const one = phaseStaleness(f.root, f.config, '01');
  assert.deepEqual(one.reasons.map(r => r.kind).sort(), ['evidence', 'predecessor']);
  assert.equal(one.reportsOnly, undefined);
  assert.doesNotMatch(one.next, /undo it exactly/);
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '01');
});

test('a pilot prepared on phase 02: the note names it, undoing keeps it, recording again ends it', async t => {
  const f = await atPhase03(t), child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable trial of one file' });
  const config = loadConfig(child), real = fs.realpathSync(child);
  assert.ok(requirePilot(child, config));
  atomicWrite(safePath(f.root, report), noted);
  // The pilot explains itself instead of only asking for a new one.
  assert.throws(() => requirePilot(child, config), /Pilot parent phase 02 is out of date.*phase next in .* says why\. If only a note was added to a report of phases 00 to 02.*undo it exactly \(byte for byte\) and this pilot works again\. Recording those phases again instead, as phase next says when undoing is not enough, ends this pilot/s);
  const stale = phaseCommand(f.root, f.config, 'next').stale;
  assert.deepEqual(stale.pilots, [real]);
  assert.match(stale.next, new RegExp(`Recording phase 02 again ends the pilot prepared at ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(pilot prepare and pilot run again\\); undoing the edit does not end it\\.`));
  // A pilot whose judge receipt changed has already ended: it is not named.
  const judgeFile = safePath(f.root, 'migration/results/judge.json'), judgeBytes = fs.readFileSync(judgeFile);
  const reformatted = `${JSON.stringify(JSON.parse(judgeBytes.toString('utf8')), null, 1)}\n`;
  assert.notEqual(reformatted, judgeBytes.toString('utf8'));
  atomicWrite(judgeFile, reformatted);
  assert.equal(phaseCommand(f.root, f.config, 'next').stale.pilots, undefined);
  assert.throws(() => requirePilot(child, config), /Pilot parent preparation or judge changed; prepare a new isolated pilot/);
  atomicWrite(judgeFile, judgeBytes);
  assert.deepEqual(phaseCommand(f.root, f.config, 'next').stale.pilots, [real]);
  // Undo: the pilot works again.
  atomicWrite(safePath(f.root, report), deferred);
  assert.ok(requirePilot(child, config));
  // Recording again instead: the records are current, the pilot has ended.
  atomicWrite(safePath(f.root, report), noted);
  phaseCommand(f.root, f.config, 'complete', '00b', { note: 'Judge result noted in the report; plan unchanged' });
  for (const id of ['01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Recorded again after 00b' });
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '03');
  assert.throws(() => requirePilot(child, config), /Pilot parent preparation or judge changed; prepare a new isolated pilot/);
  assert.ok(judgeCurrent(f));
  // A later note no longer names the ended pilot.
  atomicWrite(safePath(f.root, report), `${noted}Another note.\n`);
  assert.equal(phaseCommand(f.root, f.config, 'next').stale.pilots, undefined);
});

test('only report edits get the undo hint; a finished pilot workspace is not named', async t => {
  const f = await atPhase03(t);
  assert.deepEqual(phaseReports, ['migration/feasibility.md', 'migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md', 'migration/stress-test/report.md']);
  // feasibility.md is 00's report: everything after it is named, with the hint.
  const feasibility = fs.readFileSync(safePath(f.root, 'migration/feasibility.md'), 'utf8');
  atomicWrite(safePath(f.root, 'migration/feasibility.md'), `${feasibility}Formal judge passed.\n`);
  const zero = phaseCommand(f.root, f.config, 'next').stale;
  assert.equal(zero.phase, '00'); assert.equal(zero.reportsOnly, true);
  assert.deepEqual(zero.later, ['00b', '01', '02']);
  assert.match(zero.next, /undo it exactly instead/);
  atomicWrite(safePath(f.root, 'migration/feasibility.md'), feasibility);
  // manifest.tsv is not a report: no hint (its change is real input).
  const manifest = fs.readFileSync(safePath(f.root, 'migration/manifest.tsv'), 'utf8');
  const changed = manifest.endsWith('\n') ? `${manifest.slice(0, -1)}\r\n` : `${manifest}\r\n`;
  assert.notEqual(changed, manifest);
  atomicWrite(safePath(f.root, 'migration/manifest.tsv'), changed);
  const map = phaseStaleness(f.root, f.config, '01');
  assert.equal(map.action, 'record-again');
  assert.equal(map.reportsOnly, undefined);
  assert.doesNotMatch(map.next, /undo it exactly/);
  atomicWrite(safePath(f.root, 'migration/manifest.tsv'), manifest);
  // A source change is redone, never undone by the hint.
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), '# changed\n');
  const source = phaseCommand(f.root, f.config, 'next').stale;
  assert.equal(source.action, 'redo');
  assert.equal(source.reportsOnly, undefined);
  assert.doesNotMatch(source.next, /undo it exactly/);
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
  assert.match(odd.next, /undo it exactly instead/);
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

test('the prompts keep progress notes out of recorded reports', () => {
  const b = kitText('prompts/00b-judge-setup.md');
  assert.doesNotMatch(b, /deferred formal validation/, 'no pending-judge line that goes stale after 02');
  assert.match(b, /The formal judge runs after 02:\s+its receipt is `migration\/results\/judge\.json` and phase 03's report states its\s+result\. Write no pending-judge status here and never come back to update this\s+file for it: the 00b record binds the file/);
  assert.match(kitText('prompts/03-stress-test.md'), /State the formal judge result there\. Never edit the reports of recorded phases\s+\(feasibility\.md, judge-report\.md, depmap\/report\.md, gap-report\.md\) to note\s+progress or a result/);
  assert.match(kitText('docs/PHASE-HANDOFF.md'), /A recorded phase's reports are its evidence: the record binds their bytes\. Never\s+edit/);
  assert.match(kitText('docs/PHASE-HANDOFF.md'), /refresh the current phase's report and the\s+authorization as required by the runner \(never a recorded phase's report/);
  assert.match(kitText('docs/PHASE-HANDOFF.md'), /an edit to a report of 00 to 02 also ends a prepared\s+pilot/);
  for (const doc of ['docs/PHASE-HANDOFF.md', 'docs/ORDERED-WORKFLOW.en.md', 'skills/code-migration/SKILL.md']) assert.doesNotMatch(kitText(doc), /every later one be recorded again and ends a prepared pilot/, doc);
  for (const skill of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    assert.match(kitText(skill), /Never edit a recorded phase's report \(feasibility\.md, judge-report\.md,\s+depmap\/report\.md, gap-report\.md; stress-test\/report\.md once 03 is recorded\) to\s+note progress or a later result/, skill);
    assert.match(kitText(skill), /be recorded\s+again \(a report of 00 to 02 also ends a prepared pilot\); undoing an added note\s+byte for byte makes the record current again/, skill);
  }
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.md'), /\| 1 \| 00〜02 の記録と judge の成功を確認する。judge の結果は 03 の報告に書き/);
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.en.md'), /\| 1 \| Confirm 00–02 are recorded and judge succeeded\. State the judge result in the 03 report/);
  assert.match(kitText('docs/STRESS-TEST-CHECKLIST.md'), /`Pilot parent phase 02 is out of date` \| 記録済みの報告/);
  assert.match(kitText('docs/ORDERED-WORKFLOW.md'), /記録済みの工程の報告（feasibility\.md・judge-report\.md/);
  assert.match(kitText('docs/ORDERED-WORKFLOW.en.md'), /Never edit a recorded phase's report \(feasibility\.md, judge-report\.md/);
});
