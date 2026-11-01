// SPDX-License-Identifier: Apache-2.0
// 2026-11-01: in auto mode a phase 03 pilot chose 3 files and the kit added
// the 37 files they use, unasked: 40 files, about half a day on that PC.
// Upstream pilots the same three files as the bakeoff and adds nothing. A
// translation-only pilot without a unit typecheck does not need the files they
// use translated (the reviewers read their original sources), so in auto mode
// it keeps only the chosen files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, fake } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, loadConfig, readManifest } from '../lib/core.mjs';
import { runStage, runPilot } from '../lib/pipeline.mjs';
import { planPilot, preparePilot, requirePilot, pilotNeedsDependencies } from '../lib/pilot.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { setPreferences } from '../lib/preferences.mjs';

async function reviewed(t, { typecheck = false } = {}) {
  const f = prepare(t, { realCommands: true, count: 3 });
  f.config.phasePolicy = 'strict';
  if (!typecheck) f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  for (const p of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md'])
    atomicWrite(safePath(f.root, p), 'Disposable preparation fixture; not actual AI review or human signoff.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for boundary tests only' });
  await runStage(f.root, f.config, 'judge');
  return f;
}
const childPath = (t, f) => { const child = `${f.root}-pilot`; t.after(() => fs.rmSync(child, { recursive: true, force: true })); return child; };
const used = ['src/math_ops.py', 'src/text_ops.py'];

test('which pilots need the files they use translated', () => {
  assert.equal(pilotNeedsDependencies({ commands: {} }, 'translation'), false);
  assert.equal(pilotNeedsDependencies({ commands: { typecheck: null } }, 'translation'), false);
  assert.equal(pilotNeedsDependencies({ commands: { typecheck: ['tsc'] } }, 'translation'), true);
  for (const through of ['build', 'smoke', 'parity']) assert.equal(pilotNeedsDependencies({ commands: {} }, through), true, through);
});

test('in auto mode a translation-only pilot translates only the chosen files; reviewers still read the originals they use', async t => {
  const f = await reviewed(t), child = childPath(t, f);
  setPreferences(f.root, { phaseMode: 'auto' });
  const before = fs.readdirSync(safePath(f.root, 'migration')).sort();
  const plan = planPilot(f.root, f.config, { sources: ['src/main.py'] });
  assert.equal(plan.scopeKind, 'chosen-only');
  assert.deepEqual(plan.sources, ['src/main.py']);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.readOnly, used);
  assert.deepEqual(plan.counts, { requested: 1, added: 0, total: 1, readOnly: 2 });
  assert.match(plan.plain.ja, /選んだ 1 ファイルだけを/);
  assert.match(plan.plain.ja, /使っている 2 ファイルは変換せず、AIの確認で元のコードを読むだけ/);
  assert.match(plan.plain.ja, /ビルドや動作確認はしません/);
  assert.doesNotMatch(plan.plain.ja, /grant|target|translation|pilot/i);
  assert.match(plan.plain.en, /^Try only the chosen file in a copy outside the project\. In auto mode the 2 files used by it are not translated; /);
  assert.deepEqual(fs.readdirSync(safePath(f.root, 'migration')).sort(), before, 'plan writes nothing');

  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Auto mode: 1 chosen file', expectTotal: 1 });
  assert.deepEqual([grant.sources, grant.targets, grant.scopeKind, grant.readOnly], [['src/main.py'], ['ported/main.mjs'], 'chosen-only', plan.readOnly]);
  assert.deepEqual(readJSON(safePath(child, 'migration/pilot.json')).readOnly, plan.readOnly, 'the copy\'s grant names them too');
  const config = loadConfig(child);
  assert.deepEqual(readManifest(child, config).map(u => u.source), ['src/main.py']);
  // The originals of the files it uses are in the copy for the reviewers.
  for (const source of used) assert.ok(fs.existsSync(safePath(child, source)), source);

  const calls = [];
  const run = await runPilot(child, config, call => { calls.push({ role: call.role, target: call.unit.target, input: call.reviewInput }); return fake(call); });
  assert.equal(run.productionCompletion, false);
  assert.deepEqual([...new Set(calls.map(c => c.target))], ['ported/main.mjs']);
  assert.equal(calls.filter(c => c.role === 'implementer').length, 1);
  const reviews = calls.filter(c => c.role.startsWith('reviewer-'));
  assert.equal(reviews.length, 2);
  for (const review of reviews) {
    const paths = JSON.parse(review.input).files.map(file => file.path);
    for (const source of [...used, 'src/main.py', 'ported/main.mjs']) assert.ok(paths.includes(source), `${review.role} reads ${source}`);
    assert.ok(!paths.includes('ported/math_ops.mjs') && !paths.includes('ported/text_ops.mjs'), 'no translated file of the files it uses');
  }
  const translation = run.results.find(r => r.stage === 'translation').result;
  assert.deepEqual([translation.done, translation.total, translation.errors, translation.scopeComplete], [1, 1, [], true]);
  // Status counts the chosen file only and finds nothing missing.
  const status = migrationStatus(child);
  assert.deepEqual([status.purpose, status.done, status.total, status.blockers, status.workflow.policy], ['pilot', 1, 1, [], 'isolated-pilot']);
});

test('a pilot prepared before 0.42.0 (no scopeKind in its grant) still runs', async t => {
  const f = await reviewed(t), child = childPath(t, f);
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Prepared by an earlier kit', expectTotal: 3 });
  const { scopeKind, readOnly, ...earlier } = grant;
  assert.deepEqual([scopeKind, readOnly], ['with-dependencies', undefined]);
  // Both copies of the grant must stay identical, as the earlier kit wrote them.
  writeJSON(safePath(f.root, `migration/pilots/${grant.id}.json`), earlier);
  writeJSON(safePath(child, 'migration/pilot.json'), earlier);
  const config = loadConfig(child);
  assert.equal(requirePilot(child, config).id, grant.id);
  const run = await runPilot(child, config, fake);
  assert.equal(run.results.find(r => r.stage === 'translation').result.done, 3);
});

test('auto mode still translates the files they use when a unit typecheck or a later boundary needs them', async t => {
  const withTypecheck = await reviewed(t, { typecheck: true });
  setPreferences(withTypecheck.root, { phaseMode: 'auto' });
  const plan = planPilot(withTypecheck.root, withTypecheck.config, { sources: ['src/main.py'] });
  assert.deepEqual([plan.scopeKind, plan.counts], ['with-dependencies', { requested: 1, added: 2, total: 3 }]);
  assert.equal(plan.readOnly, undefined);
  assert.match(plan.plain.ja, /選んだ 1 ファイルと、それらが使っている 2 ファイル、合わせて 3 ファイル/);

  const noTypecheck = await reviewed(t);
  setPreferences(noTypecheck.root, { phaseMode: 'auto' });
  for (const through of ['build', 'smoke', 'parity']) {
    const later = planPilot(noTypecheck.root, noTypecheck.config, { sources: ['src/main.py'], through });
    assert.deepEqual([later.scopeKind, later.counts.total], ['with-dependencies', 3], through);
  }
});

test('outside auto mode the pilot keeps the files they use, and a count planned in one mode is not prepared in the other', async t => {
  const f = await reviewed(t), child = childPath(t, f);
  for (const mode of [undefined, 'normal', 'relaxed']) {
    if (mode) setPreferences(f.root, { phaseMode: mode });
    const plan = planPilot(f.root, f.config, { sources: ['src/main.py'] });
    assert.deepEqual([plan.scopeKind, plan.counts.total], ['with-dependencies', 3], String(mode));
  }
  setPreferences(f.root, { phaseMode: 'auto' });
  assert.equal(planPilot(f.root, f.config, { sources: ['src/main.py'] }).counts.total, 1);
  setPreferences(f.root, { phaseMode: 'normal' });
  assert.throws(() => preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Planned in auto mode', expectTotal: 1 }), /3 files, not the 1 approved/);
  assert.equal(fs.existsSync(child), false);
  // Two chosen files keep each other: chosen files are never dropped.
  setPreferences(f.root, { phaseMode: 'auto' });
  const two = planPilot(f.root, f.config, { sources: ['src/main.py', 'src/math_ops.py'] });
  assert.deepEqual([two.sources, two.readOnly], [['src/math_ops.py', 'src/main.py'], ['src/text_ops.py']]);
  assert.match(two.plain.en, /^Try only the 2 chosen files in a copy outside the project\. In auto mode the file used by them is not translated; /);
  // The other way round: a count planned outside auto mode is not prepared in it.
  setPreferences(f.root, { phaseMode: 'normal' });
  assert.equal(planPilot(f.root, f.config, { sources: ['src/main.py'] }).counts.total, 3);
  setPreferences(f.root, { phaseMode: 'auto' });
  assert.throws(() => preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Planned outside auto mode', expectTotal: 3 }), /1 files, not the 3 approved/);
  assert.equal(fs.existsSync(child), false);
  // Outside auto mode the grant has the full scope and no untranslated list.
  setPreferences(f.root, { phaseMode: 'normal' });
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Normal mode: 1 chosen file and the 2 it uses', expectTotal: 3 });
  assert.deepEqual([grant.scopeKind, grant.sources.length, 'readOnly' in grant], ['with-dependencies', 3, false]);
});
