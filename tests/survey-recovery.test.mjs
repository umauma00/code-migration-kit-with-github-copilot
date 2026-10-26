// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, ready, fake } from './helpers.mjs';
import { atomicWrite, safePath, readJSON, writeJSON, fileHash, lockRun, contextHash } from '../lib/core.mjs';
import { surveyInput, planSurvey, runSurvey, surveyStatus, mergeSurvey } from '../lib/survey.mjs';
import { statusSnapshot } from '../lib/status-snapshot.mjs';
import { migrationStatus, statusMarkdown, statusChecklist, statusTodo } from '../lib/status.mjs';
import { translate, requireGate } from '../lib/pipeline.mjs';
import { commandProgress } from '../lib/command-progress.mjs';
import { waitForProgress } from '../scripts/run_migration.mjs';

function fixture(t) {
  const f = prepare(t);
  f.config.sourceRoots = ['case'];
  f.config.concurrency = 1;
  atomicWrite(safePath(f.root, 'case/A.cs'), 'class A {}\r\n// 日本語\r\n');
  atomicWrite(safePath(f.root, 'case/B.cs'), 'class B {}\n');
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  return f;
}
function answer(args) {
  const input = JSON.parse(args.reviewInput);
  return { result: { schemaVersion: 1, kind: 'survey', survey: input.kind, target: args.unit.target,
    items: input.files.map(f => ({ file: f.path, publicInterface: `interface for ${f.path}`, inputsOutputsErrors: 'inferred, not observed',
      edgeCases: 'unknown', evidence: `${f.path}:1`, unknowns: 'unknown' })) } };
}

test('survey input provides original CRLF line numbers and validates range ends', async t => {
  const f = fixture(t);
  const scope = planSurvey(f.root, f.config, 'contracts').scopes[0];
  const input = surveyInput(f.root, f.config, 'contracts', scope), data = JSON.parse(input.text);
  assert.deepEqual(data.files[0], { path: 'case/A.cs', firstLine: 1, lastLine: 2, content: '1|class A {}\n2|// 日本語' });
  let calls = 0;
  await assert.rejects(runSurvey(f.root, f.config, 'contracts', async args => {
    calls++;
    const r = answer(args); r.result.items[0].evidence = `${r.result.items[0].file}:1-235`; return r;
  }), /Survey citation outside source lines/);
  assert.equal(calls, 2, 'a deterministic validation failure gets at most one correction');
  assert.equal(surveyStatus(f.root, f.config, 'contracts').done, 0);
});

test('a bad citation repairs only that file and preserves validated rows and rejected evidence', async t => {
  const f = fixture(t), inputs = [];
  let accepted;
  const report = await runSurvey(f.root, f.config, 'contracts', async args => {
    const input = JSON.parse(args.reviewInput); inputs.push(input);
    const r = answer(args);
    if (inputs.length === 1) {
      accepted = structuredClone(r.result.items[1]);
      r.result.items[0].evidence = 'case/A.cs:235';
    }
    return r;
  });
  assert.equal(report.done, 1); assert.equal(report.agentCalls, 2);
  assert.deepEqual(inputs[1].files.map(f => f.path), ['case/A.cs']);
  assert.match(inputs[1].repair.error, /allowed 1-2/);
  const saved = readJSON(safePath(f.root, 'migration/surveys/contracts/001-case.json'));
  assert.deepEqual(saved.items.find(i => i.file === 'case/B.cs'), accepted);
  const runs = fs.readdirSync(safePath(f.root, 'migration/surveys/contracts/runs'));
  const rejected = runs.find(n => n.endsWith('-rejected.json'));
  assert.equal(readJSON(safePath(f.root, `migration/surveys/contracts/runs/${rejected}`)).result.items[0].evidence, 'case/A.cs:235');
  assert.equal(fs.existsSync(safePath(f.root, 'migration/surveys/contracts/001-case.partial.json')), false);
});

test('a resumed run uses the saved valid rows and never exceeds its call budget', async t => {
  const f = fixture(t); f.config.maxAgentCalls = 1;
  let first;
  await assert.rejects(runSurvey(f.root, f.config, 'contracts', async args => {
    first = answer(args); first.result.items[0].evidence = 'case/A.cs:999'; return first;
  }), /outside source lines/);
  let calls = 0;
  await runSurvey(f.root, f.config, 'contracts', async args => {
    calls++;
    assert.deepEqual(JSON.parse(args.reviewInput).files.map(f => f.path), ['case/A.cs']);
    return answer(args);
  });
  assert.equal(calls, 1);
  const saved = readJSON(safePath(f.root, 'migration/surveys/contracts/001-case.json'));
  assert.deepEqual(saved.items.find(i => i.file === 'case/B.cs'), first.result.items[1]);
});

test('valid legacy scope results survive numbering upgrades and max-files is retained on resume', async t => {
  const f = fixture(t);
  await runSurvey(f.root, f.config, 'contracts', async args => answer(args), { maxFiles: 1 });
  const plan = planSurvey(f.root, f.config, 'contracts', { maxFiles: 1 });
  const scope = plan.scopes[0], file = safePath(f.root, `migration/surveys/contracts/${scope.id}.json`);
  const record = readJSON(file);
  record.inputHash = surveyInput(f.root, f.config, 'contracts', scope).legacyHash;
  writeJSON(file, record);
  const before = fileHash(file);
  const report = await runSurvey(f.root, f.config, 'contracts', async () => assert.fail('completed scopes must not run again'));
  assert.equal(report.agentCalls, 0); assert.equal(report.done, 2);
  assert.equal(planSurvey(f.root, f.config, 'contracts').maxFiles, 1);
  assert.equal(fileHash(file), before);
});

test('out-of-range cached answers are not merged or reused as successful', async t => {
  const f = fixture(t);
  await runSurvey(f.root, f.config, 'contracts', async args => answer(args));
  const file = safePath(f.root, 'migration/surveys/contracts/001-case.json'), record = readJSON(file);
  record.items[0].evidence = 'case/A.cs:235'; writeJSON(file, record);
  assert.equal(surveyStatus(f.root, f.config, 'contracts').done, 0);
  assert.throws(() => mergeSurvey(f.root, f.config, 'contracts'), /Survey incomplete/);
});

test('unreadable sources block completion/merge, and repairing them preserves successful scope identities', async t => {
  const f = fixture(t);
  fs.writeFileSync(safePath(f.root, 'case/A.cs'), Buffer.from('class A {} // caf\xe9\n', 'latin1'));
  const error = await runSurvey(f.root, f.config, 'contracts', async args => answer(args), { maxFiles: 1 }).catch(e => e);
  assert.match(error.message, /valid UTF-8/);
  assert.equal(error.report.complete, false); assert.equal(error.report.skipped.length, 1);
  const before = surveyStatus(f.root, f.config, 'contracts');
  assert.equal(before.done, 1); assert.equal(before.complete, false); assert.equal(before.skipped[0].file, 'case/A.cs');
  assert.throws(() => mergeSurvey(f.root, f.config, 'contracts'), /source files could not be read/);
  const scope = planSurvey(f.root, f.config, 'contracts').scopes.find(s => s.files.includes('case/B.cs'));
  const record = safePath(f.root, `migration/surveys/contracts/${scope.id}.json`), digest = fileHash(record);
  atomicWrite(safePath(f.root, 'case/A.cs'), 'class A {} // café\n');
  const called = [];
  const report = await runSurvey(f.root, f.config, 'contracts', async args => {
    called.push(...JSON.parse(args.reviewInput).files.map(f => f.path)); return answer(args);
  });
  assert.deepEqual(called, ['case/A.cs']); assert.equal(report.complete, true);
  assert.equal(planSurvey(f.root, f.config, 'contracts').scopes.find(s => s.files.includes('case/B.cs')).id, scope.id);
  assert.equal(fileHash(record), digest);
  assert.equal(mergeSurvey(f.root, f.config, 'contracts').items, 2);
});

test('an entirely unreadable survey cannot report zero-of-zero as complete or replace a draft', async t => {
  const f = fixture(t);
  for (const file of ['case/A.cs', 'case/B.cs']) fs.writeFileSync(safePath(f.root, file), Buffer.from([0xff, 0x00, 0xfe]));
  atomicWrite(safePath(f.root, 'migration/source-spec/contracts.md'), '# Keep previous reviewed text\n');
  let calls = 0;
  await assert.rejects(runSurvey(f.root, f.config, 'contracts', async () => { calls++; }), /valid UTF-8/);
  assert.equal(calls, 0); assert.equal(surveyStatus(f.root, f.config, 'contracts').complete, false);
  assert.throws(() => mergeSurvey(f.root, f.config, 'contracts'), /source files could not be read/);
  assert.equal(fs.readFileSync(safePath(f.root, 'migration/source-spec/contracts.md'), 'utf8'), '# Keep previous reviewed text\n');
});

test('missing census files cannot produce a successful zero-of-zero inventory survey', async t => {
  const f = fixture(t), sitesFile = 'migration/sites.tsv';
  atomicWrite(safePath(f.root, sitesFile), 'file\tsymbol\tsource_construct\ncase/missing.cs\titem\tdecimal\n');
  let calls = 0;
  const error = await runSurvey(f.root, f.config, 'inventory', async () => { calls++; }, { sitesFile }).catch(e => e);
  assert.match(error.message, /missing or outside/); assert.equal(calls, 0);
  assert.equal(error.report.complete, false); assert.equal(error.report.skipped[0].file, 'case/missing.cs');
  assert.equal(surveyStatus(f.root, f.config, 'inventory', { sitesFile }).complete, false);
  assert.throws(() => mergeSurvey(f.root, f.config, 'inventory', { sitesFile }), /source files could not be read/);
});

test('empty source roots and empty inventory census remain incomplete without overwriting existing drafts', async t => {
  const f = fixture(t); f.config.sourceRoots = ['empty']; fs.mkdirSync(safePath(f.root, 'empty'));
  atomicWrite(safePath(f.root, 'migration/source-spec/contracts.md'), '# Existing draft\n');
  await assert.rejects(runSurvey(f.root, f.config, 'contracts', async () => assert.fail('empty input has no worker')), /No source files/);
  assert.equal(surveyStatus(f.root, f.config, 'contracts').complete, false);
  assert.throws(() => mergeSurvey(f.root, f.config, 'contracts'), /Survey incomplete/);
  assert.equal(fs.readFileSync(safePath(f.root, 'migration/source-spec/contracts.md'), 'utf8'), '# Existing draft\n');
  f.config.sourceRoots = ['case'];
  const sitesFile = 'migration/empty-sites.tsv'; atomicWrite(safePath(f.root, sitesFile), 'file\tsymbol\tsource_construct\n');
  await assert.rejects(runSurvey(f.root, f.config, 'inventory', async () => assert.fail('empty census has no worker'), { sitesFile }), /census has no sites/);
  assert.equal(surveyStatus(f.root, f.config, 'inventory', { sitesFile }).complete, false);
});

test('an oversized serialized source is fragmented before starting workers', async t => {
  const f = fixture(t); f.config.maxReviewInputBytes = 4096;
  atomicWrite(safePath(f.root, 'case/A.cs'), '"'.repeat(2500));
  const called = [];
  const report = await runSurvey(f.root, f.config, 'contracts', async args => {
    assert.ok(Buffer.byteLength(args.reviewInput) <= 4096);
    called.push(...JSON.parse(args.reviewInput).files.map(f => f.path)); return answer(args);
  });
  assert.equal(report.done, 2);
  assert.ok(called.filter(p => p === 'case/A.cs').length > 1);
  assert.ok(called.includes('case/B.cs'));
});

test('oversized pending scopes split into fitting requests without changing saved scope IDs', async t => {
  const f = fixture(t);
  for (const file of ['case/A.cs', 'case/B.cs']) atomicWrite(safePath(f.root, file), '// a\n'.repeat(250));
  const plan = planSurvey(f.root, f.config, 'contracts');
  assert.equal(plan.scopes.length, 1);
  writeJSON(safePath(f.root, 'migration/surveys/contracts/plan.json'), plan);
  f.config.maxReviewInputBytes = 4096;
  const files = [];
  const report = await runSurvey(f.root, f.config, 'contracts', async args => {
    assert.ok(Buffer.byteLength(args.reviewInput) <= 4096);
    files.push(...JSON.parse(args.reviewInput).files.map(f => f.path)); return answer(args);
  });
  assert.equal(report.done, 1); assert.equal(report.agentCalls, 2);
  assert.deepEqual(files, ['case/A.cs', 'case/B.cs']);
  assert.equal(readJSON(safePath(f.root, 'migration/surveys/contracts/001-case.json')).items.length, 2);
});

test('a large census for one file is partitioned without dropping sites', async t => {
  const f = fixture(t), sitesFile = 'migration/inventory-sites.tsv';
  atomicWrite(safePath(f.root, sitesFile), 'file\tsymbol\tsource_construct\n' + Array.from({ length: 80 }, (_, i) => `case/A.cs\tmethod${i}\tnullable-value\n`).join(''));
  const plan = planSurvey(f.root, f.config, 'inventory', { sitesFile });
  writeJSON(safePath(f.root, 'migration/surveys/inventory/plan.json'), plan);
  f.config.maxReviewInputBytes = 4096;
  const seen = [];
  const report = await runSurvey(f.root, f.config, 'inventory', async args => {
    assert.ok(Buffer.byteLength(args.reviewInput) <= 4096);
    const input = JSON.parse(args.reviewInput);
    seen.push(...input.sites.map(s => s.symbol));
    return { result: { schemaVersion: 1, kind: 'survey', survey: 'inventory', target: args.unit.target,
      items: input.sites.map(site => ({ ...site, classification: 'VALUE', target_translation: 'nullable value', evidence: `${site.file}:1`, status: 'confirmed' })) } };
  }, { sitesFile });
  assert.equal(report.done, 1); assert.ok(report.agentCalls > 1);
  assert.equal(seen.length, 80); assert.equal(new Set(seen).size, 80);
  assert.equal(readJSON(safePath(f.root, 'migration/surveys/inventory/001-case.json')).items.length, 80);
});

test('a mixed valid/foreign citation cannot be rescued by the valid anchor', async t => {
  const f = fixture(t); f.config.maxAgentCalls = 1;
  await assert.rejects(runSurvey(f.root, f.config, 'contracts', async args => {
    const r = answer(args); r.result.items[0].evidence += ' other/File.cs:5'; return r;
  }), /outside source lines/);
});

test('citation line 504 is not mistaken for a transient HTTP 504 retry', async t => {
  const f = fixture(t); f.config.transientRetryDelayMs = 1;
  let calls = 0;
  await assert.rejects(runSurvey(f.root, f.config, 'contracts', async args => {
    calls++; const r = answer(args); r.result.items[0].evidence = `${r.result.items[0].file}:504`; return r;
  }), /outside source lines/);
  assert.equal(calls, 2);
});

test('numbered citations support spaces, Unicode and regex punctuation in file paths', async t => {
  const f = fixture(t);
  atomicWrite(safePath(f.root, 'case/空 白 [C].cs'), '// third file\n');
  const report = await runSurvey(f.root, f.config, 'contracts', async args => answer(args));
  assert.equal(report.done, 1);
  const record = readJSON(safePath(f.root, 'migration/surveys/contracts/001-case.json'));
  assert.equal(record.items.length, 3);
});

test('fast status reads metadata only and clearly marks recorded completion as unvalidated', t => {
  const f = fixture(t);
  writeJSON(safePath(f.root, 'migration/phases/00.json'), { schemaVersion: 1, phase: '00', executionId: 'old', note: 'Reviewed before source edits' });
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...options) {
    assert.ok(!String(file).startsWith(path.join(f.root, 'case') + path.sep), 'progress must not read source content');
    return original.call(this, file, ...options);
  });
  const report = statusSnapshot(f.root);
  assert.equal(report.recordedOnly, true); assert.equal(report.implementationReady, false);
  assert.equal(report.workflow.next, '00b');
  assert.match(statusMarkdown(report, 'ja'), /未再検証/);
  assert.match(statusChecklist(report, 'ja'), /記録のみ・未再検証/);
  assert.equal(statusTodo(report).recordedOnly, true);
});

test('fast progress sees a running survey and returns when one scope completes', async t => {
  const f = fixture(t), runId = 'survey-progress-test';
  writeJSON(safePath(f.root, 'migration/phases/00.json'), { schemaVersion: 1, phase: '00', executionId: '00', note: 'fixture' });
  const release = lockRun(f.root, 'survey', { runId });
  t.after(release);
  const file = safePath(f.root, `migration/surveys/contracts/runs/${runId}.progress.json`);
  const progress = { schemaVersion: 1, kind: 'contracts', runId, state: 'running', done: 0, total: 2, agentCalls: 1, activeScopes: ['001-case'], updatedAt: new Date().toISOString() };
  writeJSON(file, progress);
  const first = statusSnapshot(f.root);
  assert.equal(first.running, true); assert.equal(first.currentState, 'running');
  const timer = setTimeout(() => writeJSON(file, { ...progress, done: 1 }), 30);
  t.after(() => clearTimeout(timer));
  const report = await waitForProgress(f.root, 1, { fast: true, intervalMs: 10 });
  assert.equal(report.survey.done, 1);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), true, 'inspection cannot cancel the runner');
});

test('fast recorded completion cannot bypass a gate after the source changes', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, fake);
  assert.equal(statusSnapshot(f.root).done, 1);
  fs.appendFileSync(safePath(f.root, f.units[0].source), '\n# source changed\n');
  const snapshot = statusSnapshot(f.root);
  assert.equal(snapshot.done, 1, 'this is explicitly a view of old records');
  assert.equal(snapshot.recordedOnly, true);
  assert.equal(snapshot.implementationReady, false);
  assert.throws(() => requireGate(f.root, f.config, 'translation', contextHash(f.root, f.config)), /stale|changed/);
  assert.equal(migrationStatus(f.root).done, 0, 'normal status still checks current inputs');
});

test('fast status keeps a disposable pilot separate from production preparation phases', t => {
  const f = fixture(t);
  f.config.executionPurpose = 'pilot'; writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  writeJSON(safePath(f.root, 'migration/pilot.json'), { through: 'build' });
  const report = statusSnapshot(f.root);
  assert.equal(report.workflow.policy, 'isolated-pilot');
  assert.equal(report.workflow.next, '04'); assert.equal(report.workflow.total, 2);
  assert.deepEqual(report.phases.map(p => p.id), ['04', '05']);
});

test('quiet commands report liveness without cancellation and clear their timer on failure', async () => {
  const messages = [];
  await assert.rejects(commandProgress('survey', async () => {
    await new Promise(resolve => setTimeout(resolve, 30)); throw new Error('fixture failure');
  }, { intervalMs: 5, write: m => messages.push(m) }), /fixture failure/);
  assert.match(messages[0], /started/); assert.ok(messages.some(m => m.includes('still running')));
  const count = messages.length;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(messages.length, count);
});
