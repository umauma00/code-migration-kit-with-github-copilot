import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, ready, fake, result, mini, finding } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, fileHash, loadConfig, contextHash, done, unitState } from '../lib/core.mjs';
import { approve, runStage, translate, runPilot, runJudgePreparation, currentRecord } from '../lib/pipeline.mjs';
import { preparePilot, requirePilot, planPilot } from '../lib/pilot.mjs';
import { currentPhase } from '../lib/phases.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { doctor } from '../scripts/run_migration.mjs';
import { mergeInventory, dependencySamples, compareDependencyAudit, packageCycles } from '../lib/preparation.mjs';
import { makeRepairQueue } from '../scripts/diagnostic_queue.mjs';
import { freezeAudit, submitAudit } from '../scripts/audit_inputs.mjs';
import { preparationCommand } from '../scripts/preparation_cli.mjs';
import { migrationStatus, statusTodo, statusChecklist } from '../lib/status.mjs';
import { runProcess } from '../lib/process.mjs';

const write = (f, name, text) => atomicWrite(safePath(f.root, name), text);
const wrap = r => ({ result: r, requestedModel: 'test-double', observedModel: null, tokens: null });
async function reviewedPreparation(t, options = {}) {
  const f = prepare(t, { realCommands: true, ...options });
  f.config.phasePolicy = 'strict'; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  fs.rmSync(safePath(f.root, 'migration/stress-test/report.md'));
  for (const p of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) write(f, p, 'Disposable preparation fixture; not actual AI review or human signoff.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Synthetic preparation review for boundary tests only' });
  await runStage(f.root, f.config, 'judge'); return f;
}
function childPath(t, f) { const child = `${f.root}-pilot`; t.after(() => fs.rmSync(child, { recursive: true, force: true })); return child; }

test('plugin worker manuals resolve in plugin and installed copy layouts', t => {
  const f = prepare(t);
  for (const [root, dir, prefix] of [[kitRoot, 'com.github.copilot/agents', 'code-migration-plugin-'], [f.root, '.github/agents', 'migration-']]) {
    for (const role of ['implementer', 'fixer', 'arbiter', 'reviewer-rules', 'reviewer-semantics']) {
      const file = path.join(root, dir, `${prefix}${role}.agent.md`);
      const links = [...fs.readFileSync(file, 'utf8').matchAll(/\]\(([^)]+docs\/(?:OPERATING-MANUAL|CONTRACTS)\.md)\)/g)];
      assert.equal(links.length, 2);
      for (const link of links) assert.equal(fs.statSync(path.resolve(path.dirname(file), link[1])).isFile(), true);
    }
  }
});

test('a running pilot shows its own current phase as in progress in TODO and chat', async t => {
  const f = await reviewedPreparation(t), child = childPath(t, f);
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Disposable trial of one file' });
  let during = null;
  await runPilot(child, loadConfig(child), call => {
    // Mid-run, while the runner holds the translation lock.
    if (!during && call.role === 'implementer') { const report = migrationStatus(child); during = { report, todo: statusTodo(report, 'en'), checklist: statusChecklist(report, 'en') }; }
    return fake(call);
  });
  assert.deepEqual([during.report.running, during.report.lock?.task, during.report.workflow.next, during.report.currentState], [true, 'translation', '04', 'running']);
  const item = during.todo.todoList.find(i => i.title.startsWith('04 '));
  assert.deepEqual([item.status, item.title], ['in-progress', '04 Translation and review [running]']);
  assert.deepEqual([during.todo.current.phase, during.todo.current.state], ['04', 'running']);
  assert.match(during.checklist, /▶ 04 Translation and review \[running\] {2}← you are here/);
});

test('pilot plan shows the final scope without writing, and prepare then matches it', async t => {
  const f = await reviewedPreparation(t, { count: 3 }), child = childPath(t, f);
  const before = fs.readdirSync(safePath(f.root, 'migration')).sort();
  const plan = planPilot(f.root, f.config, { sources: ['src/main.py'] });
  assert.deepEqual(plan.counts, { requested: 1, added: 2, total: 3 });
  assert.deepEqual(plan.added, plan.sources.filter(s => s !== 'src/main.py'));
  assert.match(plan.plain.ja, /選んだ 1 ファイルと、それらが使っている 2 ファイル、合わせて 3 ファイル/);
  assert.match(plan.plain.ja, /ビルドや動作確認はしません/);
  assert.doesNotMatch(plan.plain.ja, /grant|target|translation|pilot/i);
  // Read-only: no grant, lock or other file appears in production.
  assert.deepEqual(fs.readdirSync(safePath(f.root, 'migration')).sort(), before);
  assert.equal(fs.existsSync(child), false);
  assert.match(planPilot(f.root, f.config, { sources: ['src/main.py'], through: 'build' }).plain.ja, /ビルドや動作確認も行います/);
  assert.throws(() => planPilot(f.root, f.config, { sources: [] }), /explicit source/);
  assert.throws(() => planPilot(f.root, f.config, { sources: ['src/none.py'] }), /not in the manifest/);
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], note: 'Plan of 3 files approved' });
  assert.deepEqual(grant.sources, plan.sources);
});

test('strict phase-03 pilot uses the shared pipeline before production approval and cannot become production done', async t => {
  const f = await reviewedPreparation(t, { count: 3 }), child = childPath(t, f);
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/main.py'], through: 'parity', note: 'Disposable trial of main plus audited prerequisites' });
  assert.equal(grant.sources.length, 3); assert.equal(currentPhase(f.root, f.config, '03'), false);
  assert.throws(() => approve(f.root, f.config, 'translation', 'Production is still unapproved'), /Phase 03/);
  const config = loadConfig(child), observed = [];
  const run = await runPilot(child, config, call => { observed.push({ role: call.role, target: call.unit.target, input: call.reviewInput }); return fake(call); });
  assert.equal(run.productionCompletion, false); assert.equal(run.results.at(-1).stage, 'parity');
  assert.equal(run.results.at(-1).result.success, true); assert.equal(observed.length, 9);
  const status = migrationStatus(child);
  assert.equal(status.purpose, 'pilot'); assert.equal(status.workflow.policy, 'isolated-pilot');
  assert.equal(status.workflow.next, null); assert.equal(status.workflow.total, 4);
  assert.equal(status.blockers.length, 0);
  for (const target of grant.targets) {
    const reviews = observed.filter(c => c.target === target && c.role.startsWith('reviewer-'));
    assert.equal(reviews[0].input, reviews[1].input);
  }
  assert.equal(fs.existsSync(safePath(f.root, 'migration/gates/translation.json')), false);
  fs.cpSync(safePath(child, 'migration/state'), safePath(f.root, 'migration/state'), { recursive: true });
  for (const unit of f.units) assert.equal(done(f.root, unit, contextHash(f.root, f.config)), false);
  const changed = { ...config, executionPurpose: 'production' };
  writeJSON(safePath(child, 'migration/config.json'), changed);
  assert.throws(() => approve(child, changed, 'translation', 'Cannot convert a pilot grant to production'), /Phase 03/);
});

test('pilot rejects existing directories, altered scope, revocation and changed parent validation', async t => {
  const f = await reviewedPreparation(t), child = childPath(t, f);
  assert.throws(() => preparePilot(f.root, f.config, { target: f.root, sources: ['src/math_ops.py'], note: 'Fixture' }), /outside/);
  const alias = `${f.root}-alias`; fs.symlinkSync(f.root, alias, 'dir'); t.after(() => fs.rmSync(alias, { force: true }));
  assert.throws(() => preparePilot(f.root, f.config, { target: path.join(alias, 'new-pilot'), sources: ['src/math_ops.py'], note: 'Fixture' }), /outside/);
  const grant = preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Fixture' });
  const config = loadConfig(child);
  assert.throws(() => preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Fixture' }), /new directory/);
  assert.throws(() => approve(child, config, 'build', 'Not authorized by translation-only pilot'), /boundary/);
  assert.throws(() => approve(child, config, 'post-parity', 'Not a production cleanup'), /boundary/);
  fs.appendFileSync(safePath(child, 'migration/inventory.tsv'), '# child change\n');
  assert.throws(() => requirePilot(child, config), /sealed inputs/);
  fs.writeFileSync(safePath(child, 'migration/inventory.tsv'), fs.readFileSync(safePath(f.root, 'migration/inventory.tsv')));
  assert.equal(requirePilot(child, config).id, grant.id);
  fs.rmSync(safePath(f.root, `migration/pilots/${grant.id}.json`));
  assert.throws(() => requirePilot(child, config), /revoked/);
});

test('a stale parent never publishes a production completion', async t => {
  const f = await reviewedPreparation(t), child = childPath(t, f);
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Fixture' });
  const config = loadConfig(child);
  fs.appendFileSync(safePath(f.root, 'src/math_ops.py'), '\n# changed parent source\n');
  await assert.rejects(runPilot(child, config, fake), /parent preparation|parent judge|changed/);
  assert.equal(fs.existsSync(safePath(child, 'ported/math_ops.mjs')), false);
});

test('early judge runs before rules/map exist, is reused after preparation, and input changes revoke validation', async t => {
  const f = prepare(t, { realCommands: true });
  f.config.phasePolicy = 'strict'; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const saved = new Map(['migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv', 'migration/review-dependencies.json'].map(p => [p, fs.readFileSync(safePath(f.root, p))]));
  for (const p of saved.keys()) fs.rmSync(safePath(f.root, p));
  phaseCommand(f.root, f.config, 'complete', '00', { note: 'Fixture feasibility review' });
  const early = await runJudgePreparation(f.root, f.config);
  assert.equal(early.success, true); assert.deepEqual(early.commands.map(c => c.name), ['original', 'mutation']);
  write(f, 'migration/judge-report.md', 'Existing portable judge reused; actual original/mutation fixture commands.\n');
  phaseCommand(f.root, f.config, 'complete', '00b', { note: 'Fixture judge review' });
  for (const [p, text] of saved) write(f, p, text);
  write(f, 'migration/depmap/report.md', 'Fixture dependency audit\n'); write(f, 'migration/gap-report.md', 'Fixture gap audit\n');
  for (const id of ['01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Fixture reviewed preparation' });
  const formal = await runStage(f.root, f.config, 'judge');
  assert.equal(formal.preparationExecutionId, early.executionId);
  assert.ok(formal.commands.every(c => c.reusedFrom === early.executionId));
  fs.appendFileSync(safePath(f.root, 'tests/judge.py'), '\n# judge identity change\n');
  assert.equal(currentPhase(f.root, f.config, '00b'), false);
  assert.equal(currentRecord(f.root, f.config, 'judge', contextHash(f.root, f.config), false), false);
});

test('explicit unit batches stop, retain reviewed work and cannot grant build before all units finish', async t => {
  const f = await ready(t, { count: 3 });
  approve(f.root, f.config, 'translation', 'Approve one dependency-ready unit only', { batch: 1 });
  const calls = [];
  const first = await translate(f.root, f.config, call => { calls.push(call.unit.target); return fake(call); });
  assert.equal(first.done, 1); assert.equal(first.total, 3); assert.equal(first.scopeComplete, true);
  assert.equal(new Set(calls).size, 1);
  const status = migrationStatus(f.root);
  assert.equal(status.approvedScopeRemaining, 0);
  assert.ok(status.nextActions.some(a => a.includes('next explicit translation batch')));
  assert.throws(() => approve(f.root, f.config, 'build', 'No downstream work before completed translation'), /All translation units/);
  assert.equal((await translate(f.root, f.config, fake)).agentCalls, 0);
  approve(f.root, f.config, 'translation', 'User approves the next batch', { batch: 2 });
  const second = await translate(f.root, f.config, fake);
  assert.equal(second.done, 3); assert.equal(second.agentCalls, 6);
});

test('count policy gives both reviewers identical measured evidence and rejects missed count mismatches', async t => {
  const f = prepare(t);
  f.config.markerPolicy = 'todo-lines-v1'; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  write(f, 'migration/RULEBOOK.md', fs.readFileSync(safePath(f.root, 'migration/RULEBOOK.md'), 'utf8') + 'Count literal TODO(port) lines; one final confidence/todos trailer.\n');
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture count convention');
  const body = fs.readFileSync(path.join(mini, 'expected/math_ops.mjs'), 'utf8').replace(/^\/\/ PORT STATUS:.*$/m, '').trimEnd();
  const bad = body + '\n// TODO(port): one; TODO(port): second occurrence on the same line\n// PORT STATUS: confidence=high todos=0\n';
  const inputs = [];
  await assert.rejects(translate(f.root, f.config, call => {
    if (call.role === 'implementer') return wrap(result(call.role, call.unit, { content: bad }));
    if (call.reviewInput) inputs.push(call.reviewInput); return fake(call);
  }), /PORT STATUS count/);
  assert.equal(inputs[0], inputs[1]); assert.equal(JSON.parse(inputs[0]).markerEvidence.actual, 1);
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
  write(f, 'migration/count-diagnostic.txt', 'One literal TODO(port) line; declared todos=0. Correct only the numeric trailer.\n');
  let first = true;
  await translate(f.root, f.config, call => {
    if (call.role === 'reviewer-rules' && first) { first = false; return wrap(result(call.role, call.unit, { findings: [{ id: 'COUNT', message: 'Trailer undercounts', evidence: 'ported/math_ops.mjs:6 contains TODO(port)', rule: 'Fixture count convention' }] })); }
    if (call.role === 'fixer') return wrap(result(call.role, call.unit, { content: bad.replace('todos=0', 'todos=1') }));
    return fake(call);
  }, { onlyTarget: f.units[0].target, evidence: 'migration/count-diagnostic.txt' });
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  assert.equal(unitState(f.root, f.units[0]).markerEvidence.actual, 1);
});

test('compile queue repairs independent slices under one cap and rejects stale diagnostics', async t => {
  const f = await ready(t, { count: 2 }); await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Fixture build'); await runStage(f.root, f.config, 'build');
  write(f, 'migration/build-diagnostics.tsv', 'file\tmodule\tcode\tmessage\nported/math_ops.mjs\tmath\tROUND\tCheck floor rounding\nported/text_ops.mjs\ttext\tUNICODE\tCheck code point length\n');
  makeRepairQueue(f.root, f.config, { diagnostics: 'migration/build-diagnostics.tsv' });
  let active = 0, maximum = 0; const seen = new Set();
  const report = await translate(f.root, f.config, async call => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (call.role === 'reviewer-semantics' && !seen.has(call.unit.target)) { seen.add(call.unit.target); await new Promise(resolve => setTimeout(resolve, 30)); return wrap(result(call.role, call.unit, { findings: [finding] })); }
      await new Promise(resolve => setTimeout(resolve, 10)); return fake(call);
    } finally { active--; }
  }, { repairQueue: 'migration/repair-queue.json' });
  assert.equal(report.done, 2); assert.equal(maximum, 2); assert.equal(report.agentCalls, 12);
  assert.throws(() => makeRepairQueue(f.root, f.config, { diagnostics: 'migration/build-diagnostics.tsv' }), /current build/);
  assert.throws(() => approve(f.root, f.config, 'smoke', 'Old build is stale'), /build/);
  approve(f.root, f.config, 'build', 'Fresh reviewed repair outputs');
  assert.equal((await runStage(f.root, f.config, 'build')).success, true);
});

test('inventory merge is deterministic, complete and conflict-safe across retried shards', t => {
  const f = prepare(t), header = 'file\tsymbol\tsource_construct\tclassification\ttarget_translation\tevidence\tstatus';
  const row = 'src/math_ops.py\tdivide\tnegative division\tNUMERIC\tfloor division\tsrc/math_ops.py:4\tconfirmed';
  write(f, 'migration/inventory-sites.tsv', 'file\tsymbol\tsource_construct\nsrc/math_ops.py\tdivide\tnegative division\n');
  write(f, 'migration/inventory-shards/a.tsv', `${header}\n${row}\n`);
  write(f, 'migration/inventory-shards/retry.tsv', `${header}\n${row}\n`);
  const options = { shards: ['migration/inventory-shards/a.tsv', 'migration/inventory-shards/retry.tsv'], sites: 'migration/inventory-sites.tsv' };
  const report = mergeInventory(f.root, f.config, options);
  assert.equal(report.uniqueSites, 1); const h = fileHash(safePath(f.root, 'migration/inventory.tsv'));
  assert.equal(mergeInventory(f.root, f.config, { ...options, shards: options.shards.toReversed() }).outputHash, h);
  write(f, 'migration/inventory-shards/retry.tsv', `${header}\n${row.replace('floor division', 'truncate division')}\n`);
  assert.throws(() => mergeInventory(f.root, f.config, options), /Conflicting/);
  assert.equal(fileHash(safePath(f.root, 'migration/inventory.tsv')), h);
  write(f, 'migration/inventory-shards/retry.tsv', `${header}\nsrc/math_ops.py\tdivide`);
  assert.throws(() => mergeInventory(f.root, f.config, options), /Partial/);
  assert.equal(fileHash(safePath(f.root, 'migration/inventory.tsv')), h);
});

test('map audit finds both missed and invented edges and package cycles in a clean file DAG', t => {
  const f = prepare(t, { count: 3 });
  write(f, 'src/unrelated.py', '# unrelated\n');
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: {
    'src/main.py': ['src/math_ops.py', 'src/unrelated.py'], 'src/math_ops.py': [], 'src/text_ops.py': [], 'src/unrelated.py': []
  } });
  write(f, 'migration/source-audit.tsv', 'from\tto\tevidence\nsrc/main.py\tsrc/math_ops.py\tsrc/main.py imports math_ops\nsrc/main.py\tsrc/text_ops.py\tsrc/main.py imports text_ops\n');
  const diff = compareDependencyAudit(f.root, f.config, { files: ['src/main.py'], audit: 'migration/source-audit.tsv' });
  assert.deepEqual(diff.missed.map(e => e.to), ['src/text_ops.py']); assert.deepEqual(diff.invented.map(e => e.to), ['src/unrelated.py']);
  const samples = dependencySamples(f.root, f.config, { seed: 'recorded-round-1' });
  const sampled = samples.samples.flatMap(s => [...s.random, ...s.adversarial]);
  assert.equal(new Set(sampled).size, sampled.length); assert.equal(sampled.length, 4);
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: { 'src/math_ops.py': ['src/text_ops.py'], 'src/text_ops.py': ['src/main.py'], 'src/main.py': [] } });
  writeJSON(safePath(f.root, 'migration/package-map.json'), { schemaVersion: 1, packages: { 'src/math_ops.py': 'X', 'src/text_ops.py': 'Y', 'src/main.py': 'X' } });
  const packages = packageCycles(f.root, f.config, 'migration/package-map.json');
  assert.deepEqual(packages.sourceCycle, []); assert.deepEqual(packages.targetPackageCycle, ['X', 'Y', 'X']);
});

test('a configuration from the removed native backend stops with migration instructions', t => {
  const f = prepare(t);
  for (const patch of [{ workerBackend: 'native', nativeHarness: 'vscode-local' }, { nativeModelVerification: 'requested-unverified' }, { nativeInput: 'file' }]) {
    writeJSON(safePath(f.root, 'migration/config.json'), { ...f.config, ...patch });
    assert.throws(() => loadConfig(f.root), /native\) worker backend was removed[\s\S]*"workerBackend": "copilot-cli"/);
  }
  writeJSON(safePath(f.root, 'migration/config.json'), { ...f.config, workerBackend: 'copilot-cli' });
  assert.equal(loadConfig(f.root).workerBackend, 'copilot-cli');
});

test('pilot cancellation rejects late work and resumes only its isolated grant', async t => {
  const f = await reviewedPreparation(t), child = childPath(t, f);
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Cancellation boundary fixture' });
  const config = loadConfig(child), controller = new AbortController();
  await assert.rejects(runPilot(child, config, async call => {
    controller.abort(); await new Promise(resolve => setTimeout(resolve, 10)); return fake(call);
  }, { signal: controller.signal }), /Interrupted|aborted|interrupt/i);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/state/units')), false);
  assert.equal(migrationStatus(child).done, 0);
  assert.equal((await runPilot(child, config, fake)).productionCompletion, false);
  assert.equal(migrationStatus(child).done, 1);
});

test('preparation auditors receive frozen bodies without other findings and stale submissions are rejected', t => {
  const f = prepare(t); f.config.phaseModels = { inventoryAudit: 'test-explicit-model' };
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  const options = { type: 'inventory', files: ['migration/RULEBOOK.md', 'migration/inventory.tsv', 'src/math_ops.py'] };
  const a = freezeAudit(f.root, f.config, options), b = freezeAudit(f.root, f.config, options);
  assert.notEqual(a.request.task, b.request.task); assert.equal(a.request.inputHash, b.request.inputHash);
  assert.equal(a.request.requestedModel, 'test-explicit-model'); assert.equal(a.request.observedModel, null);
  const answer = request => ({ schemaVersion: 1, kind: 'preparation-audit', task: request.task, inputHash: request.inputHash, verdict: 'pass', findings: [] });
  writeJSON(safePath(f.root, 'migration/audit-answer.json'), answer(a.request));
  assert.equal(submitAudit(f.root, f.config, { directory: a.directory, response: 'migration/audit-answer.json' }).observedModel, null);
  assert.throws(() => freezeAudit(f.root, f.config, { ...options, files: [`${a.directory}/result.json`] }), /prior findings/);
  assert.throws(() => submitAudit(f.root, f.config, { directory: a.directory, response: 'migration/audit-answer.json' }), /already submitted/);
  writeJSON(safePath(f.root, 'migration/audit-answer.json'), answer(b.request));
  write(f, 'migration/inventory.tsv', '# changed evidence\n');
  assert.throws(() => submitAudit(f.root, f.config, { directory: b.directory, response: 'migration/audit-answer.json' }), /changed/);
  const profile = safePath(f.root, '.github/agents/migration-preparation-auditor.agent.md');
  fs.writeFileSync(profile, fs.readFileSync(profile, 'utf8').replace('tools: []', 'tools: ["execute"]'));
  assert.throws(() => freezeAudit(f.root, f.config, options), /tools: \[\]/);
});

test('design bodies are frozen for both reviewers, protected during execution and invalidate completion', async t => {
  const f = prepare(t); f.config.designInputs = ['migration/ARCHITECTURE.md'];
  write(f, 'migration/ARCHITECTURE.md', 'Explicit module contract: math exports floor_divide.\n');
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Reviewed fixed design body');
  const inputs = []; await translate(f.root, f.config, call => { if (call.reviewInput) inputs.push(call.reviewInput); return fake(call); });
  assert.equal(inputs[0], inputs[1]); assert.ok(inputs[0].includes('Explicit module contract'));
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), true);
  fs.appendFileSync(safePath(f.root, 'migration/ARCHITECTURE.md'), 'Contract changed.\n');
  assert.equal(done(f.root, f.units[0], contextHash(f.root, f.config)), false);
  assert.throws(() => approve(f.root, f.config, 'build', 'Old design'), /judge|translation/);
});

test('report commands cannot overwrite configured maps or fixed design evidence', t => {
  const f = prepare(t); f.config.designInputs = ['migration/depmap/design.md'];
  write(f, 'migration/depmap/design.md', 'Fixed design evidence\n');
  const original = fileHash(safePath(f.root, 'migration/depmap/design.md'));
  assert.throws(() => preparationCommand(f.root, f.config, 'dependency-samples', { seed: 'fixture', out: 'migration/depmap/design.md' }), /protected/);
  assert.equal(fileHash(safePath(f.root, 'migration/depmap/design.md')), original);
  assert.throws(() => makeRepairQueue(f.root, f.config, { diagnostics: 'migration/input.tsv', out: 'migration/review-dependencies.json' }), /protected/);
});

test('pilot rejects altered early-judge evidence even when its formal receipt is unchanged', async t => {
  const f = await reviewedPreparation(t), child = childPath(t, f);
  await runJudgePreparation(f.root, f.config); await runStage(f.root, f.config, 'judge');
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], note: 'Evidence binding fixture' });
  const config = loadConfig(child), before = fileHash(safePath(f.root, 'migration/results/judge.json'));
  const early = safePath(f.root, 'migration/results/judge-preparation.json');
  writeJSON(early, { ...readJSON(early), success: false });
  assert.equal(fileHash(safePath(f.root, 'migration/results/judge.json')), before);
  assert.throws(() => requirePilot(child, config), /unchanged evidence/);
});

test('dependent repair slices wait for a fresh reviewed predecessor from the same run', async t => {
  const f = await ready(t, { count: 3 }); await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Dependency queue fixture'); await runStage(f.root, f.config, 'build');
  write(f, 'migration/build-diagnostics.tsv', 'file\tmodule\tcode\tmessage\nported/math_ops.mjs\tmath\tCHECK\tReview prerequisite\nported/main.mjs\tmain\tCHECK\tReview dependent\n');
  makeRepairQueue(f.root, f.config, { diagnostics: 'migration/build-diagnostics.tsv' });
  const seen = [], math = f.units.find(u => u.source === 'src/math_ops.py');
  const report = await translate(f.root, f.config, async call => {
    if (call.unit.target === 'ported/main.mjs') {
      const state = unitState(f.root, math);
      assert.equal(state.runId, call.runId); assert.equal(state.status, 'done');
      assert.equal(done(f.root, math, contextHash(f.root, f.config)), true);
    }
    seen.push(call.unit.target); await new Promise(resolve => setTimeout(resolve, 10)); return fake(call);
  }, { repairQueue: 'migration/repair-queue.json' });
  assert.deepEqual(seen, ['ported/math_ops.mjs', 'ported/math_ops.mjs', 'ported/main.mjs', 'ported/main.mjs']);
  assert.equal(report.done, 3); assert.equal(report.agentCalls, 4);
});

test('source-only pilot validates its plan and stops at smoke with equivalence unverified', async t => {
  const f = prepare(t); f.config.phasePolicy = 'strict'; f.config.verificationMode = 'source-only';
  f.config.commands.original = f.config.commands.mutation = [process.execPath, '-e', 'process.exit(77)']; f.config.commands.parity = null;
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  writeJSON(safePath(f.root, 'migration/judge-plan.json'), { schemaVersion: 1, verificationMode: 'source-only', method: 'Fixture source inspection',
    sources: ['src/math_ops.py'], scenarios: [{ path: 'tests/judge.py', contract: 'Floor division and zero errors', expectationBasis: 'source-inferred' }], unverified: ['No observed original or parity'] });
  for (const p of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) write(f, p, 'Disposable source-only preparation fixture\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Fixture review; no actual human signoff' });
  await runStage(f.root, f.config, 'judge'); const child = childPath(t, f);
  assert.throws(() => preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], through: 'parity', note: 'Fixture' }), /boundary/);
  preparePilot(f.root, f.config, { target: child, sources: ['src/math_ops.py'], through: 'smoke', note: 'Fixture source-only experiment' });
  const report = await runPilot(child, loadConfig(child), fake);
  assert.equal(report.results[0].result.commands.length, 0); assert.equal(report.results.at(-1).stage, 'smoke');
  assert.equal(migrationStatus(child).equivalence, 'unverified');
  assert.equal(fs.existsSync(safePath(child, 'migration/results/parity.json')), false);
});

test('live demo setup uses strict gates and contains no synthetic stress completion or approval', async t => {
  const f = prepare(t), destination = `${f.root}-live-setup`;
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const processResult = await runProcess(process.execPath, ['scripts/demo.mjs', 'setup', '--target', destination, '--model', 'test-double'], { cwd: kitRoot, timeoutMs: 20000 });
  assert.equal(processResult.code, 0);
  const config = loadConfig(destination);
  assert.equal(config.phasePolicy, 'strict'); assert.equal(config.markerPolicy, 'todo-lines-v1');
  for (const name of ['migration/stress-test/report.md', 'migration/gates/translation.json', 'migration/results/judge.json']) assert.equal(fs.existsSync(safePath(destination, name)), false);
  assert.throws(() => approve(destination, config, 'translation', 'No synthetic preparation bypass'), /Phase 03/);
});
