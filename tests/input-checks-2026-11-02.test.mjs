// SPDX-License-Identifier: Apache-2.0
// 0.43.0: on 2026-11-02 (Windows, kit 0.42.0, source-only, 554 source files,
// two workers at a time) phase 04 had finished 25 units in 2 h 37 min. Before
// and after every worker call the runner checks that its inputs did not
// change, and each check read every source file again (about 8 checks per
// unit, 12 with findings, about 6 s each on that PC) and checked every
// manifest row and every file the review dependency map names; the checks run
// one at a time, so they also held back the other unit in flight. Each
// worker's evidence read the map again, and status --wait read every source
// file at every poll. A run now reads a file again only when its identity,
// size or times changed since it hashed it (once it has settled), checks the
// manifest rows and the map again only when their text changed, and reads and
// checks every input every ten minutes and when it ends. The text it gives a
// worker is checked against its first read, and once it finds a change, the
// units it took an answer for or finished since its last full check go back
// to review. status --wait watches the recorded progress and builds the
// status asked for once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, ready, fake, result, finding } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, writeJSON, atomicWrite, readJSON, loadConfig, readMemo, memoFileHash, runCache, fileHash, hash, loadReviewDependencies, contextHash } from '../lib/core.mjs';
import { reviewEvidence, legacySources } from '../lib/review.mjs';
import { renameRetry } from '../lib/text.mjs';
import { translate, runStage, runPilot, approve } from '../lib/pipeline.mjs';
import { preparePilot } from '../lib/pilot.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { waitForProgress } from '../scripts/run_migration.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { statusMarkdown } from '../lib/status.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Longer than the run's settle window (3 s): a file older than it is kept.
const settled = 3200;
const ns = ms => BigInt(ms) * 1_000_000n;
// Counts reads of the given files until stop().
function readCounter(files) {
  const real = files.map(file => path.resolve(file)), counts = real.map(() => 0), original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === 'string') { const i = real.indexOf(path.resolve(file)); if (i >= 0) counts[i]++; }
    return original.call(this, file, ...rest);
  };
  return { counts, stop: () => { fs.readFileSync = original; } };
}
// One input check of a run: a fresh read memo with the run's cache.
function check(cache, file) {
  const reads = readCounter([file]);
  try { return { hash: memoFileHash(file, readMemo(cache)), reads: reads.counts[0] }; } finally { reads.stop(); }
}
// A file whose stat this test sets field by field (record), read from its
// content; during(), when set, runs right after its bytes were read.
function fakeFile(t, file, content, { mtimeNs, ctimeNs }) {
  const record = { dev: 7n, ino: 11n, size: BigInt(Buffer.byteLength(content)), mtimeNs, ctimeNs, kind: 'file', content, during: null };
  const { statSync, readFileSync } = fs;
  let reads = 0;
  fs.statSync = function (p, ...rest) {
    if (p !== file) return statSync.call(this, p, ...rest);
    if (record.kind === 'gone') throw Object.assign(new Error(`ENOENT: no such file, stat '${p}'`), { code: 'ENOENT' });
    const { dev, ino, size } = record;
    return { dev, ino, size, mtimeNs: record.mtimeNs, ctimeNs: record.ctimeNs, isFile: () => record.kind === 'file' };
  };
  fs.readFileSync = function (p, ...rest) {
    if (p !== file) return readFileSync.call(this, p, ...rest);
    reads++;
    const data = Buffer.from(record.content);
    record.during?.();
    return data;
  };
  t.after(() => { fs.statSync = statSync; fs.readFileSync = readFileSync; });
  const look = cache => { const before = reads; const value = memoFileHash(file, readMemo(cache)); return { hash: value, reads: reads - before }; };
  return { record, look, current: () => hash(Buffer.from(record.content)) };
}

test('a run keeps a file\'s hash while its identity, size and both times stay the same, and only once it has settled', t => {
  const file = path.join(os.tmpdir(), `kit-fake-${process.pid}.py`), old = ns(Date.now() - 3_600_000);
  const f = fakeFile(t, file, 'print(1)\n', { mtimeNs: old, ctimeNs: old }), cache = runCache();
  assert.deepEqual(f.look(cache), { hash: f.current(), reads: 1 });
  assert.deepEqual(f.look(cache), { hash: f.current(), reads: 0 }, 'kept');
  // Each part of the key on its own: read again, then kept again.
  for (const [field, content] of [['dev', 'print(2)\n'], ['ino', 'print(3)\n'], ['size', 'print(44)\n'], ['mtimeNs', 'print(5)\n'], ['ctimeNs', 'print(6)\n']]) {
    f.record.content = content;
    if (field === 'size') f.record.size = BigInt(Buffer.byteLength(content)); else f.record[field] += 1n;
    assert.deepEqual(f.look(cache), { hash: f.current(), reads: 1 }, field);
    assert.deepEqual(f.look(cache), { hash: f.current(), reads: 0 }, `${field}: kept again`);
  }
  // The limit: a change that leaves the key as it was is not seen here (the
  // run's full checks and every gate read the file itself).
  const kept = f.current();
  f.record.content = 'print(7)\n';
  assert.deepEqual(f.look(cache), { hash: kept, reads: 0 });
  // Changed less than 3 s ago by either time (an old modification time with a
  // fresh change time is what cp -p, tar and rsync leave): read at every check.
  for (const [mtimeNs, ctimeNs] of [[old, ns(Date.now())], [ns(Date.now()), old]]) {
    Object.assign(f.record, { mtimeNs, ctimeNs });
    for (let i = 0; i < 2; i++) assert.deepEqual(f.look(cache), { hash: f.current(), reads: 1 }, `${mtimeNs === old ? 'change' : 'modification'} time fresh`);
  }
  // Changed while it was read: the new key makes the next check read it again.
  Object.assign(f.record, { mtimeNs: old - 1n, ctimeNs: old - 1n, content: 'print(8)\n' });
  f.record.during = () => { f.record.content = 'print(9)\n'; f.record.ctimeNs += 1n; f.record.during = null; };
  assert.deepEqual(f.look(cache), { hash: hash(Buffer.from('print(8)\n')), reads: 1 });
  assert.deepEqual(f.look(cache), { hash: f.current(), reads: 1 });
  assert.deepEqual(f.look(cache), { hash: f.current(), reads: 0 });
  // No longer a file, or gone: no hash, and nothing kept.
  f.record.kind = 'directory';
  assert.deepEqual(f.look(cache), { hash: null, reads: 0 });
  assert.equal(cache.files.has(file), false);
  f.record.kind = 'file';
  assert.equal(f.look(cache).reads, 1);
  f.record.kind = 'gone';
  assert.deepEqual(f.look(cache), { hash: null, reads: 0 });
  assert.equal(cache.files.has(file), false);
});

// Whole seconds in the past: a modification time a test can put back exactly.
const wholeSecond = () => Math.floor(Date.now() / 1000) - 60;

test('on this file system a run reads a real file again after an append, a rewrite with its time put back, a save by rename, or its removal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.py'), whole = wholeSecond();
  fs.writeFileSync(file, 'print(1)\n');
  // Just written: never kept within the window (an hour here).
  const fresh = runCache({ settleMs: 3_600_000 });
  for (let i = 0; i < 2; i++) assert.deepEqual(check(fresh, file), { hash: fileHash(file), reads: 1 });
  assert.equal(fresh.files.size, 0);
  // Settled (a short window here): read once, then kept.
  const cache = runCache({ settleMs: 50 });
  const keep = async () => {
    fs.utimesSync(file, whole, whole); await sleep(150);
    assert.equal(check(cache, file).reads, 1);
    assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 0 }, 'kept');
  };
  await keep();
  fs.appendFileSync(file, 'print(2)\n');
  assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 1 }, 'appended');
  // The same size and its modification time put back: the change time moved
  // (NTFS, APFS, ext4; FAT and exFAT keep none, see the fake file above).
  await keep();
  const before = fs.statSync(file, { bigint: true });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('1', '3'));
  fs.utimesSync(file, whole, whole);
  const after = fs.statSync(file, { bigint: true });
  assert.deepEqual([after.size, after.mtimeNs], [before.size, before.mtimeNs]);
  if (after.ctimeNs !== before.ctimeNs) assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 1 }, 'rewritten');
  else t.diagnostic('This file system kept the change time of a rewrite; the run\'s full checks still read the file itself');
  // Saved by a rename over it (an editor's save), with the same size and times.
  await keep();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, fs.readFileSync(file, 'utf8').replace('3', '4'));
  fs.utimesSync(temp, whole, whole);
  renameRetry(temp, file);
  assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 1 }, 'renamed over');
  // Gone, or a directory in its place.
  await keep();
  fs.rmSync(file);
  assert.deepEqual(check(cache, file), { hash: null, reads: 0 });
  fs.mkdirSync(file);
  assert.deepEqual(check(cache, file), { hash: null, reads: 0 });
});

// A project as installed: the template's marker, fix, scheduling and review
// policies (the test fixtures drop them), workers two at a time; judged and
// approved for translation.
async function production(t, count) {
  const f = prepare(t, { count, executionMode: 'continuous' });
  const template = JSON.parse(fs.readFileSync(path.join(kitRoot, 'templates/migration-config.json'), 'utf8'));
  for (const key of ['markerPolicy', 'fixPolicy', 'dependencyOrder', 'reviewFocus']) f.config[key] = template[key];
  f.config.concurrency = 2;
  delete f.config.commands.typecheck;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const config = loadConfig(f.root);
  await runStage(f.root, config, 'judge');
  approve(f.root, config, 'translation', 'Automated fixture approval for tests only');
  return { ...f, config };
}
// The canned outputs, ending with the trailer the marker policy asks for.
const trailer = content => `${content.replace(/^\/\/ PORT STATUS.*\n?/gm, '').trimEnd()}\n// PORT STATUS: confidence=high todos=0\n`;
const answer = async call => {
  const response = await fake(call);
  if (response.result.content) response.result.content = trailer(`${call.role === 'fixer' ? '// fixed\n' : ''}${response.result.content}`);
  return response;
};
// A production project with phases 00 to 02 recorded and its judge run, as
// in tests/pilot-lock-2026-11-01.test.mjs, and a pilot of it.
async function reviewedPreparation(t) {
  const f = prepare(t, { realCommands: true, count: 3, executionMode: 'continuous' });
  f.config.phasePolicy = 'strict'; f.config.concurrency = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  for (const p of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, p), 'Disposable preparation fixture; not actual AI review or human signoff.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for a regression test only' });
  await runStage(f.root, f.config, 'judge');
  const child = `${f.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Disposable regression pilot' });
  return { ...f, child };
}
// From now on the given file answers stat with the times it has now, as a
// file another program keeps open or a share's attribute cache may: a change
// its size and times do not show. Returns the undo.
function freezeStat(file) {
  const { statSync } = fs, plain = statSync(file), big = statSync(file, { bigint: true });
  fs.statSync = function (p, options, ...rest) { return p === file ? (options?.bigint ? big : plain) : statSync.call(this, p, options, ...rest); };
  return () => { fs.statSync = statSync; };
}
const rewriteSameSize = file => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('print', 'Print'));
// A unit too large for a frozen review input: both reviewers read the
// hash-bound file list with their own tools. Judged and approved.
async function toolAssisted(t) {
  const f = prepare(t, { count: 1 });
  f.config.maxReviewInputBytes = 1024;
  fs.appendFileSync(safePath(f.root, f.units[0].source), `\n# ${'x'.repeat(1500)}\n`);
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const config = loadConfig(f.root);
  await runStage(f.root, config, 'judge');
  approve(f.root, config, 'translation', 'Automated fixture approval for tests only');
  return { ...f, config };
}
// Two units, one at a time, judged and approved.
async function oneAtATime(t) {
  const f = prepare(t, { count: 2 });
  f.config.concurrency = 1;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const config = loadConfig(f.root);
  await runStage(f.root, config, 'judge');
  approve(f.root, config, 'translation', 'Automated fixture approval for tests only');
  return { ...f, config };
}
// A project whose RULEBOOK has an accepted second wording (as rulebook accept
// records it): both have the first one's identity. Judged and approved.
async function amendedRulebook(t) {
  const f = prepare(t, { count: 1 }), rulebook = safePath(f.root, 'migration/RULEBOOK.md');
  const first = fs.readFileSync(rulebook), second = Buffer.concat([first, Buffer.from('\nAn accepted rewording for a regression test only.\n')]);
  writeJSON(safePath(f.root, 'migration/phases/rulebook-amendments.json'), { schemaVersion: 1, accepted: { [hash(second)]: hash(first) },
    log: [{ at: new Date().toISOString(), identity: hash(first), from: hash(first), to: hash(second), note: 'Synthetic accepted amendment for a regression test only', redo: [] }] });
  const config = loadConfig(f.root);
  await runStage(f.root, config, 'judge');
  approve(f.root, config, 'translation', 'Automated fixture approval for tests only');
  return { ...f, config, rulebook, second };
}
// One reviewer's answer has a finding.
const withFinding = async call => ({ ...(await fake(call)), result: result(call.role, call.unit, { findings: [finding] }) });
const unitRecord = f => readJSON(safePath(f.root, `migration/state/units/${f.units[0].id}.json`));

test('with settled inputs a run reads each source a few times only, and still stops on every change of a source during a worker call', async t => {
  // Every project first, then one wait until all their files have settled.
  const [counted, appended, rewritten, hidden, pinned, assisted, listed, answered, fixedOnce, unfinished, late, confirmed, unwritable, busy, busyShort, busyLast, statBusy, reread, amended, interrupted, periodic, budget, removed] = await Promise.all([
    production(t, 2), ready(t), ready(t), ready(t), ready(t), toolAssisted(t), toolAssisted(t), ready(t), production(t, 1), production(t, 1), ready(t, { count: 2 }), oneAtATime(t), oneAtATime(t), oneAtATime(t), oneAtATime(t), oneAtATime(t), oneAtATime(t), oneAtATime(t), amendedRulebook(t),
    ready(t, { count: 2 }), ready(t), ready(t), ready(t, { count: 2 })]);
  // main.py is no unit of these projects: only the input checks read it.
  const other = f => safePath(f.root, 'src/main.py'), whole = wholeSecond();
  fs.utimesSync(other(rewritten), whole, whole);
  await sleep(settled);

  await t.test('two units, one with a finding: a source outside them is read when the run starts and by its last check', async () => {
    const f = counted, files = [other(f), safePath(f.root, 'src/math_ops.py'), safePath(f.root, 'migration/review-dependencies.json'), safePath(f.root, 'migration/manifest.tsv')];
    const waiver = safePath(f.root, 'migration/phases/waivers/04.json');
    writeJSON(waiver, { schemaVersion: 1, phase: '04', note: 'Synthetic waiver for a regression test only', waivedAt: new Date().toISOString() });
    const reads = readCounter(files);
    let found = false, summary;
    try {
      summary = await translate(f.root, f.config, async call => {
        if (call.role !== 'reviewer-rules' || call.unit.target !== 'ported/text_ops.mjs' || found) return answer(call);
        found = true;
        return { result: result(call.role, call.unit, { findings: [finding] }), requestedModel: 'test-double', observedModel: null, tokens: null, aiCredits: null };
      });
    } finally { reads.stop(); }
    assert.equal(summary.done, 2);
    assert.equal(summary.scopeComplete, true);
    assert.equal(fs.existsSync(waiver), false, 'every unit done: phase 04\'s waiver retires');
    const [main, unitSource, map, manifest] = reads.counts;
    // Before 0.43.0 this run read main.py 21 times (once per check), the
    // unit's own math_ops.py 23 times, the dependency map 48 times and the
    // manifest 43 times.
    assert.equal(main, 2, `a source outside the units: ${main}`);
    // The unit's source is also read for the evidence each worker is given.
    assert.equal(unitSource, 4, `the unit's own source: ${unitSource}`);
    // Every check reads the map and the manifest for their text (their rows
    // and files are checked again only when it changed, and by the last
    // check); the workers' evidence no longer reads the map.
    assert.ok(map <= manifest && manifest < 30, `map ${map}, manifest ${manifest}`);
  });

  await t.test('a source appended to during a worker call stops the run', async () => {
    const f = appended, reads = readCounter([other(f)]);
    let cached;
    try {
      await assert.rejects(translate(f.root, f.config, async call => {
        if (call.role === 'implementer') { cached = reads.counts[0]; fs.appendFileSync(other(f), '\n# edited during the run\n'); }
        return fake(call);
      }), /Migration inputs changed during worker invocation/);
    } finally { reads.stop(); }
    assert.equal(cached, 1, 'read once, when the run started, before the change');
    assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false, 'nothing written after the change');
  });

  await t.test('a source rewritten with the same size and its modification time put back stops the run', async t2 => {
    const f = rewritten, before = fs.statSync(other(f), { bigint: true }), reads = readCounter([other(f)]);
    let after, cached;
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'implementer') {
          cached = reads.counts[0];
          rewriteSameSize(other(f));
          fs.utimesSync(other(f), whole, whole);
          after = fs.statSync(other(f), { bigint: true });
        }
        return fake(call);
      }).then(() => null, e => e);
    } finally { reads.stop(); }
    assert.equal(cached, 1, 'read once, when the run started, before the change');
    assert.deepEqual([after.size, after.mtimeNs], [before.size, before.mtimeNs]);
    if (after.ctimeNs === before.ctimeNs) { t2.diagnostic('This file system kept the change time of a rewrite; the run\'s last check still reads the file itself'); return; }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during worker invocation/);
    assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false, 'nothing written after the change');
  });

  await t.test('a change the file\'s size and times do not show is found by the run\'s last check, and its unit is reviewed again even once it is undone', async () => {
    const f = hidden, waiver = safePath(f.root, 'migration/phases/waivers/04.json'), original = fs.readFileSync(other(f));
    writeJSON(waiver, { schemaVersion: 1, phase: '04', note: 'Synthetic waiver for a regression test only', waivedAt: new Date().toISOString() });
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'implementer') { undo = freezeStat(other(f)); rewriteSameSize(other(f)); }
        return fake(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    assert.ok(failure.report.errors.some(e => e.target === '(inputs)'), JSON.stringify(failure.report.errors));
    // The unit it finished since the last full check goes back to review: it
    // is not done, the run's scope is not complete and phase 04's waiver stays.
    assert.equal(failure.report.done, 0);
    assert.equal(failure.report.scopeComplete, false);
    assert.equal(fs.existsSync(waiver), true);
    const state = readJSON(safePath(f.root, `migration/state/units/${f.units[0].id}.json`));
    assert.equal(state.status, 'blocked');
    assert.match(state.error, /Migration inputs changed during the run.*its reviews are made again/);
    // Undone, the inputs are those approved again: the next run reviews the
    // unit again rather than keep reviews a worker reading files itself may
    // have made of the changed text.
    fs.writeFileSync(other(f), original);
    const roles = [];
    const summary = await translate(f.root, f.config, async call => { roles.push(call.role); return fake(call); });
    assert.equal(summary.done, 1);
    assert.equal(roles.filter(role => role.startsWith('reviewer-')).length, 2, roles.join(', '));
  });

  await t.test('a change of a unit\'s own source its size and times do not show stops the run before a reviewer is given the text', async () => {
    const f = pinned, source = safePath(f.root, f.units[0].source), roles = [];
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        roles.push(call.role);
        if (call.role === 'implementer') { undo = freezeStat(source); fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('division', 'Division')); }
        return fake(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed before worker invocation/);
    assert.deepEqual(roles, ['implementer'], 'no reviewer was called');
  });

  await t.test('a change of a large unit\'s own source its size and times do not show stops the run before its reviewers get the file list', async () => {
    const f = listed, source = safePath(f.root, f.units[0].source), roles = [];
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        roles.push(call.role);
        if (call.role === 'implementer') { undo = freezeStat(source); fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('def', 'DEF')); }
        return fake(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed before worker invocation/);
    assert.deepEqual(roles, ['implementer'], 'no reviewer was called');
  });

  await t.test('a unit whose reviewers read the files themselves while such a change was made is reviewed again once it is undone, not arbitrated from those reviews', async () => {
    const f = assisted, source = safePath(f.root, f.units[0].source), original = fs.readFileSync(source), roles = [];
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        roles.push(call.role);
        if (call.role === 'reviewer-semantics') { undo = freezeStat(source); fs.writeFileSync(source, original.toString('utf8').replace('def', 'DEF')); }
        return call.role === 'reviewer-rules' ? withFinding(call) : fake(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    // The text for the arbiter differs from the run's first read: it is not
    // asked, and the reviews taken while the change was there go.
    assert.match(failure?.message ?? 'completed', /Migration inputs changed before worker invocation/);
    assert.deepEqual(roles, ['implementer', 'reviewer-semantics', 'reviewer-rules']);
    const state = unitRecord(f);
    assert.equal(state.status, 'blocked'); assert.equal(state.stage, 'review'); assert.deepEqual(state.reviewMap, {});
    assert.match(state.error, /its reviews are made again by the next run$/);
    fs.writeFileSync(source, original);
    const again = [];
    const summary = await translate(f.root, f.config, async call => { again.push(call.role); return fake(call); });
    assert.equal(summary.done, 1);
    assert.deepEqual([...again].sort(), ['reviewer-rules', 'reviewer-semantics']);
  });

  await t.test('a unit blocked after its reviewers answered while such a change was made is reviewed again once it is undone', async () => {
    const f = answered, original = fs.readFileSync(other(f));
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'reviewer-semantics') { undo = freezeStat(other(f)); rewriteSameSize(other(f)); }
        if (call.role === 'arbiter') throw new Error('arbiter refused the task');
        return call.role === 'reviewer-rules' ? withFinding(call) : fake(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    // The unit stopped at its arbitration; the run's last check finds the
    // change and its reviews go, although it is not done.
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    const state = unitRecord(f);
    assert.equal(state.status, 'blocked'); assert.equal(state.stage, 'review'); assert.deepEqual(state.reviewMap, {});
    assert.match(state.error, /^arbiter refused the task; its reviews are made again by the next run$/);
    fs.writeFileSync(other(f), original);
    const again = [];
    const summary = await translate(f.root, f.config, async call => { again.push(call.role); return fake(call); });
    assert.equal(summary.done, 1);
    assert.deepEqual([...again].sort(), ['reviewer-rules', 'reviewer-semantics']);
  });

  await t.test('a unit finished with an arbitration and a single-pass fix while such a change was made is reviewed again once it is undone', async () => {
    const f = fixedOnce, original = fs.readFileSync(other(f));
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'fixer') { undo = freezeStat(other(f)); rewriteSameSize(other(f)); }
        return call.role === 'reviewer-rules' ? withFinding(call) : answer(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    // Neither the arbitration nor the single-pass fix made from the dropped
    // reviews is kept: the fixed file is reviewed again.
    const state = unitRecord(f);
    assert.equal(state.status, 'blocked'); assert.equal(state.stage, 'review');
    assert.deepEqual([state.reviewEvidence, state.arbitration, state.singlePass], [[], undefined, undefined]);
    fs.writeFileSync(other(f), original);
    const again = [];
    const summary = await translate(f.root, f.config, async call => { again.push(call.role); return answer(call); });
    assert.equal(summary.done, 1);
    assert.deepEqual([...again].sort(), ['reviewer-rules', 'reviewer-semantics']);
  });

  await t.test('a unit stopped before its candidate was written keeps its own reason and is implemented again once such a change is undone', async () => {
    const f = unfinished, original = fs.readFileSync(other(f));
    let undo = () => {}, implementer = 0;
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role !== 'implementer') return answer(call);
        // Its first answer is taken, but its trailer is missing: it is asked again.
        if (++implementer === 1) { undo = freezeStat(other(f)); rewriteSameSize(other(f)); return fake(call); }
        throw new Error('the implementer could not answer again');
      }).then(() => null, e => e);
    } finally { undo(); }
    assert.equal(implementer, 2);
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    // It has no reviews to drop: its record is the one it stopped with.
    const state = unitRecord(f);
    assert.deepEqual([state.status, state.stage, state.error], ['blocked', 'implement', 'the implementer could not answer again']);
    assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false, 'no candidate');
    fs.writeFileSync(other(f), original);
    const again = [];
    const summary = await translate(f.root, f.config, async call => { again.push(call.role); return answer(call); });
    assert.equal(summary.done, 1);
    assert.equal(again[0], 'implementer');
  });

  // A run that finds its inputs changed stops its workers, and an answer
  // that comes back after that is not taken (the interrupt check after each
  // call), although the check after the call does not see such a change.
  await t.test('an answer that comes back after the run found such a change is not taken', async () => {
    const f = late, [first, second] = f.units, changed = safePath(f.root, second.source);
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        // The first unit's implementer answers only once the run has stopped.
        if (call.unit.target === first.target) await new Promise(resolve => call.signal.addEventListener('abort', resolve, { once: true }));
        else if (call.role === 'implementer') { undo = freezeStat(changed); fs.writeFileSync(changed, fs.readFileSync(changed, 'utf8').replace('def', 'DEF')); }
        return fake(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed before worker invocation/);
    const state = readJSON(safePath(f.root, `migration/state/units/${first.id}.json`));
    assert.equal(state.status, 'blocked'); assert.equal(state.stage, 'implement');
    assert.equal(state.error, 'Interrupted');
    assert.equal(fs.existsSync(safePath(f.root, first.target)), false, 'its candidate was not written');
  });

  await t.test('a unit a passing full check confirmed stays done when a later such change sends the next one back', async () => {
    const f = confirmed, [first, second] = f.units, clock = performance.now;
    let undo = () => {}, offset = 0, changed = false;
    performance.now = () => clock.call(performance) + offset;
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        // The check after the second unit's implementer call is a full one, and passes.
        if (call.role === 'implementer' && call.unit.target === second.target) offset = 11 * 60 * 1000;
        if (call.role.startsWith('reviewer-') && call.unit.target === second.target && !changed) { changed = true; undo = freezeStat(other(f)); rewriteSameSize(other(f)); }
        return fake(call);
      }).then(() => null, e => e);
    } finally { undo(); performance.now = clock; }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    const record = unit => readJSON(safePath(f.root, `migration/state/units/${unit.id}.json`));
    assert.equal(record(first).status, 'done');
    assert.equal(record(second).status, 'blocked'); assert.match(record(second).error, /its reviews are made again by the next run$/);
    assert.equal(failure.report.done, 1);
  });

  await t.test('a unit that cannot be sent back to review is named in the run\'s errors', async () => {
    const f = unwritable, [first, second] = f.units, kept = safePath(f.root, `migration/state/units/${first.id}.json`);
    let undo = () => {}, changed = false;
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role.startsWith('reviewer-') && call.unit.target === second.target && !changed) {
          changed = true; fs.rmSync(kept); fs.mkdirSync(kept);
          undo = freezeStat(other(f)); rewriteSameSize(other(f));
        }
        return fake(call);
      }).then(() => null, e => e);
    } finally { undo(); }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    assert.ok(failure.report.errors.some(e => e.target === first.target && /^Could not send it back to review \(.+\); delete migration\/state\/units\/.+\.json before the next run/.test(e.error)), JSON.stringify(failure.report.errors));
  });

  // Once the given number of units are done, an input cannot be read
  // (antivirus, an indexer) or looked up the given number of times.
  const busyInput = async (f, after, { name = 'migration/manifest.tsv', call = 'readFileSync', times = 1 } = {}) => {
    const file = safePath(f.root, name), original = fs[call];
    let finished = 0, thrown = 0;
    fs[call] = function (p, ...rest) {
      if (finished >= after && thrown < times && p === file) { thrown++; throw Object.assign(new Error(`EBUSY: resource busy or locked, ${call === 'statSync' ? 'stat' : 'open'} '${p}'`), { code: 'EBUSY' }); }
      return original.call(this, p, ...rest);
    };
    try {
      const failure = await translate(f.root, f.config, fake, { onProgress: event => { if (event.stage === 'done') finished++; } }).then(() => null, e => e);
      return { failure, thrown };
    } finally { fs[call] = original; }
  };
  const record = (f, unit) => readJSON(safePath(f.root, `migration/state/units/${unit.id}.json`));

  await t.test('a check that cannot read an input stops the run, and the last check keeps the unit it confirms', async () => {
    const f = busy, { failure, thrown } = await busyInput(f, 1);
    assert.equal(thrown, 1);
    assert.match(failure?.message ?? 'completed', /EBUSY/);
    assert.doesNotMatch(failure.message, /its reviews are made again/);
    assert.equal(record(f, f.units[0]).status, 'done');
    assert.equal(failure.report.done, 1);
  });

  await t.test('a last check that can read an input again within a few seconds keeps the unit it confirms', async () => {
    // Busy at the check before the second unit and at the last check's first read.
    const f = busyShort, { failure, thrown } = await busyInput(f, 1, { times: 2 });
    assert.equal(thrown, 2);
    assert.match(failure?.message ?? 'completed', /EBUSY/);
    assert.doesNotMatch(failure.message, /its reviews are made again/);
    assert.equal(record(f, f.units[0]).status, 'done');
    assert.equal(failure.report.done, 1);
  });

  await t.test('a last check that still cannot read an input after reading it again sends back the units it cannot confirm', async () => {
    const f = busyLast, { failure, thrown } = await busyInput(f, 2, { times: 4 });
    assert.equal(thrown, 4, 'read once and again after 0.3, 1 and 3 s');
    assert.match(failure?.message ?? 'completed', /EBUSY/);
    for (const unit of f.units) assert.match(record(f, unit).error ?? '', /EBUSY.*its reviews are made again by the next run$/);
    assert.equal(failure.report.done, 0);
  });

  await t.test('a file a check cannot look up for a moment is not taken for a removed one', async () => {
    const f = statBusy, { failure, thrown } = await busyInput(f, 1, { name: 'migration/inventory.tsv', call: 'statSync' });
    assert.equal(thrown, 1);
    assert.match(failure?.message ?? 'completed', /EBUSY/);
    assert.doesNotMatch(failure.message, /missing|its reviews are made again/);
    assert.equal(record(f, f.units[0]).status, 'done');
    assert.equal(failure.report.done, 1);
  });

  await t.test('a change a check finds is named as a change although reading every input again then fails', async () => {
    const f = reread, [first, second] = f.units, held = safePath(f.root, first.source), { readFileSync } = fs;
    let armed = false, thrown = 0;
    fs.readFileSync = function (p, ...rest) {
      if (armed && p === held) { armed = false; thrown++; throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY' }); }
      return readFileSync.call(this, p, ...rest);
    };
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'implementer' && call.unit.target === second.target) { fs.appendFileSync(other(f), '\n# edited during the run\n'); armed = true; }
        return fake(call);
      }).then(() => null, e => e);
    } finally { fs.readFileSync = readFileSync; }
    assert.equal(thrown, 1, 'the read of every input after the change found it');
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during worker invocation/);
    assert.doesNotMatch(failure.message, /EBUSY/);
    assert.match(record(f, first).error ?? '', /its reviews are made again by the next run$/);
  });

  await t.test('an accepted RULEBOOK wording given to a worker during the run passes, as in the inputs\' fingerprint', async () => {
    const f = amended;
    const summary = await translate(f.root, f.config, async call => {
      if (call.role === 'implementer') fs.writeFileSync(f.rulebook, f.second);
      return fake(call);
    });
    assert.equal(summary.done, 1);
  });

  await t.test('an interrupted run still makes its last check, and sends back a unit it finished after such a change', async () => {
    const f = interrupted, stop = new AbortController(), stages = [];
    let undo = () => {}, finished = null;
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'implementer' && call.unit.source === 'src/math_ops.py') { undo = freezeStat(other(f)); rewriteSameSize(other(f)); }
        return fake(call);
      }, { signal: stop.signal, onProgress: event => { stages.push(event.stage); if (event.stage === 'done' && !finished) { finished = event.unit; stop.abort(); } } }).then(() => null, e => e);
    } finally { undo(); }
    assert.ok(finished, 'a unit finished before the interrupt');
    // The wait after the interrupt is named.
    assert.ok(stages.includes('checking every input once more'), stages.join(', '));
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    const unit = f.units.find(u => u.target === finished);
    assert.equal(readJSON(safePath(f.root, `migration/state/units/${unit.id}.json`)).status, 'blocked');
    assert.equal(failure.report.done, 0);
  });

  await t.test('after ten minutes a check reads every input again and finds such a change at once', async () => {
    const f = periodic, clock = performance.now;
    let undo = () => {}, offset = 0;
    performance.now = () => clock.call(performance) + offset;
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'implementer') { undo = freezeStat(other(f)); rewriteSameSize(other(f)); offset = 11 * 60 * 1000; }
        return fake(call);
      }).then(() => null, e => e);
    } finally { undo(); performance.now = clock; }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during worker invocation/);
    assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false, 'nothing written after the change');
  });

  await t.test('a run that also ran out of calls is not a budget stop when its last check finds such a change', async () => {
    const f = budget;
    let undo = () => {};
    let failure;
    try {
      failure = await translate(f.root, f.config, async call => {
        if (call.role === 'implementer') { undo = freezeStat(other(f)); rewriteSameSize(other(f)); }
        return fake(call);
      }, { maxCalls: 1 }).then(() => null, e => e);
    } finally { undo(); }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during the run/);
    // The build loop would ask for more calls within the current approval.
    assert.equal(failure.budgetStop, false);
  });

  await t.test('a source of another unit removed during a worker call is named, as before 0.43.0', async () => {
    const f = removed;
    const failure = await translate(f.root, f.config, async call => {
      if (call.role === 'implementer' && call.unit.source === 'src/math_ops.py') fs.rmSync(safePath(f.root, 'src/text_ops.py'));
      return fake(call);
    }).then(() => null, e => e);
    assert.match(failure?.message ?? 'completed', /Review dependency file missing: src\/text_ops\.py/);
  });
});

test('with settled inputs a pilot reads the production project\'s and its own sources a few times only, and stops when a production source changes', async t => {
  // Its own top-level test: each pilot prepares a production project with
  // its judge (slow on Windows), then one wait until their files have settled.
  const [pilot, parent] = await Promise.all([reviewedPreparation(t), reviewedPreparation(t)]);
  await sleep(settled);

  await t.test('a pilot reads the production project\'s and its own settled sources a few times only', async () => {
    const config = loadConfig(pilot.child), files = [safePath(pilot.root, 'src/math_ops.py'), path.join(pilot.child, 'src/math_ops.py')];
    const reads = readCounter(files);
    let summary;
    try { summary = await runPilot(pilot.child, config, fake); } finally { reads.stop(); }
    assert.equal(summary.results.find(r => r.stage === 'translation').result.done, 3);
    // Before 0.43.0 this pilot read the production source 30 times and its
    // copy 38 times; now 8 and 15 (the judge, the pilot's own gates, the
    // evidence of the copy's three units and the run's first and last check).
    const [production, copy] = reads.counts;
    assert.ok(production <= 10 && copy <= 18, `production ${production}, copy ${copy}`);
  });

  await t.test('a pilot stops when a settled source of the production project changes during a worker call', async () => {
    const config = loadConfig(parent.child);
    let first = true;
    const failure = await runPilot(parent.child, config, async call => {
      if (first) { first = false; fs.appendFileSync(safePath(parent.root, 'src/text_ops.py'), '\n# edited during the pilot\n'); }
      return fake(call);
    }).then(() => null, e => e);
    assert.match(failure?.message ?? 'completed', /Pilot parent preparation or judge changed/);
    assert.equal(fs.existsSync(path.join(parent.child, 'ported/math_ops.mjs')), false, 'nothing written after the change');
  });
});

test('a worker\'s evidence uses the dependency map the run read, and reads it itself only without one', async t => {
  const f = await ready(t, { count: 3 }), unit = f.units.find(u => u.source === 'src/main.py');
  const graph = loadReviewDependencies(f.root, f.config), reads = readCounter([safePath(f.root, 'migration/review-dependencies.json')]);
  try {
    const given = reviewEvidence(f.root, f.config, unit, null, { candidate: false, graph });
    legacySources(f.root, f.config, unit, graph);
    assert.equal(reads.counts[0], 0);
    // The same evidence as when it reads the map itself (each call before 0.43.0).
    assert.equal(reviewEvidence(f.root, f.config, unit, null, { candidate: false }).hash, given.hash);
    assert.equal(reads.counts[0], 1);
  } finally { reads.stop(); }
});

test('a run keeps the dependency map checked for its text, but looks again at every check at a named file the source walk skips', t => {
  const f = prepare(t, { count: 3 }), mapFile = safePath(f.root, 'migration/review-dependencies.json'), map = readJSON(mapFile);
  // A declaration no unit reaches may name files that are not declared
  // themselves: one the source walk enters, and one under node_modules,
  // which the walk skips.
  const walked = 'src/other.py', vendored = 'src/node_modules/helper.py';
  for (const name of ['src/extra.py', walked, vendored]) {
    fs.mkdirSync(path.dirname(safePath(f.root, name)), { recursive: true });
    fs.writeFileSync(safePath(f.root, name), 'x = 1\n');
  }
  writeJSON(mapFile, { ...map, dependencies: { ...map.dependencies, 'src/extra.py': [walked, vendored] } });
  const cache = runCache({ settleMs: 0 }), first = loadReviewDependencies(f.root, f.config, readMemo(cache));
  const context = contextHash(f.root, f.config, readMemo(cache));
  assert.equal(loadReviewDependencies(f.root, f.config, readMemo(cache)), first, 'the same text: the checked graph is kept');
  // A removed file the walk enters: the kept graph is used, and the walk sees the change.
  fs.rmSync(safePath(f.root, walked));
  assert.equal(loadReviewDependencies(f.root, f.config, readMemo(cache)), first);
  assert.notEqual(contextHash(f.root, f.config, readMemo(cache)), context);
  assert.throws(() => loadReviewDependencies(f.root, f.config, readMemo()), /Review dependency file missing: src\/other\.py/, 'without a run cache (gates, status) the map is checked whole');
  fs.writeFileSync(safePath(f.root, walked), 'x = 1\n');
  // A removed file the walk skips is seen at the next check, as before 0.43.0.
  fs.rmSync(safePath(f.root, vendored));
  assert.throws(() => loadReviewDependencies(f.root, f.config, readMemo(cache)), /Review dependency file missing: src\/node_modules\/helper\.py/);
  assert.throws(() => contextHash(f.root, f.config, readMemo(cache)), /Review dependency file missing: src\/node_modules\/helper\.py/);
});

test('status --wait watches the recorded progress and reads the sources once, when it answers', async t => {
  const f = await ready(t), lock = safePath(f.root, 'migration/run.lock'), source = safePath(f.root, 'src/text_ops.py');
  const waitReads = async options => {
    const reads = readCounter([source]);
    try { return { report: await waitForProgress(f.root, 1, { intervalMs: 20, ...options }), reads: reads.counts[0] }; } finally { reads.stop(); }
  };
  // A runner of this host that makes no progress for the whole wait.
  writeJSON(lock, { pid: process.pid, host: os.hostname(), task: 'translation', runId: 'wait-reads', startedAt: new Date().toISOString() });
  const full = await waitReads({});
  assert.equal(full.report.running, true);
  assert.equal(full.report.recordedOnly, undefined, 'the full status answers');
  // Before 0.43.0 a full status at every poll (here every 20 ms, by default every 5 s), each reading every source.
  assert.equal(full.reads, 1);
  const fast = await waitReads({ fast: true });
  assert.deepEqual([fast.report.running, fast.report.recordedOnly, fast.reads], [true, true, 0]);
  // A lock written on another host does not run here: both answer at once
  // and say what to do (before 0.43.0 the fast view called it running when
  // this host had a process of that number, and --fast --wait ran out its time).
  writeJSON(lock, { ...readJSON(lock), host: `${os.hostname()}-elsewhere` });
  for (const options of [{}, { fast: true }]) {
    const started = Date.now(), report = await waitForProgress(f.root, 30, { intervalMs: 20, ...options });
    assert.equal(report.running, false, JSON.stringify(options));
    assert.deepEqual([report.foreignLock?.pid, report.foreignLock?.host], [process.pid, `${os.hostname()}-elsewhere`], JSON.stringify(options));
    assert.ok(report.nextActions.some(a => a.includes(`unlock --pid ${process.pid}`)), JSON.stringify(options));
    assert.ok(Date.now() - started < 5000, JSON.stringify(options));
  }
  assert.match(statusMarkdown(statusSnapshot(f.root)), new RegExp(`unlock --pid ${process.pid}`));
  // A manifest that cannot be read is reported, as before, not a failure of the wait.
  fs.rmSync(lock);
  const manifest = safePath(f.root, 'migration/manifest.tsv');
  fs.rmSync(manifest); fs.mkdirSync(manifest);
  for (const options of [{}, { fast: true }]) {
    const report = await waitForProgress(f.root, 1, { intervalMs: 20, ...options });
    assert.ok(report.blockers.some(b => b.path === 'migration/manifest.tsv'), JSON.stringify(report.blockers));
  }
});
