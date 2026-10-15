// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, fake } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, atomicWrite, writeJSON, fileHash, loadConfig, contextHash, done, unitState, statePath, readRepairIntent, repairIntentPath } from '../lib/core.mjs';
import { approve, runStage, translate, requireGate } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { makeRepairQueue } from '../scripts/diagnostic_queue.mjs';
import { mergeInventory } from '../lib/preparation.mjs';
import { migrationStatus } from '../lib/status.mjs';
import { runProcess } from '../lib/process.mjs';

const write = (f, name, value) => atomicWrite(safePath(f.root, name), value);
async function repairFixture(t, { count = 3, concurrency = 2 } = {}) {
  const f = prepare(t, { count });
  f.config.phasePolicy = 'strict'; f.config.concurrency = concurrency;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) write(f, name, 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  await runStage(f.root, f.config, 'judge');
  phaseCommand(f.root, f.config, 'complete', '03', { note: 'Synthetic stress fixture only' });
  approve(f.root, f.config, 'translation', 'Fixture authorizes these exact outputs');
  await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Fixture build snapshot'); await runStage(f.root, f.config, 'build');
  const targets = count === 3 ? ['ported/math_ops.mjs', 'ported/main.mjs'] : f.units.map(u => u.target);
  write(f, 'migration/build-diagnostics.tsv', 'file\tmodule\tcode\tmessage\n' + targets.map((target, i) => `${target}\tslice-${i}\tCHECK\tExplicit diagnostic for ${target}\n`).join(''));
  f.queue = makeRepairQueue(f.root, f.config, { diagnostics: 'migration/build-diagnostics.tsv' });
  return f;
}

test('Astra F1: interrupted dependent repair retains every diagnostic, blocks build and resumes blind reviews', async t => {
  const f = await repairFixture(t), controller = new AbortController();
  const main = f.units.find(u => u.target === 'ported/main.mjs'), oldReceipt = fs.readFileSync(statePath(f.root, main));
  await assert.rejects(translate(f.root, f.config, call => { controller.abort(); return fake(call); },
    { repairQueue: 'migration/repair-queue.json', signal: controller.signal }), /Interrupted/);
  const context = contextHash(f.root, f.config), status = migrationStatus(f.root);
  assert.equal(unitState(f.root, main).status, 'done'); // Never started, but its old receipt cannot satisfy the admitted repair.
  assert.equal(done(f.root, main, context), false);
  assert.deepEqual(status.pendingRepairs.sort(), ['ported/main.mjs', 'ported/math_ops.mjs']);
  assert.equal(status.done, 1);
  assert.throws(() => approve(f.root, f.config, 'build', 'Must not skip the dependent diagnostic'), /reviewed receipts/);
  assert.throws(() => approve(f.root, f.config, 'translation', 'Cannot drop pending work', { targets: ['ported/math_ops.mjs'] }), /unfinished repair/);
  await assert.rejects(translate(f.root, f.config, fake, { repairQueue: 'migration/repair-queue.json' }), /stale/);
  const seen = [];
  const report = await translate(f.root, f.config, call => {
    seen.push({ target: call.unit.target, input: call.reviewInput }); return fake(call);
  });
  assert.equal(report.agentCalls, 4); assert.equal(report.done, 3); assert.equal(report.scopeComplete, true);
  assert.deepEqual(report.pendingRepairs, []);
  for (const job of f.queue.jobs) {
    const reviews = seen.filter(c => c.target === job.target);
    assert.equal(reviews.length, 2); assert.equal(reviews[0].input, reviews[1].input);
    assert.match(JSON.parse(reviews[0].input).diagnostic, new RegExp(`Explicit diagnostic for ${job.target.replaceAll('.', '\\.')}`));
  }
  approve(f.root, f.config, 'build', 'All frozen repair diagnostics received fresh reviews');
  assert.equal((await runStage(f.root, f.config, 'build')).success, true);
  // Restoring a valid pre-repair receipt must not erase the admitted obligation.
  atomicWrite(statePath(f.root, main), oldReceipt);
  assert.equal(done(f.root, main, context), false);
  assert.throws(() => approve(f.root, f.config, 'build', 'Old receipt'), /reviewed receipts/);
});

test('Astra F1: a stop before the first worker persists the whole repair intent', async t => {
  const f = await repairFixture(t, { count: 2 }); let calls = 0;
  await assert.rejects(translate(f.root, f.config, call => { calls++; return fake(call); }, {
    repairQueue: 'migration/repair-queue.json', onProgress: e => { if (e.stage === 'repair-planned') throw new Error('Simulated coordinator stop before worker dispatch'); }
  }), /before worker dispatch/);
  assert.equal(calls, 0);
  const context = contextHash(f.root, f.config), intent = readRepairIntent(f.root, context);
  assert.equal(intent.jobs.length, 2); assert.equal(migrationStatus(f.root).done, 0);
  assert.throws(() => requireGate(f.root, f.config, 'build', context), /missing or stale/);
  const report = await translate(f.root, f.config, fake);
  assert.equal(report.agentCalls, 4); assert.equal(report.done, 2); assert.deepEqual(report.pendingRepairs, []);
});

test('Astra F1: completed independent repairs survive Stop while untouched slices resume under the same cap', async t => {
  const f = await repairFixture(t, { count: 2, concurrency: 1 }), controller = new AbortController();
  await assert.rejects(translate(f.root, f.config, fake, {
    repairQueue: 'migration/repair-queue.json', signal: controller.signal,
    onProgress: e => { if (e.stage === 'done') controller.abort(); }
  }), /Interrupted/);
  const before = migrationStatus(f.root);
  assert.equal(before.done, 1); assert.equal(before.pendingRepairs.length, 1);
  let active = 0, maximum = 0; const seen = [];
  const report = await translate(f.root, f.config, async call => {
    seen.push(call.unit.target); maximum = Math.max(maximum, ++active);
    try { await new Promise(resolve => setTimeout(resolve, 10)); return fake(call); } finally { active--; }
  });
  assert.deepEqual([...new Set(seen)], before.pendingRepairs); assert.equal(seen.length, 2);
  assert.equal(maximum, 1); assert.equal(report.done, 2); assert.deepEqual(report.pendingRepairs, []);
});

test('Astra F1: immutable repair proof changes cannot be counted as reviewed completion', async t => {
  const f = await repairFixture(t, { count: 2 });
  await translate(f.root, f.config, fake, { repairQueue: 'migration/repair-queue.json' });
  const context = contextHash(f.root, f.config), intent = readRepairIntent(f.root, context);
  const archive = repairIntentPath(f.root, intent.id), original = fs.readFileSync(archive);
  fs.appendFileSync(archive, '\n');
  assert.equal(done(f.root, f.units[0], context), false);
  assert.throws(() => approve(f.root, f.config, 'build', 'Changed evidence'), /reviewed receipts/);
  await assert.rejects(translate(f.root, f.config, fake), /receipt missing or changed/);
  atomicWrite(archive, original);
  assert.equal(done(f.root, f.units[0], context), true);
});

test('repair completion is published only after final candidate checks, including when Stop arrives there', async t => {
  const f = await repairFixture(t, { count: 2 }), controller = new AbortController();
  let observed = false;
  await assert.rejects(translate(f.root, f.config, fake, {
    repairQueue: 'migration/repair-queue.json', signal: controller.signal,
    onProgress: e => {
      if (e.stage === 'validating') {
        observed = true;
        const unit = f.units.find(u => u.target === e.unit);
        assert.equal(done(f.root, unit, contextHash(f.root, f.config)), false);
        controller.abort();
      }
    }
  }), /interrupt|aborted/i);
  assert.equal(observed, true); assert.equal(migrationStatus(f.root).done, 0);
  assert.throws(() => approve(f.root, f.config, 'build', 'Checks interrupted'), /reviewed receipts/);
});

test('Astra F2: fixed merge receipts cannot overwrite configured inputs, including file aliases', t => {
  for (const kind of ['designInputs', 'verificationInputs', 'reviewDependencyMap', 'hardlink']) {
    const f = prepare(t), receipt = 'migration/inventory-merge.json';
    write(f, receipt, 'Existing reviewed input that must survive.\n');
    if (kind === 'hardlink') {
      const alias = 'migration/ARCHITECTURE.md'; fs.linkSync(safePath(f.root, receipt), safePath(f.root, alias));
      f.config.designInputs = [alias];
    } else f.config[kind] = kind === 'reviewDependencyMap' ? receipt : [receipt];
    writeJSON(safePath(f.root, 'migration/config.json'), f.config);
    const inputHash = fileHash(safePath(f.root, receipt)), inventoryHash = fileHash(safePath(f.root, 'migration/inventory.tsv'));
    assert.throws(() => loadConfig(f.root), /runtime state/);
    assert.throws(() => mergeInventory(f.root, f.config, { shards: ['migration/inventory-shards/a.tsv'], sites: 'migration/inventory-sites.tsv' }), /protected/);
    assert.equal(fileHash(safePath(f.root, receipt)), inputHash);
    assert.equal(fileHash(safePath(f.root, 'migration/inventory.tsv')), inventoryHash);
  }
});

test('Astra F3: published translate and queue commands reach the real phase gate without argument errors', async t => {
  const f = prepare(t); f.config.phasePolicy = 'strict'; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const commands = fs.readFileSync(path.join(kitRoot, 'docs/EXECUTION-SCOPES.md'), 'utf8').split('\n')
    .filter(line => /^node migration-kit\/scripts\/run_migration\.mjs (translate|repair)\b/.test(line));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    const [program, ...argv] = command.split(/\s+/);
    assert.equal(program, 'node');
    const response = await runProcess(process.execPath, argv, { cwd: f.root, timeoutMs: 20000 });
    assert.equal(response.code, 1); assert.match(response.stderr, /Phase 03 is not reviewed/);
    assert.doesNotMatch(response.stderr, /Missing value/);
  }
});
