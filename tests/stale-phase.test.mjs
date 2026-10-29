// SPDX-License-Identifier: Apache-2.0
// 0.26.0: a pilot fix changed a file 01 had recorded. status --fast still
// showed 4/10, phase next said "done: 2, next: 01" without a reason, and the
// host asked an unclear three-way question. A recorded phase that is out of
// date now says what changed and whether anything must be redone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { phaseStaleness, requirePhase } from '../lib/phases.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { failureGuidance } from '../lib/guidance.mjs';

const write = (f, name, value) => atomicWrite(safePath(f.root, name), value);
function recorded(t) {
  const f = prepare(t, { count: 3 });
  f.config.phasePolicy = 'strict';
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) write(f, name, 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '03');
  return f;
}
// A file written after the record, with an mtime the fast view can see.
const later = (f, name, value) => { write(f, name, value); const t = new Date(Date.now() + 5000); fs.utimesSync(safePath(f.root, name), t, t); };

test('an artifact changed after its record: check that change and record again, with the file named', t => {
  const f = recorded(t);
  later(f, 'migration/depmap/report.md', 'Updated after the pilot fix.\n');
  const next = phaseCommand(f.root, f.config, 'next');
  assert.equal(next.next, '01');
  assert.equal(next.stale.action, 'record-again');
  assert.deepEqual(next.stale.reasons.map(r => r.kind), ['evidence']);
  assert.deepEqual(next.stale.reasons[0].files, ['migration/depmap/report.md']);
  assert.equal(next.stale.record, 'phase complete 01 --note TEXT');
  assert.deepEqual(next.stale.later, ['02'], 'phases recorded after it are named');
  assert.match(next.stale.next, /the source files, settings and verification files did not\. Check only that change.*not a new review of the whole phase\. In auto mode do this without asking/);
  assert.match(phaseCommand(f.root, f.config, 'check', '01').stale.next, /migration\/depmap\/report\.md changed/);
  assert.throws(() => requirePhase(f.root, f.config, '01'), /record is out of date.*depmap\/report\.md changed/s);
  // The fast view does not hash, but it no longer says only "recorded".
  const fast = statusSnapshot(f.root);
  assert.deepEqual(fast.workflow.changedSinceRecord, [{ phase: '01', files: ['migration/depmap/report.md'] }]);
  assert.match(fast.phases.find(p => p.id === '01').status, /files changed since/);
  assert.ok(fast.nextActions.some(a => /Run phase next.*workflow\.stale\.next/.test(a)));
  // Recording again in order brings the workflow back to 03.
  phaseCommand(f.root, f.config, 'complete', '01', { note: 'Report updated by the pilot fix; graph unchanged' });
  assert.equal(phaseCommand(f.root, f.config, 'next').stale.phase, '02');
  assert.deepEqual(phaseCommand(f.root, f.config, 'next').stale.reasons.map(r => r.kind), ['predecessor']);
  phaseCommand(f.root, f.config, 'complete', '02', { note: 'Recorded again after 01' });
  const done = phaseCommand(f.root, f.config, 'next');
  assert.equal(done.next, '03'); assert.equal(done.stale, undefined);
});

test('a changed source file means redo, and a source-as-spec package records together', t => {
  const f = recorded(t);
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), '# changed\n');
  const next = phaseCommand(f.root, f.config, 'next');
  assert.equal(next.next, '00');
  assert.equal(next.stale.action, 'redo');
  assert.ok(next.stale.reasons.some(r => r.kind === 'source' && !r.unsure));
  assert.match(next.stale.next, /may no longer hold\. Run phase start 00 and follow its prompt/);
  const g = recorded(t);
  later(g, 'migration/manifest.tsv', fs.readFileSync(safePath(g.root, 'migration/manifest.tsv'), 'utf8').replace(/\n$/, '\r\n'));
  const spec = { ...g.config, preparationProfile: 'source-as-spec' };
  const stale = phaseStaleness(g.root, spec, '01');
  assert.equal(stale.record, 'phase complete 01,02 --note TEXT');
  assert.equal(stale.later, undefined, '02 is recorded in the same command');
});

test('02 names the changed input part; a record without parts still explains itself', t => {
  const f = recorded(t);
  later(f, 'migration/RULEBOOK.md', `${fs.readFileSync(safePath(f.root, 'migration/RULEBOOK.md'), 'utf8')}Keep error messages.\n`);
  const stale = phaseCommand(f.root, f.config, 'next').stale;
  assert.equal(stale.phase, '02'); assert.equal(stale.action, 'record-again');
  assert.ok(stale.reasons.some(r => r.kind === 'evidence' && r.files.includes('migration/RULEBOOK.md')));
  assert.ok(stale.reasons.some(r => r.part === 'artifacts'));
  // Records made before 0.26.0 carry no parts: the reason says it is unsure.
  for (const id of ['00', '02']) {
    const file = safePath(f.root, `migration/phases/${id}.json`), r = readJSON(file);
    delete r.foundationParts; delete r.contextParts; writeJSON(file, r);
  }
  const old = phaseStaleness(f.root, f.config, '02');
  assert.ok(old.reasons.some(r => r.unsure && r.kind === 'recorded-input'));
  assert.equal(old.action, 'record-again', 'no settings or verification file was written since: the kit changed');
  // A verification file written after an old record means redo, even when committed.
  later(f, 'tests/judge.py', `${fs.readFileSync(safePath(f.root, 'tests/judge.py'), 'utf8')}# changed\n`);
  const verified = phaseStaleness(f.root, f.config, '02');
  assert.equal(verified.action, 'redo');
  assert.ok(verified.reasons.some(r => r.unsure && r.files?.includes('tests/judge.py')));
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), '# changed\n');
  const unknown = phaseStaleness(f.root, f.config, '00');
  assert.equal(unknown.action, 'redo', 'without parts a changed foundation may be the source: redo');
  assert.ok(unknown.reasons.every(r => r.unsure));
  assert.equal(phaseStaleness(f.root, f.config, '03'), null, 'no record, nothing to explain');
});

test('settings and verification changes mean redo; host guidance still knows the gate', t => {
  const f = recorded(t);
  const changed = { ...f.config, targetLanguage: 'Go' };
  writeJSON(safePath(f.root, 'migration/config.json'), changed);
  const settings = phaseStaleness(f.root, changed, '00');
  assert.equal(settings.action, 'redo');
  assert.ok(settings.reasons.some(r => r.kind === 'settings' && !r.unsure));
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '03', 'restoring the setting restores the records');
  // A verification file is part of 02's approved inputs.
  fs.appendFileSync(safePath(f.root, 'tests/judge.py'), '# changed\n');
  const verification = phaseStaleness(f.root, f.config, '02');
  assert.equal(verification.action, 'redo');
  assert.ok(verification.reasons.some(r => r.part === 'judge'));
  // The new gate message keeps its phase-order guidance.
  // After 00b is redone for a judge change, 01 only waits on 00b's new record.
  const g0 = recorded(t);
  fs.appendFileSync(safePath(g0.root, 'tests/judge.py'), '# changed\n');
  assert.equal(phaseCommand(g0.root, g0.config, 'next').stale.action, 'redo');
  phaseCommand(g0.root, g0.config, 'complete', '00b', { note: 'Judge plan reviewed again for the changed test' });
  const cascade = phaseCommand(g0.root, g0.config, 'next').stale;
  assert.equal(cascade.phase, '01');
  assert.match(cascade.next, /only phase 00b's record .* changed\. Check that the new record of phase 00b/);
  const g = failureGuidance(new Error(`Phase 02's record is out of date. ${verification.next}`), { root: f.root });
  assert.equal(g.id, 'phase-order');
});

test('a malformed record is explained, and fast status survives it', t => {
  const f = recorded(t);
  const file = safePath(f.root, 'migration/phases/01.json'), r = readJSON(file);
  r.evidence.push(null);
  writeJSON(file, r);
  assert.doesNotThrow(() => statusSnapshot(f.root));
  fs.writeFileSync(file, '{ not json');
  const stale = phaseStaleness(f.root, f.config, '01');
  assert.equal(stale.reasons[0].kind, 'unreadable');
  assert.equal(stale.action, 'redo');
  // Legacy policy has no phase workflow to explain, so fast status does not point to it.
  const g = prepare(t, { count: 1 });
  later(g, 'migration/feasibility.md', 'changed\n');
  assert.equal(statusSnapshot(g.root).workflow.changedSinceRecord, undefined);
});
