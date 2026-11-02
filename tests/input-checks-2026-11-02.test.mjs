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
// checks every input every ten minutes and when it ends. status --wait
// watches the recorded progress and builds the status asked for once.
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

test('with settled inputs a run reads each source a few times only, and still stops on every change of a source during a worker call', async t => {
  // Every project first, then one wait until all their files have settled.
  const [counted, appended, rewritten, hidden, periodic, pilot, parent] = await Promise.all([production(t, 2), ready(t), ready(t), ready(t), ready(t), reviewedPreparation(t), reviewedPreparation(t)]);
  // main.py is no unit of these projects: only the input checks read it.
  const other = f => safePath(f.root, 'src/main.py'), whole = wholeSecond();
  fs.utimesSync(other(rewritten), whole, whole);
  await sleep(settled);

  await t.test('two units, one with a finding: a source outside them is read when the run starts and by its last check', async () => {
    const f = counted, files = [other(f), safePath(f.root, 'src/math_ops.py'), safePath(f.root, 'migration/review-dependencies.json'), safePath(f.root, 'migration/manifest.tsv')];
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

  await t.test('a change the file\'s size and times do not show is found by the run\'s last check', async () => {
    const f = hidden;
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
