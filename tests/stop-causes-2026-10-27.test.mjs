// SPDX-License-Identifier: Apache-2.0
// Stops that a rerun would only repeat (2026-10-27): stale locks, external
// timeouts and repeated manifest path resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { prepare } from './helpers.mjs';
import { safePath, writeJSON, readJSON, lockRun, readManifest, atomicWrite } from '../lib/core.mjs';
import { isTransientFailure } from '../lib/failures.mjs';
import { migrationStatus } from '../lib/status.mjs';

const deadPid = () => {
  // A child that has exited and been reaped: its PID no longer exists.
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(child.stdout.trim());
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
