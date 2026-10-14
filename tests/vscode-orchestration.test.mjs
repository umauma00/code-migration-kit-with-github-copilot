// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, ready, fake, result } from './helpers.mjs';
import { install } from '../scripts/install.mjs';
import { loadConfig, writeJSON, safePath, contextHash, done, readJSON, lockRun, statePath, atomicWrite } from '../lib/core.mjs';
import { approve, runStage, translate, requireGate, currentRecord } from '../lib/pipeline.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';

function sourceFixture(t) {
  const f = prepare(t);
  f.config.verificationMode = 'source-only';
  f.config.commands.original = f.config.commands.mutation = [process.execPath, '-e', 'process.exit(77)'];
  f.config.commands.parity = null;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  writeJSON(safePath(f.root, 'migration/judge-plan.json'), {
    schemaVersion: 1, verificationMode: 'source-only', method: 'Inspect public arithmetic contracts',
    sources: ['src/math_ops.py'], scenarios: [{path: 'tests/judge.py', contract: 'Floor division and zero errors', expectationBasis: 'source-inferred'}],
    unverified: ['Original runtime and behavioral equivalence have not been executed']
  });
  return f;
}
async function approvedSource(t) {
  const f = sourceFixture(t); await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Reviewed source-derived plan and prototype'); return f;
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

test('source-only executes reviewed implementation/build/smoke/handoff without original or parity', async t => {
  const f = await approvedSource(t);
  assert.equal(readJSON(safePath(f.root, 'migration/results/judge.json')).commands.length, 0);
  assert.equal(readJSON(safePath(f.root, 'migration/results/judge.json')).equivalence, 'unverified');
  await translate(f.root, f.config, fake);
  for (const stage of ['build', 'smoke']) { approve(f.root, f.config, stage, `Reviewed ${stage}`); await runStage(f.root, f.config, stage); }
  assert.throws(() => approve(f.root, f.config, 'parity', 'No parity'), /unverified/);
  await assert.rejects(runStage(f.root, f.config, 'parity'), /unverified/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/results/parity.json')), false);
  atomicWrite(safePath(f.root, 'migration/handoff.md'), 'Reviewed source migration, build and smoke; equivalence unverified. Runtime parity pending.');
  approve(f.root, f.config, 'handoff', 'Reviewed smoke and explicit unverified handoff');
  const receipt = await runStage(f.root, f.config, 'handoff');
  assert.equal(receipt.success, true); assert.equal(receipt.equivalence, 'unverified');
  const report = migrationStatus(f.root);
  assert.equal(report.equivalence, 'unverified'); assert.match(report.outcome, /equivalence unverified/);
  assert.equal(report.phases.find(p => p.id === '05c').status, 'unverified (not run in this mode)');
  atomicWrite(safePath(f.root, 'migration/handoff.md'), 'Changed handoff');
  assert.throws(() => requireGate(f.root, f.config, 'handoff', contextHash(f.root, f.config)), /stale/);
  assert.equal(currentRecord(f.root, f.config, 'handoff', contextHash(f.root, f.config)), false);
});

test('source-only rejects empty, inferred-as-observed, missing and protected plan evidence', async t => {
  const f = sourceFixture(t), file = safePath(f.root, 'migration/judge-plan.json'), good = readJSON(file);
  for (const field of ['sources', 'scenarios', 'unverified']) {
    writeJSON(file, {...good, [field]: []}); await assert.rejects(runStage(f.root, f.config, 'judge'), /nonempty/);
  }
  for (const p of ['missing.py', 'migration/state/fake.json', 'ported/math_ops.mjs', 'tests/missing.py']) {
    writeJSON(file, {...good, scenarios: [{...good.scenarios[0], path: p}]});
    await assert.rejects(runStage(f.root, f.config, 'judge'), /input path|Missing or empty/);
  }
  writeJSON(file, {...good, scenarios: [{...good.scenarios[0], expectationBasis: 'original-observed'}]});
  await assert.rejects(runStage(f.root, f.config, 'judge'), /source-inferred/);
  const link = safePath(f.root, 'tests/link.py'); fs.symlinkSync('judge.py', link);
  writeJSON(file, {...good, scenarios: [{...good.scenarios[0], path: 'tests/link.py'}]});
  await assert.rejects(runStage(f.root, f.config, 'judge'), /Symlinks/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('plan references and mode changes invalidate source-only approvals and reviewed units', async t => {
  const f = await approvedSource(t); await translate(f.root, f.config, fake);
  const before = contextHash(f.root, f.config);
  assert.equal(done(f.root, f.units[0], before), true);
  fs.appendFileSync(safePath(f.root, 'tests/judge.py'), '\n# Changed contract\n');
  const after = contextHash(f.root, f.config); assert.notEqual(before, after);
  assert.equal(done(f.root, f.units[0], after), false);
  assert.throws(() => requireGate(f.root, f.config, 'translation', after), /stale/);
  f.config.verificationMode = 'runtime';
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  assert.notEqual(contextHash(f.root, f.config), after);
  assert.throws(() => approve(f.root, f.config, 'handoff', 'Invalid runtime bypass'), /runtime requires parity/);
});

test('handoff requires nonempty report and current smoke; rerun smoke invalidates receipt', async t => {
  const f = await approvedSource(t); await translate(f.root, f.config, fake);
  atomicWrite(safePath(f.root, 'migration/handoff.md'), '');
  assert.throws(() => approve(f.root, f.config, 'handoff', 'Empty'), /artifact required/);
  atomicWrite(safePath(f.root, 'migration/handoff.md'), 'Source-only; parity unverified');
  assert.throws(() => approve(f.root, f.config, 'handoff', 'Missing smoke'), /Run smoke/);
  for (const stage of ['build', 'smoke']) { approve(f.root, f.config, stage, 'Current reviewed output'); await runStage(f.root, f.config, stage); }
  approve(f.root, f.config, 'handoff', 'Reviewed handoff'); await runStage(f.root, f.config, 'handoff');
  await runStage(f.root, f.config, 'smoke');
  assert.equal(currentRecord(f.root, f.config, 'handoff', contextHash(f.root, f.config)), false);
  assert.throws(() => requireGate(f.root, f.config, 'handoff', contextHash(f.root, f.config)), /No handoff/);
});

test('status after initialization reads candidates and blockers without dispatch or mutation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-status-')); t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  install(root, {apply:true, model:'test-double'});
  const before = fs.readFileSync(safePath(root, 'migration/config.json'));
  const report = migrationStatus(root);
  assert.equal(report.total, 0); assert.equal(report.running, false); assert.equal(report.implementationReady, false);
  assert.equal(report.phases.length, 10); assert.ok(report.blockers.length);
  assert.match(statusMarkdown(report), /time not calculated/);
  assert.deepEqual(fs.readFileSync(safePath(root, 'migration/config.json')), before);
  assert.equal(fs.existsSync(safePath(root, 'migration/run.lock')), false);
  atomicWrite(safePath(root, 'migration/config.json'), '{');
  assert.match(migrationStatus(root).blockers[0].reason, /JSON|property/i);
});

test('status identifies live roles and stopped stale state without fabricating completion', async t => {
  const f = await ready(t), hold = defer(), entered = defer();
  const run = translate(f.root, f.config, async call => { entered.resolve(); await hold.promise; return fake(call); });
  await entered.promise;
  const report = migrationStatus(f.root);
  assert.equal(report.running, true); assert.equal(report.units[0].status, 'implement');
  assert.deepEqual(report.units[0].activeRoles.map(a => a.role), ['implementer']);
  assert.equal(report.nextActions.some(a => /Run or resume translate|approve build/.test(a)), false);
  assert.ok(report.nextActions.some(a => /Monitor the active translation/.test(a)));
  hold.resolve(); await run;
  assert.equal(migrationStatus(f.root).done, 1);
  fs.appendFileSync(safePath(f.root, f.units[0].target), '\n// edit');
  const stopped = migrationStatus(f.root); assert.equal(stopped.done, 0); assert.equal(stopped.units[0].status, 'stopped');
});

test('scheduler refills an independent slot before the slow unit finishes and respects AI cap', async t => {
  const f = await ready(t, {count:3});
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), {schemaVersion:1, dependencies: {'src/math_ops.py':[], 'src/text_ops.py':[], 'src/main.py':[]}});
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Independent fixture');
  const hold = defer(), third = defer(); let active = 0, maximum = 0, slowFinished = false;
  const running = translate(f.root, f.config, async call => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (call.unit === f.units[0] || call.unit.target === f.units[0].target) {
        if (call.role === 'implementer') { await hold.promise; slowFinished = true; }
      }
      if (call.unit.target === f.units[2].target && call.role === 'implementer') { assert.equal(slowFinished, false); third.resolve(); }
      return await fake(call);
    } finally { active--; }
  });
  await third.promise; hold.resolve(); const report = await running;
  assert.equal(report.done, 3); assert.ok(maximum <= f.config.concurrency);
});

test('manifest dependencies run after reviewed predecessors; external source is not a nonexistent job', async t => {
  const f = await ready(t, {count:3}); const events = [];
  await translate(f.root, f.config, async call => {
    if (call.unit.target === 'ported/main.mjs') assert.ok(f.units.slice(0,2).every(u => done(f.root, u, contextHash(f.root, f.config))));
    events.push(call.unit.target); return fake(call);
  });
  assert.ok(events.includes('ported/main.mjs'));
  const only = await ready(t, {count:1});
  writeJSON(safePath(only.root, 'migration/review-dependencies.json'), {schemaVersion:1, dependencies: {'src/math_ops.py':['src/text_ops.py'], 'src/text_ops.py':[]}});
  await runStage(only.root, only.config, 'judge'); approve(only.root, only.config, 'translation', 'Fixed non-manifest dependency');
  assert.equal((await translate(only.root, only.config, fake)).done, 1);
});

test('cycles cannot hang: typecheck gives actionable rejection, fixed-source cycles complete', async t => {
  const f = await ready(t, {count:2});
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), {schemaVersion:1, dependencies: {'src/math_ops.py':['src/text_ops.py'], 'src/text_ops.py':['src/math_ops.py']}});
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Cycle fixture');
  let calls = 0; await assert.rejects(translate(f.root, f.config, async c => { calls++; return fake(c); }), /Cyclic.*atomic unit/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  f.config.commands.typecheck = null; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Deferred unit check for fixed-source cycle');
  assert.equal((await translate(f.root, f.config, fake)).done, 2);
});

test('cancellation preserves successful independent review and releases lock for resume', async t => {
  const f = await ready(t), abort = new AbortController(); let reviewCalls = [];
  await assert.rejects(translate(f.root, f.config, async call => {
    if (call.role === 'reviewer-rules') { await new Promise(setImmediate); abort.abort(); throw new Error('Interrupted'); }
    return fake(call);
  }, {signal:abort.signal}), /Translation stopped/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  const report = await translate(f.root, f.config, async call => { reviewCalls.push(call.role); return fake(call); });
  assert.equal(report.done, 1); assert.deepEqual(reviewCalls, ['reviewer-rules']);
});

test('explicit installer mode is retained on reinstall and legacy absent mode stays runtime', t => {
  for (const layout of ['repository', 'plugin']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-mode-')); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    install(root, {apply:true, model:'test-double', layout, verificationMode:'source-only'});
    assert.equal(loadConfig(root).verificationMode, 'source-only');
    install(root, {apply:true, model:'test-double', layout, verificationMode:'runtime'});
    assert.equal(loadConfig(root).verificationMode, 'source-only');
    const c = loadConfig(root); delete c.verificationMode; writeJSON(safePath(root, 'migration/config.json'), c);
    assert.equal(loadConfig(root).verificationMode, undefined);
    assert.equal(migrationStatus(root).verificationMode, 'runtime');
  }
});

test('active validation stage matches lock execution identity and gives monitor advice, not a blocker', async t => {
  const f = prepare(t);
  f.config.commands.build = [process.execPath, '-e', "const fs=require('node:fs');fs.writeFileSync('migration/build-entered','ready');const t=setInterval(()=>{if(fs.existsSync('migration/build-release')){clearInterval(t)}},10)"];
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Held build fixture');
  await translate(f.root, f.config, fake); approve(f.root, f.config, 'build', 'Reviewed output');
  const controller = new AbortController();
  const running = runStage(f.root, f.config, 'build', {signal:controller.signal});
  t.after(async () => {controller.abort(); await running.catch(() => {});});
  const until = Date.now() + 5000;
  while (!fs.existsSync(safePath(f.root, 'migration/build-entered')) && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  assert.ok(fs.existsSync(safePath(f.root, 'migration/build-entered')), 'build reached held command');
  const report = migrationStatus(f.root);
  assert.equal(report.phases.find(p => p.id === '05').status, 'running');
  assert.equal(report.blockers.some(b => b.path === 'migration/results/build.json'), false);
  assert.equal(report.nextActions.some(a => /approve build|run build|rerunning build/.test(a)), false);
  assert.ok(report.nextActions.some(a => /Monitor the active build/.test(a)));
  const original = readJSON(safePath(f.root, 'migration/results/build.json'));
  writeJSON(safePath(f.root, 'migration/results/build.json'), {...original, executionId:'stale-execution'});
  assert.equal(migrationStatus(f.root).phases.find(p => p.id === '05').status, 'pending');
  writeJSON(safePath(f.root, 'migration/results/build.json'), original);
  atomicWrite(safePath(f.root, 'migration/build-release'), 'release'); await running;
  assert.equal(migrationStatus(f.root).phases.find(p => p.id === '05').status, 'validated');
});

test('empty manifest is never implementation-ready even with judge and approval', async t => {
  const f = prepare(t);
  atomicWrite(safePath(f.root, 'migration/manifest.tsv'), 'source\ttarget\n');
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Preparation only');
  const report = migrationStatus(f.root);
  assert.equal(report.total, 0); assert.equal(report.implementationReady, false);
  assert.ok(report.blockers.some(b => /Manifest is empty/.test(b.reason)));
  await assert.rejects(translate(f.root, f.config, fake), /Manifest is empty/);
});

test('active coordinator attempt collection ignores unrelated native answers and continues after malformed attempts', async t => {
  const f = await ready(t), hold = defer(), entered = defer();
  const running = translate(f.root, f.config, async c => { if(c.role === 'implementer') {entered.resolve(); await hold.promise;} return fake(c); });
  t.after(async () => {hold.resolve(); await running.catch(() => {});});
  await entered.promise;
  const initial = migrationStatus(f.root), runId = initial.lock.runId;
  atomicWrite(safePath(f.root, `migration/runs/${runId}/native/unrelated/response.json`), 'null');
  atomicWrite(safePath(f.root, `migration/runs/${runId}/unrelated.json`), '{');
  const malformed = `migration/runs/${runId}/${f.units[0].id}-0-implementer-ffffffff.json`;
  atomicWrite(safePath(f.root, malformed), '{');
  const report = migrationStatus(f.root);
  assert.deepEqual(report.units[0].activeRoles.map(a => a.role), ['implementer']);
  assert.ok(report.blockers.some(b => b.path === malformed));
  assert.equal(report.blockers.some(b => /unrelated/.test(b.path)), false);
  hold.resolve(); await running;
});

test('a failed reviewer stops the queued review and new unit while preserving the original cause', async t => {
  const f = prepare(t, {count:2}); f.config.concurrency = 1;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Serial failure fixture');
  const calls = [];
  await assert.rejects(translate(f.root, f.config, async c => {
    calls.push(`${c.role}:${c.unit.target}`);
    if(c.role === 'reviewer-semantics') throw new Error('Concrete reviewer transport failure');
    return fake(c);
  }), /Concrete reviewer transport failure/);
  assert.deepEqual(calls, ['implementer:ported/math_ops.mjs', 'reviewer-semantics:ported/math_ops.mjs']);
  assert.equal(fs.existsSync(safePath(f.root, 'ported/text_ops.mjs')), false);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('pre-aborted source-only stage preserves prior evidence without lock or invalidation', async t => {
  const f = await approvedSource(t);
  const judge = fs.readFileSync(safePath(f.root, 'migration/results/judge.json'));
  const gate = fs.readFileSync(safePath(f.root, 'migration/gates/translation.json'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runStage(f.root, f.config, 'judge', {signal:controller.signal}), /Interrupted/);
  assert.deepEqual(fs.readFileSync(safePath(f.root, 'migration/results/judge.json')), judge);
  assert.deepEqual(fs.readFileSync(safePath(f.root, 'migration/gates/translation.json')), gate);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('actual calls exclude a reserved review stopped by reviewer failure', async t => {
  const f = await ready(t); f.config.concurrency = 1;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Serial failure fixture');
  let calls = 0;
  await assert.rejects(translate(f.root, f.config, async call => {
    calls++; if (call.role === 'reviewer-semantics') throw new Error('review failed'); return fake(call);
  }), /review failed/);
  const runs = fs.readdirSync(safePath(f.root, 'migration/runs'));
  const summary = readJSON(safePath(f.root, `migration/runs/${runs[0]}/summary.json`));
  assert.equal(calls, 2); assert.equal(summary.agentCalls, 2);
});

for (const corruption of ['missing rulebook', 'malformed dependencies']) test(`fatal scheduler input ${corruption} drains held worker under lock`, async t => {
  const f = await ready(t, {count:3}); f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), {schemaVersion:1, dependencies: Object.fromEntries(f.units.map(u => [u.source, []]))});
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Independent held workers');
  const held = defer(), entered = defer(), detected = defer(); let returned = false, thirdCalls = 0, damageScheduled = false;
  const running = translate(f.root, f.config, async call => {
    if (call.unit.target === f.units[1].target) {
      entered.resolve(); call.signal.addEventListener('abort', () => detected.resolve(), {once:true});
      await held.promise;
    }
    if (call.unit.target === f.units[2].target) thirdCalls++;
    return fake(call);
  }, {onProgress: event => {
    if (event.unit === f.units[0].target && event.stage === 'done' && !damageScheduled) {
      damageScheduled = true;
      queueMicrotask(() => {
      if (corruption === 'missing rulebook') fs.rmSync(safePath(f.root, 'migration/RULEBOOK.md'));
      else atomicWrite(safePath(f.root, 'migration/review-dependencies.json'), '{');
      });
    }
  }});
  const outcome = running.then(() => {returned = true;}, e => {returned = true; return e;});
  await entered.promise; await detected.promise;
  assert.equal(returned, false); assert.ok(fs.existsSync(safePath(f.root, 'migration/run.lock')));
  await assert.rejects(translate(f.root, f.config, fake), /lock|running/i);
  held.resolve(); const error = await outcome;
  assert.match(error.message, corruption === 'missing rulebook' ? /RULEBOOK/ : /JSON|property/i);
  assert.equal(thirdCalls, 0); assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  const directories = fs.readdirSync(safePath(f.root, 'migration/runs'));
  const summary = readJSON(safePath(f.root, `migration/runs/${directories[0]}/summary.json`));
  assert.equal(summary.agentCalls, 4); assert.equal(summary.done, 1);
  // A finished before corruption; the held B response is never accepted.
  assert.ok(summary.errors.some(e => corruption === 'missing rulebook' ? /RULEBOOK/.test(e.error) : /JSON|property/i.test(e.error)));
  const state = fs.readFileSync(statePath(f.root, f.units[1]), 'utf8');
  assert.equal(JSON.parse(state).status, 'blocked');
  await new Promise(setImmediate); assert.equal(fs.readFileSync(statePath(f.root, f.units[1]), 'utf8'), state);
});

test('single-target cycle repair uses full graph and leaves other candidate untouched', async t => {
  const f = await ready(t, {count:2}); f.config.commands.typecheck = null; f.config.maxAgentCalls = 2;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), {schemaVersion:1, dependencies: {'src/math_ops.py':['src/text_ops.py'], 'src/text_ops.py':['src/math_ops.py']}});
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Cycle candidates');
  await assert.rejects(translate(f.root, f.config, fake), /Translation stopped/);
  const otherState = fs.readFileSync(statePath(f.root, f.units[1]), 'utf8'), otherOutput = fs.readFileSync(safePath(f.root, f.units[1].target), 'utf8');
  atomicWrite(safePath(f.root, 'migration/repair-evidence.md'), 'Review candidate');
  const calls = [];
  const report = await translate(f.root, f.config, async call => {calls.push(call.unit.target); return fake(call);}, {onlyTarget:f.units[0].target, evidence:'migration/repair-evidence.md'});
  assert.equal(report.done, 1); assert.deepEqual(calls, [f.units[0].target, f.units[0].target]);
  assert.equal(fs.readFileSync(statePath(f.root, f.units[1]), 'utf8'), otherState);
  assert.equal(fs.readFileSync(safePath(f.root, f.units[1].target), 'utf8'), otherOutput);
});

test('runtime cleanup reports current approval without asserting completion', async t => {
  const f = await ready(t); await translate(f.root, f.config, fake);
  for (const stage of ['build', 'smoke', 'parity']) { approve(f.root, f.config, stage, 'Reviewed'); await runStage(f.root, f.config, stage); }
  assert.equal(migrationStatus(f.root).phases.find(p => p.id === '06').status, 'pending');
  approve(f.root, f.config, 'post-parity', 'Reviewed parity cleanup');
  const report = migrationStatus(f.root);
  assert.match(report.phases.find(p => p.id === '06').status, /approved.*unconfirmed/);
  assert.match(statusMarkdown(report), /06 Post-parity cleanup: approved/);
  assert.equal(report.nextActions.some(a => /approve post-parity/.test(a)), false);
  assert.ok(report.nextActions.some(a => /approved prompt 06 cleanup/.test(a)));
  atomicWrite(safePath(f.root, 'migration/gates/post-parity.json'), '{');
  assert.equal(migrationStatus(f.root).phases.find(p => p.id === '06').status, 'pending');
  approve(f.root, f.config, 'post-parity', 'Reviewed again'); await runStage(f.root, f.config, 'parity');
  assert.equal(migrationStatus(f.root).phases.find(p => p.id === '06').status, 'pending');
});

test('cycle repair retains incomplete external prerequisite and unrelated cycles do not reject repairs', async t => {
  const f = await ready(t, {count:3}); f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), {schemaVersion:1, dependencies: {
    'src/math_ops.py':['src/text_ops.py','src/main.py'], 'src/text_ops.py':['src/math_ops.py'], 'src/main.py':[]
  }});
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'External prerequisite fixture');
  atomicWrite(safePath(f.root, f.units[0].target), result('implementer', f.units[0]).content);
  atomicWrite(safePath(f.root, 'migration/repair-evidence.md'), 'Review candidate');
  let calls = 0;
  await assert.rejects(translate(f.root, f.config, async call => {calls++; return fake(call);}, {onlyTarget:f.units[0].target,evidence:'migration/repair-evidence.md'}), /Dependency jobs are incomplete/);
  assert.equal(calls, 0);
  // Complete a separate cycle while typecheck is deferred, then repair an independent unit with typecheck enabled.
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), {schemaVersion:1, dependencies: {
    'src/math_ops.py':['src/text_ops.py'], 'src/text_ops.py':['src/math_ops.py'], 'src/main.py':[]
  }});
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Separate cycle fixture');
  await translate(f.root, f.config, fake);
  f.config.commands.typecheck = ['node','--check','{target}'];
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Independent repair');
  const report = await translate(f.root, f.config, fake, {onlyTarget:f.units[2].target,evidence:'migration/repair-evidence.md'});
  assert.equal(report.agentCalls, 2);
});

test('fatal review-input failure cancels a held adapter before draining it', async t => {
  const f = await ready(t, {count:2}), entered = defer(), aborted = defer(), release = defer();
  let returned = false;
  const running = translate(f.root, f.config, async call => {
    if (call.unit.target === f.units[1].target) {
      entered.resolve(); call.signal.addEventListener('abort', () => aborted.resolve(), {once:true});
      await release.promise;
    } else if (call.role === 'implementer') await entered.promise;
    return fake(call);
  }, {onProgress: event => {
    if (event.unit === f.units[0].target && event.stage === 'review') fs.rmSync(safePath(f.root, 'migration/RULEBOOK.md'));
  }});
  const outcome = running.catch(e => e).finally(() => {returned = true;});
  await aborted.promise;
  assert.equal(returned, false); assert.ok(fs.existsSync(safePath(f.root, 'migration/run.lock')));
  release.resolve(); const error = await outcome;
  assert.match(error.message, /RULEBOOK/);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});
