// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { prepare } from './helpers.mjs';
import { atomicWrite, safePath, readJSON, writeJSON } from '../lib/core.mjs';
import { runSurvey, mergeSurvey } from '../lib/survey.mjs';

const sitesFile = 'migration/sites.tsv';
// One small file with a census too large for one request: one scope whose
// site batches become several parts.
function fixture(t, { concurrency, sites = 400 }) {
  const f = prepare(t);
  Object.assign(f.config, { sourceRoots: ['case'], concurrency, executionMode: 'continuous', maxReviewInputBytes: 16384 });
  atomicWrite(safePath(f.root, 'case/A.cs'), 'var value = Create();\nvalue = Change(value);\nEscape(value);\n');
  atomicWrite(safePath(f.root, sitesFile), 'file\tsymbol\tsource_construct\n'
    + Array.from({ length: sites }, (_, i) => `case/A.cs\tvalue_with_a_long_descriptive_name_${i}\tnullable reference\n`).join(''));
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  return f;
}
const answer = (args, evidence = 'case/A.cs:1-3') => {
  const data = JSON.parse(args.reviewInput);
  return { result: { schemaVersion: 1, kind: 'survey', survey: data.kind, target: args.unit.target,
    items: data.sites.map(site => ({ ...site, classification: 'VALUE', target_translation: 'value', evidence, status: 'confirmed' })) } };
};

test('the parts of one scope run side by side, never above concurrency, and keep their order', async t => {
  const f = fixture(t, { concurrency: 3, sites: 1200 });
  let active = 0, peak = 0, calls = 0;
  const report = await runSurvey(f.root, f.config, 'inventory', async args => {
    calls++; active++; peak = Math.max(peak, active);
    await sleep(20);
    active--;
    return answer(args);
  }, { sitesFile });
  assert.ok(calls > 3, `the census must split into several parts (got ${calls})`);
  assert.equal(report.total, 1, 'all parts belong to one scope');
  assert.equal(peak, 3, 'parts fill every slot and never exceed concurrency');
  assert.equal(report.done, 1);
  const record = readJSON(safePath(f.root, `migration/surveys/inventory/${report.completed[0]}.json`));
  assert.deepEqual(record.items.map(i => i.symbol), Array.from({ length: 1200 }, (_, i) => `value_with_a_long_descriptive_name_${i}`));
});

test('concurrency 1 still runs one call at a time', async t => {
  const f = fixture(t, { concurrency: 1, sites: 200 });
  let active = 0, peak = 0;
  await runSurvey(f.root, f.config, 'inventory', async args => {
    active++; peak = Math.max(peak, active); await sleep(5); active--; return answer(args);
  }, { sitesFile });
  assert.equal(peak, 1);
});

test('a transient failure waits outside its slot and other parts keep going', async t => {
  const f = fixture(t, { concurrency: 2, sites: 1200 });
  f.config.transientRetryDelayMs = 50;
  let failed = false, duringWait = 0, waiting = false;
  const report = await runSurvey(f.root, f.config, 'inventory', async args => {
    if (waiting) duringWait++;
    if (!failed) { failed = true; waiting = true; setTimeout(() => { waiting = false; }, 40); throw new Error('429 Too Many Requests'); }
    await sleep(5);
    return answer(args);
  }, { sitesFile });
  assert.equal(report.done, 1);
  assert.ok(duringWait > 0, 'another part used the slot while the failed one waited');
});

test('one failing part fails its scope but keeps the receipts of the parts that finished', async t => {
  const f = fixture(t, { concurrency: 2 });
  let calls = 0;
  const error = await runSurvey(f.root, f.config, 'inventory', async args => {
    if (++calls === 2) throw new Error('worker crashed');
    return answer(args);
  }, { sitesFile }).catch(e => e);
  assert.match(error.message, /worker crashed/);
  const before = calls;
  calls = 0;
  const report = await runSurvey(f.root, f.config, 'inventory', async args => { calls++; return answer(args); }, { sitesFile });
  assert.equal(report.done, 1);
  assert.equal(calls, 1, `only the failed part runs again (first run made ${before} calls)`);
});

test('inventory rows that stay uncited are not counted as negative dropped facts', async t => {
  const f = fixture(t, { concurrency: 1, sites: 3 });
  // The first site is valid and kept; the other two never get a valid citation.
  const report = await runSurvey(f.root, f.config, 'inventory', async args => {
    const r = answer(args, 'case/A.cs:99');
    for (const item of r.result.items) if (item.symbol.endsWith('_0')) item.evidence = 'case/A.cs:1';
    return r;
  }, { sitesFile });
  assert.equal(report.agentCalls, 2, 'one answer and one correction');
  assert.equal(report.uncited, 2);
  assert.equal(report.droppedFacts, undefined);
  const record = readJSON(safePath(f.root, `migration/surveys/inventory/${report.completed[0]}.json`));
  assert.equal(record.droppedFacts, undefined);
  assert.deepEqual(record.items.map(i => Boolean(i.uncited)), [false, true, true]);
  const merged = mergeSurvey(f.root, f.config, 'inventory', { sitesFile });
  assert.equal(merged.droppedFacts, undefined);
  assert.equal(merged.uncited, 2);
});

test('review of 55e38d5: parallel rejections keep one evidence file each', async t => {
  const f = fixture(t, { concurrency: 3, sites: 1200 });
  let calls = 0;
  const report = await runSurvey(f.root, f.config, 'inventory', async args => { calls++; await sleep(5); return answer(args, 'case/A.cs:99'); }, { sitesFile });
  assert.equal(report.done, 1);
  const rejected = fs.readdirSync(safePath(f.root, 'migration/surveys/inventory/runs')).filter(n => n.endsWith('-rejected.json'));
  assert.equal(rejected.length, calls, 'every rejected answer is kept under its own name');
});

test('review of 55e38d5: a correction goes before parts still waiting for their first call', async t => {
  const f = fixture(t, { concurrency: 1, sites: 1200 });
  const order = [];
  await runSurvey(f.root, f.config, 'inventory', async args => {
    const data = JSON.parse(args.reviewInput), first = data.sites[0].symbol, repair = Boolean(data.repair) || args.extra.survey.validationError !== undefined;
    order.push(`${args.extra.survey.part}${repair ? 'r' : ''}`);
    return answer(args, first.endsWith('_0') && !repair ? 'case/A.cs:99' : 'case/A.cs:1-3');
  }, { sitesFile });
  assert.deepEqual(order.slice(0, 3), ['1', '1r', '2']);
});

test('review of 55e38d5: a saved negative droppedFacts from an earlier version counts as 0', async t => {
  const f = fixture(t, { concurrency: 1, sites: 3 });
  const report = await runSurvey(f.root, f.config, 'inventory', async args => answer(args), { sitesFile });
  const file = safePath(f.root, `migration/surveys/inventory/${report.completed[0]}.json`), record = readJSON(file);
  writeJSON(file, { ...record, droppedFacts: -46 });
  assert.equal(mergeSurvey(f.root, f.config, 'inventory', { sitesFile }).droppedFacts, undefined);
});

test('review of 55e38d5: a failed scope reports the systemic failure, not the lowest part', async t => {
  const f = fixture(t, { concurrency: 2, sites: 1200 });
  let calls = 0;
  const error = await runSurvey(f.root, f.config, 'inventory', async args => {
    const n = ++calls;
    if (n === 1) { await sleep(30); throw new Error('worker crashed'); }
    if (n === 2) throw Object.assign(new Error('authentication required'), {});
    return answer(args);
  }, { sitesFile }).catch(e => e);
  assert.match(error.message, /authentication required/);
});

test('review (Sonnet): progress lists every running part and clears it when they finish', async t => {
  const f = fixture(t, { concurrency: 3, sites: 1200 });
  const seen = new Set();
  const report = await runSurvey(f.root, f.config, 'inventory', async args => {
    await sleep(20);
    const progress = JSON.parse(fs.readFileSync(safePath(f.root, `migration/surveys/inventory/runs/${args.runId}.progress.json`), 'utf8'));
    seen.add(String(Object.values(progress.parts)[0].activePart));
    return answer(args);
  }, { sitesFile });
  assert.ok([...seen].some(v => v.includes(', ')), `several running parts are listed (${[...seen].join(' | ')})`);
  const final = readJSON(safePath(f.root, `migration/surveys/inventory/runs/${report.runId}.progress.json`));
  assert.equal(Object.values(final.parts)[0].activePart, undefined);
});
