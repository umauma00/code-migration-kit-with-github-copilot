// SPDX-License-Identifier: Apache-2.0
// Stops that a rerun would only repeat (2026-10-27): stale locks, external
// timeouts and repeated manifest path resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepare } from './helpers.mjs';
import { safePath, writeJSON, readJSON, lockRun, readManifest, atomicWrite } from '../lib/core.mjs';
import { isTransientFailure } from '../lib/failures.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { acquireBuildLoop } from '../lib/core.mjs';
import { commandProgress } from '../lib/command-progress.mjs';
import { main } from '../scripts/run_migration.mjs';
import { preparationCommand } from '../scripts/preparation_cli.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const deadPid = () => {
  // A child that has exited and been reaped: its PID no longer exists. Windows
  // reuses PIDs quickly, so confirm it is still free (CI saw one reused).
  for (let i = 0; i < 20; i++) {
    const pid = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
    if (!alive(pid)) return pid;
  }
  throw new Error('No free PID found for the test');
};

test('a run.lock whose owner process is gone is taken over by the next command instead of stopping', t => {
  const f = prepare(t), lock = safePath(f.root, 'migration/run.lock');
  writeJSON(lock, { pid: deadPid(), task: 'survey', runId: 'crashed', startedAt: new Date().toISOString() });
  assert.equal(migrationStatus(f.root).staleLock?.note.includes('removes this lock automatically'), true);
  const release = lockRun(f.root, 'translation');
  assert.equal(readJSON(lock).pid, process.pid);
  assert.equal(readJSON(lock).task, 'translation');
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('a run.lock held by a live process still refuses, and release never removes another owner\'s lock', t => {
  const f = prepare(t), lock = safePath(f.root, 'migration/run.lock');
  writeJSON(lock, { pid: process.pid, task: 'survey', runId: 'live', startedAt: new Date().toISOString() });
  assert.throws(() => lockRun(f.root, 'translation'), /Migration locked by running pid \d+ \(survey\)/);
  assert.equal(readJSON(lock).runId, 'live');
  fs.rmSync(lock);
  const release = lockRun(f.root, 'translation');
  // Someone recovered and retook the lock meanwhile: this owner's release leaves it alone.
  writeJSON(lock, { pid: process.pid, task: 'other', token: 'someone-else', startedAt: new Date().toISOString() });
  release();
  assert.equal(readJSON(lock).task, 'other');
});

test('an unreadable leftover lock is also recovered', t => {
  const f = prepare(t), lock = safePath(f.root, 'migration/run.lock');
  atomicWrite(lock, '{"pid":');
  lockRun(f.root, 'translation')();
  assert.equal(fs.existsSync(lock), false);
});

test('service and network timeouts are retried; the kit\'s own explicit deadline and cancellation are final', () => {
  const error = (message, stderr = '') => Object.assign(new Error(message), { result: { stderr } });
  for (const message of ['Copilot reviewer failed (exit 1): request timed out', 'session.error: Connection timed out',
    'Copilot surveyor failed (exit 1)', 'upstream timed out while waiting for the model'])
    assert.equal(isTransientFailure(message === 'Copilot surveyor failed (exit 1)' ? error(message, 'Error: Request timed out') : error(message)), true, message);
  for (const message of ['Process timed out after 600000ms (explicit bounded deadline)', 'Copilot CLI model list timed out after 30 s (explicit deadline)',
    'Interrupted by the user', 'tests timed out: 3 failing'])
    assert.equal(isTransientFailure(error(message)), false, message);
});

test('manifest checks still reject overlaps after resolving each protected path once', t => {
  const f = prepare(t, { count: 3 });
  assert.equal(readManifest(f.root, f.config).length, 3);
  const manifest = safePath(f.root, 'migration/manifest.tsv'), text = fs.readFileSync(manifest, 'utf8');
  const [header, first] = text.split('\n');
  atomicWrite(manifest, `${header}\n${first}\n${first.split('\t')[0]}\tmigration/out.mjs\n`);
  assert.throws(() => readManifest(f.root, f.config), /outside outputRoots|overlaps protected|Duplicate manifest mapping/);
  atomicWrite(manifest, text);
  assert.equal(readManifest(f.root, f.config).length, 3);
});

test('a lock written on another host is never recovered automatically, and unlock can clear it', async t => {
  const f = prepare(t), lock = safePath(f.root, 'migration/run.lock');
  // On a shared folder the other host's live PID is invisible here.
  writeJSON(lock, { pid: deadPid(), host: `${os.hostname()}-other`, task: 'survey', startedAt: new Date().toISOString() });
  assert.throws(() => lockRun(f.root, 'translation'), /on host .*-other.*unlock --pid/s);
  assert.equal(readJSON(lock).task, 'survey');
  const log = console.log; console.log = () => {};
  try { await main(['unlock', '--root', f.root, '--pid', String(readJSON(lock).pid)]); } finally { console.log = log; }
  assert.equal(fs.existsSync(lock), false);
});

test('a recovery claim left by a dead recoverer is cleared, and the build-loop lock recovers the same way', t => {
  const f = prepare(t), lock = safePath(f.root, 'migration/run.lock');
  writeJSON(lock, { pid: deadPid(), task: 'survey', startedAt: new Date().toISOString() });
  writeJSON(`${lock}.recover`, { pid: deadPid(), host: os.hostname(), token: 'dead' });
  lockRun(f.root, 'translation')();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(`${lock}.recover`), false);
  const loop = safePath(f.root, 'migration/build-loop.lock');
  writeJSON(loop, { pid: deadPid(), grantId: 'old', startedAt: new Date().toISOString() });
  const release = acquireBuildLoop(f.root, 'new');
  assert.equal(readJSON(loop).grantId, 'new');
  assert.equal(readJSON(loop).host, os.hostname());
  release();
  assert.equal(fs.existsSync(loop), false);
});

test('quick commands get the liveness notice without an opening line', async () => {
  const messages = [];
  await commandProgress('phase check', async () => new Promise(resolve => setTimeout(resolve, 30)), { intervalMs: 5, write: m => messages.push(m), announce: false });
  assert.ok(messages.length >= 1);
  assert.ok(messages.every(m => m.includes('still running')));
});

test('a recovery claim held by a live process names itself and unlock clears it', t => {
  const f = prepare(t), lock = safePath(f.root, 'migration/run.lock'), claim = `${lock}.recover`;
  writeJSON(lock, { pid: deadPid(), task: 'survey', startedAt: new Date().toISOString() });
  // A reused PID: alive here, but no recoverer is at work.
  writeJSON(claim, { pid: process.pid, host: os.hostname(), token: 'reused' });
  assert.throws(() => lockRun(f.root, 'translation'), /recovery claim run\.lock\.recover is held by pid \d+.*unlock --pid/);
  assert.equal(readJSON(claim).token, 'reused');
});

test('unlock reports a missing lock plainly and refuses a PID that owns nothing', async t => {
  const f = prepare(t), log = console.log, out = [];
  console.log = m => out.push(m);
  try { await main(['unlock', '--root', f.root, '--pid', '12345']); } finally { console.log = log; }
  assert.deepEqual(out, ['No migration lock to remove']);
  writeJSON(safePath(f.root, 'migration/run.lock'), { pid: process.pid, task: 'survey' });
  await assert.rejects(main(['unlock', '--root', f.root, '--pid', '12345']), /exact lock owner PID/);
});

test('unlock clears a build-loop lock or claim from another host, and status reports a foreign run lock honestly', async t => {
  const f = prepare(t), loop = safePath(f.root, 'migration/build-loop.lock');
  writeJSON(loop, { pid: process.pid, host: `${os.hostname()}-other`, grantId: 'remote' });
  assert.throws(() => acquireBuildLoop(f.root, 'mine'), /held by pid \d+ on host .*-other.*unlock --pid/);
  writeJSON(`${loop}.recover`, { pid: 424242, host: `${os.hostname()}-other`, token: 'x' });
  const log = console.log, out = []; console.log = m => out.push(m);
  try {
    await main(['unlock', '--root', f.root, '--pid', String(process.pid)]);
    await main(['unlock', '--root', f.root, '--pid', '424242']);
  } finally { console.log = log; }
  assert.equal(fs.existsSync(loop), false); assert.equal(fs.existsSync(`${loop}.recover`), false);
  assert.match(out.join('\n'), /build-loop\.lock\n.*build-loop\.lock\.recover/);
  writeJSON(safePath(f.root, 'migration/run.lock'), { pid: process.pid, host: `${os.hostname()}-other`, task: 'survey' });
  const report = migrationStatus(f.root);
  assert.notEqual(report.running, true);
  assert.equal(report.foreignLock.host, `${os.hostname()}-other`);
  assert.equal(report.staleLock, undefined);
});

test('dependency-targets picks flagged files first, then the largest, and writes its report', t => {
  const f = prepare(t, { count: 3 });
  const files = Object.keys(readJSON(safePath(f.root, 'migration/review-dependencies.json')).dependencies).sort();
  assert.ok(files.length >= 3);
  const [first, second, third] = files, rel = p => p.slice(p.indexOf('/') + 1), root = first.slice(0, first.indexOf('/'));
  fs.appendFileSync(safePath(f.root, third), '\n'.padEnd(5000, '#'));
  // unresolved.tsv paths are relative to the parser root, as the mappers write them.
  atomicWrite(safePath(f.root, 'migration/depmap/unresolved.tsv'), `file\treference\treason\n${rel(second)}\tfoo\tunresolved import\n${rel(second)}\tbar\tunresolved import\n${rel(first)}\tbaz\tdynamic\n`);
  const result = preparationCommand(f.root, f.config, 'dependency-targets', { size: '3', 'depmap-root': root });
  assert.deepEqual(result.files, [second, first, third]);
  assert.equal(result.flaggedFiles, 2);
  assert.match(result.reasons[third], /largest/);
  assert.deepEqual(readJSON(safePath(f.root, 'migration/depmap/audit-targets.json')).files, result.files);
  // Without an unresolved file it still selects, by size.
  fs.rmSync(safePath(f.root, 'migration/depmap/unresolved.tsv'));
  assert.equal(preparationCommand(f.root, f.config, 'dependency-targets', { size: '1' }).files[0], third);
  assert.throws(() => preparationCommand(f.root, f.config, 'dependency-targets', { size: '0' }), /size/);
});

test('dependency-targets defaults the parser root, reports unmatched rows, keeps within the input size and protects mapper outputs', t => {
  const f = prepare(t, { count: 3 });
  const files = Object.keys(readJSON(safePath(f.root, 'migration/review-dependencies.json')).dependencies).sort();
  const [first, second] = files, rel = p => p.slice(p.indexOf('/') + 1);
  assert.equal(f.config.sourceRoots.length, 1);
  // A single source root is the parser root by default, as in make_review_dependencies.
  atomicWrite(safePath(f.root, 'migration/depmap/unresolved.tsv'), `file\treference\treason\n${rel(second)}\tfoo\tunresolved import\nelsewhere/x.py\tbar\tunresolved import\n`);
  const result = preparationCommand(f.root, f.config, 'dependency-targets', { size: '1' });
  assert.equal(result.depmapRoot, f.config.sourceRoots[0]);
  assert.deepEqual(result.files, [second]);
  assert.deepEqual(result.unmatchedUnresolvedFiles, ['elsewhere/x.py']);
  // With "." the paths are used as written, so the same rows no longer match.
  const dot = preparationCommand(f.root, f.config, 'dependency-targets', { size: '1', 'depmap-root': '.' });
  assert.equal(dot.flaggedFiles, 0);
  assert.deepEqual(dot.unmatchedUnresolvedFiles, ['elsewhere/x.py', rel(second)].sort());
  // Several source roots need an explicit parser root.
  assert.throws(() => preparationCommand(f.root, { ...f.config, sourceRoots: [f.config.sourceRoots[0], 'other'] }, 'dependency-targets', {}), /--depmap-root/);
  // A file that would not fit into one frozen audit input is skipped and counted.
  fs.appendFileSync(safePath(f.root, first), '\n'.padEnd(4000, '#'));
  const small = preparationCommand(f.root, { ...f.config, maxReviewInputBytes: 3000 }, 'dependency-targets', { size: '3' });
  assert.equal(small.files.includes(first), false);
  assert.ok(small.skippedForInputSize.includes(first));
  assert.equal(small.skippedForInputSizeCount >= 1, true);
  // Reports never overwrite the mapper's own files.
  for (const out of ['migration/depmap/edges.tsv', 'migration/depmap/unresolved.tsv', 'migration/depmap/report.md']) {
    assert.throws(() => preparationCommand(f.root, f.config, 'dependency-targets', { out }), /cannot replace mapper output/);
  }
  assert.match(fs.readFileSync(safePath(f.root, 'migration/depmap/unresolved.tsv'), 'utf8'), /elsewhere/);
});

test('dependency-targets reads unresolved rows leniently, skips files freeze cannot read and refuses a missing named list', t => {
  const f = prepare(t, { count: 3 });
  const files = Object.keys(readJSON(safePath(f.root, 'migration/review-dependencies.json')).dependencies).sort();
  const [first, second, third] = files, rel = p => p.slice(p.indexOf('/') + 1);
  // An empty reference cell or an odd path is reported, not a reason to stop.
  atomicWrite(safePath(f.root, 'migration/depmap/unresolved.tsv'), `file\treference\treason\n${rel(second)}\t\tunresolved import\nC:\\odd\\x.py\tbar\tunresolved\n# note\n`);
  const result = preparationCommand(f.root, f.config, 'dependency-targets', { size: '5' });
  assert.equal(result.files[0], second);
  assert.equal(result.files.length, files.length);
  assert.deepEqual(result.unmatchedUnresolvedFiles, ['C:\\odd\\x.py']);
  assert.equal(result.unmatchedUnresolvedCount, 1);
  // A file that is not UTF-8 text cannot be frozen, so it is left out and listed.
  fs.writeFileSync(safePath(f.root, third), Buffer.from([0x82, 0xa0, 0xff, 0xfe, 0x00]));
  const text = preparationCommand(f.root, f.config, 'dependency-targets', { size: '5' });
  assert.equal(text.files.includes(third), false);
  assert.deepEqual(text.skippedNotUtf8Text, [third]);
  assert.ok(text.files.includes(first));
  assert.throws(() => preparationCommand(f.root, f.config, 'dependency-targets', { unresolved: 'migration/depmap/unresolvd.tsv' }), /not found/);
  assert.throws(() => preparationCommand(f.root, f.config, 'dependency-targets', { out: 'migration/depmap/Edges.TSV' }), /cannot replace mapper output/);
});
