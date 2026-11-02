// SPDX-License-Identifier: Apache-2.0
// 0.43.0: on 2026-11-02 (Windows, kit 0.42.0, source-only, 554 source files,
// two workers at a time) phase 04 had finished 25 units in 2 h 37 min. Before
// and after every worker call the runner checks that its inputs did not
// change, and each check read every source file again: about 8 checks per
// unit, 12 with findings, about 6 s each on that PC, one check at a time, so
// they also held back the other unit in flight. Each worker's evidence read
// the review dependency map again, and status --wait read every source file
// every 5 s while it waited. A run now hashes a file again only when its
// identity, size or times changed since it hashed it, and only once it has
// settled; it reads the dependency map once per check; status --wait watches
// the recorded progress and reads the sources once, when it answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, ready, fake, result, finding } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, writeJSON, atomicWrite, readJSON, loadConfig, readMemo, memoFileHash, hashCache, fileHash } from '../lib/core.mjs';
import { translate, runStage, runPilot, approve } from '../lib/pipeline.mjs';
import { preparePilot } from '../lib/pilot.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { waitForProgress } from '../scripts/run_migration.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Longer than the run's settle window (3 s): a file older than it is kept.
const settled = 3200;
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
// Whole seconds in the past: a modification time a test can put back exactly.
const wholeSecond = () => Math.floor(Date.now() / 1000) - 60;

test('a run\'s hash cache keeps a settled file\'s hash and reads it again once its identity, size or times change', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.py'), whole = wholeSecond();
  // Just written: read at every check and never kept, since it may change
  // again within the same clock tick without its times showing it.
  fs.writeFileSync(file, 'print(1)\n');
  const fresh = hashCache();
  for (let i = 0; i < 2; i++) assert.deepEqual(check(fresh, file), { hash: fileHash(file), reads: 1 });
  assert.equal(fresh.files.size, 0);
  // Settled (a short window here): read once, then kept.
  const cache = hashCache({ settleMs: 50 });
  const keep = async () => {
    fs.utimesSync(file, whole, whole); await sleep(150);
    assert.equal(check(cache, file).reads, 1);
    assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 0 }, 'kept');
  };
  await keep();
  // Appended: a new size and time.
  const old = fileHash(file);
  fs.appendFileSync(file, 'print(2)\n');
  assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 1 });
  assert.notEqual(fileHash(file), old);
  // Rewritten with the same size and its modification time put back: the
  // change time still moved (on the file systems the kit is tested on).
  await keep();
  const before = fs.statSync(file, { bigint: true });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('1', '3'));
  fs.utimesSync(file, whole, whole);
  const after = fs.statSync(file, { bigint: true });
  assert.deepEqual([after.size, after.mtimeNs], [before.size, before.mtimeNs]);
  if (after.ctimeNs !== before.ctimeNs) assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 1 });
  else t.diagnostic('This file system kept the change time of a rewrite; gates and status still hash the file itself');
  // Replaced by a rename (an editor's save) with the same size and times.
  await keep();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, fs.readFileSync(file, 'utf8').replace('3', '4'));
  fs.utimesSync(temp, whole, whole);
  fs.renameSync(temp, file);
  assert.deepEqual(check(cache, file), { hash: fileHash(file), reads: 1 });
  // Gone, or a directory in its place: no hash, and nothing kept.
  await keep();
  fs.rmSync(file);
  assert.deepEqual(check(cache, file), { hash: null, reads: 0 });
  assert.equal(cache.files.has(file), false);
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
// in tests/pilot-lock-2026-11-01.test.mjs.
async function reviewedPreparation(t) {
  const f = prepare(t, { realCommands: true, count: 3, executionMode: 'continuous' });
  f.config.phasePolicy = 'strict'; f.config.concurrency = 1; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  for (const p of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, p), 'Disposable preparation fixture; not actual AI review or human signoff.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for a regression test only' });
  await runStage(f.root, f.config, 'judge');
  return f;
}

test('with settled inputs a run reads each other source once, and still stops when a source changes during a worker call', async t => {
  // Every project first, then one wait until all their files have settled.
  const [counted, appended, rewritten, parent] = await Promise.all([production(t, 2), ready(t), ready(t), reviewedPreparation(t)]);
  const child = `${parent.root}-pilot`;
  t.after(() => fs.rmSync(child, { recursive: true, force: true }));
  preparePilot(parent.root, parent.config, { target: child, sources: ['src/main.py'], note: 'Disposable regression pilot' });
  // main.py is no unit of these projects: only the input checks read it.
  const other = f => safePath(f.root, 'src/main.py'), whole = wholeSecond();
  fs.utimesSync(other(rewritten), whole, whole);
  await sleep(settled);

  await t.test('two units, one with a finding: the other source is read once in the whole run, the dependency map once per check', async () => {
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
    // Before 0.43.0 this run read main.py 21 times (once per check) and
    // math_ops.py 23 times. Every check reads the map and the manifest for
    // their text; each worker's evidence also read the map again (48 reads
    // against 43 of the manifest then, 23 and 23 now).
    assert.equal(main, 1, `reads of a source outside the units: ${main}`);
    assert.ok(map <= manifest, `dependency map read ${map} times, manifest ${manifest}`);
    // A unit's source is still read for each worker's evidence (the text sent).
    assert.ok(unitSource < 10, `reads of a unit's source: ${unitSource}`);
  });

  await t.test('a source appended to during a worker call stops the run', async () => {
    const f = appended;
    await assert.rejects(translate(f.root, f.config, async call => {
      if (call.role === 'implementer') fs.appendFileSync(other(f), '\n# edited during the run\n');
      return fake(call);
    }), /Migration inputs changed during worker invocation/);
    assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false, 'nothing written after the change');
  });

  await t.test('a source rewritten with the same size and its modification time put back stops the run', async t2 => {
    const f = rewritten, before = fs.statSync(other(f), { bigint: true });
    let after;
    const failure = await translate(f.root, f.config, async call => {
      if (call.role === 'implementer') {
        fs.writeFileSync(other(f), fs.readFileSync(other(f), 'utf8').replace('print', 'Print'));
        fs.utimesSync(other(f), whole, whole);
        after = fs.statSync(other(f), { bigint: true });
      }
      return fake(call);
    }).then(() => null, e => e);
    assert.deepEqual([after.size, after.mtimeNs], [before.size, before.mtimeNs]);
    if (after.ctimeNs === before.ctimeNs) { t2.diagnostic('This file system kept the change time of a rewrite; gates and status still hash the file itself'); return; }
    assert.match(failure?.message ?? 'completed', /Migration inputs changed during worker invocation/);
    assert.equal(fs.existsSync(safePath(f.root, f.units[0].target)), false, 'nothing written after the change');
  });

  await t.test('a pilot stops when a settled source of the production project changes during a worker call', async () => {
    const config = loadConfig(child);
    let first = true;
    const failure = await runPilot(child, config, async call => {
      if (first) { first = false; fs.appendFileSync(safePath(parent.root, 'src/text_ops.py'), '\n# edited during the pilot\n'); }
      return fake(call);
    }).then(() => null, e => e);
    assert.match(failure?.message ?? 'completed', /Pilot parent preparation or judge changed/);
    assert.equal(fs.existsSync(path.join(child, 'ported/math_ops.mjs')), false, 'nothing written after the change');
  });
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
  // Before 0.43.0: a full status every 20 ms here (every 5 s by default), each reading every source.
  assert.equal(full.reads, 1);
  const fast = await waitReads({ fast: true });
  assert.deepEqual([fast.report.running, fast.report.recordedOnly, fast.reads], [true, true, 0]);
  // A lock written on another host does not run here: both answer at once
  // and name it (before 0.43.0 the fast view called it running when this
  // host had a process of that number, and the wait ran out its time).
  writeJSON(lock, { ...readJSON(lock), host: `${os.hostname()}-elsewhere` });
  for (const options of [{}, { fast: true }]) {
    const started = Date.now(), report = await waitForProgress(f.root, 30, { intervalMs: 20, ...options });
    assert.equal(report.running, false, JSON.stringify(options));
    assert.deepEqual([report.foreignLock?.pid, report.foreignLock?.host], [process.pid, `${os.hostname()}-elsewhere`], JSON.stringify(options));
    assert.ok(Date.now() - started < 5000, JSON.stringify(options));
  }
});
