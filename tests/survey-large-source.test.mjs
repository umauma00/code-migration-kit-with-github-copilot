// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare } from './helpers.mjs';
import { atomicWrite, safePath, readJSON, writeJSON } from '../lib/core.mjs';
import { runSurvey, surveyStatus, mergeSurvey } from '../lib/survey.mjs';

function fixture(t, source) {
  const f = prepare(t);
  Object.assign(f.config, { sourceRoots: ['huge'], concurrency: 1, executionMode: 'continuous', maxReviewInputBytes: 4096, maxAgentCalls: 1 });
  atomicWrite(safePath(f.root, 'huge/Large.cs'), source);
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  return f;
}
function answer(args) {
  const data = JSON.parse(args.reviewInput), file = data.files[0];
  const evidence = `${file.path}:${file.firstLine}-${file.lastLine}`;
  const items = data.kind === 'facts' ? [{ file: file.path, category: 'risk', summary: `observed ${file.firstLine}`, evidence }]
    : data.kind === 'contracts' ? [{ file: file.path, publicInterface: 'excerpt interface', inputsOutputsErrors: 'excerpt behavior', edgeCases: 'unknown across excerpts', evidence, unknowns: 'cross-excerpt calls unknown' }]
    : data.sites.map(site => ({ ...site, classification: 'VALUE', target_translation: 'value observed in excerpt', evidence, status: 'confirmed' }));
  return { result: { schemaVersion: 1, kind: 'survey', survey: data.kind, target: args.unit.target, items } };
}
function assertCoverage(inputs, source) {
  const parts = inputs.filter(i => i.fragment).sort((a, b) => a.fragment.start - b.fragment.start);
  assert.ok(parts.length > 1);
  let end = 0;
  for (const part of parts) {
    assert.equal(part.fragment.start, end, 'no gap or overlap');
    end = part.fragment.end;
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 4096);
    assert.doesNotMatch(part.files[0].content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
  const normalized = source.replace(/\r\n|\r/g, '\n').replace(/\n$/, '');
  const raw = parts.map(p => p.files[0].content.split('\n').map(l => l.slice(l.indexOf('|') + 1)).join('\n')).join('');
  assert.equal(raw, normalized, 'every source character reaches a worker unchanged');
  assert.equal(end, normalized.length);
}

test('a single source body over 64 KiB is surveyed completely with original CRLF line numbers', async t => {
  const source = Array.from({ length: 1200 }, (_, i) => `// ${i + 1}: 日本語 "quotes" \\ generated source ${'x'.repeat(55)}\r\n`).join('');
  assert.ok(Buffer.byteLength(source) > 65536);
  const f = fixture(t, source), inputs = [];
  const report = await runSurvey(f.root, f.config, 'contracts', async args => { inputs.push(JSON.parse(args.reviewInput)); return answer(args); });
  assert.equal(report.done, 1); assert.ok(report.agentCalls > f.config.maxAgentCalls);
  assertCoverage(inputs, source);
  const record = readJSON(safePath(f.root, 'migration/surveys/contracts/001-huge.json'));
  assert.equal(record.items.length, 1); assert.equal(record.parts, inputs.length);
  assert.match(record.items[0].unknowns, /Cross-fragment/);
  assert.match(record.items[0].evidence, /huge\/Large.cs:1-/);
  assert.ok(inputs.at(-1).files[0].firstLine > 1);
  assert.equal(mergeSurvey(f.root, f.config, 'contracts').items, 1);
});

test('a huge minified single line splits without losing quotes, backslashes or Unicode code points', async t => {
  const source = ('const s="日本語😀\\\\\\\"";'.repeat(3500)) + '\n';
  const f = fixture(t, source), inputs = [];
  await runSurvey(f.root, f.config, 'facts', async args => { inputs.push(JSON.parse(args.reviewInput)); return answer(args); });
  assertCoverage(inputs, source);
  assert.ok(inputs.every(i => i.files[0].firstLine === 1 && i.files[0].lastLine === 1));
  assert.ok(inputs.at(-1).files[0].firstColumn > 1);
  assert.equal(surveyStatus(f.root, f.config, 'facts').done, 1);
});

test('manual interruption resumes validated fragments and never marks a partially read file complete', async t => {
  const f = fixture(t, '// source fragment\n'.repeat(2000)), controller = new AbortController();
  const before = [], after = [];
  await assert.rejects(runSurvey(f.root, f.config, 'contracts', async args => {
    const data = JSON.parse(args.reviewInput);
    if (before.length === 2) { controller.abort(); throw new Error('Interrupted'); }
    before.push(data.fragment.start); return answer(args);
  }, { signal: controller.signal }), /Interrupted/);
  assert.equal(surveyStatus(f.root, f.config, 'contracts').done, 0);
  assert.throws(() => mergeSurvey(f.root, f.config, 'contracts'), /Survey incomplete/);
  await runSurvey(f.root, f.config, 'contracts', async args => { after.push(JSON.parse(args.reviewInput).fragment.start); return answer(args); });
  assert.ok(after.length > 0); assert.ok(after.every(start => !before.includes(start)));
  assert.equal(surveyStatus(f.root, f.config, 'contracts').done, 1);
});

test('fragment citations cannot point to another, unread portion of the same original file', async t => {
  const f = fixture(t, '// numbered source\n'.repeat(500));
  let repaired = false;
  await runSurvey(f.root, f.config, 'contracts', async args => {
    const data = JSON.parse(args.reviewInput), r = answer(args);
    if (!data.repair && data.files[0].firstLine > 1 && !repaired) { r.result.items[0].evidence = 'huge/Large.cs:1'; repaired = true; }
    else if (data.repair) assert.match(data.repair.error, /outside source lines/);
    return r;
  });
  assert.equal(repaired, true); assert.equal(surveyStatus(f.root, f.config, 'contracts').done, 1);
});

test('an inventory file larger than the survey capacity becomes UNKNOWN without model calls', async t => {
  // Excerpt answers were always merged as UNKNOWN; asking a model per fragment
  // and site batch only spent hours for the same result.
  const f = fixture(t, '// create change escape\n'.repeat(350)), sitesFile = 'migration/sites.tsv';
  atomicWrite(safePath(f.root, sitesFile), 'file\tsymbol\tsource_construct\n' + ['A', 'B', 'C'].map(s => `huge/Large.cs\t${s}\tnullable\n`).join(''));
  const report = await runSurvey(f.root, f.config, 'inventory', async () => assert.fail('no model call for an oversized inventory source'), { sitesFile });
  assert.equal(report.agentCalls, 0); assert.equal(report.done, 1);
  const record = readJSON(safePath(f.root, 'migration/surveys/inventory/001-huge.json'));
  assert.equal(record.items.length, 3);
  assert.deepEqual(record.unsurveyedOversizedFiles, ['huge/Large.cs']);
  assert.ok(record.items.every(i => i.classification === 'UNKNOWN' && i.status === 'unknown' && i.target_translation.includes('TODO(port)')));
  assert.ok(record.items.every(i => i.evidence.startsWith('huge/Large.cs:1-350 ')));
  assert.equal(mergeSurvey(f.root, f.config, 'inventory', { sitesFile }).uniqueSites, 3);
  assert.equal(surveyStatus(f.root, f.config, 'inventory', { sitesFile }).complete, true);
});

test('a dense census on a large file finishes without model calls while small files are still surveyed', async t => {
  const f = fixture(t, '// source create change escape\n'.repeat(9000)), sitesFile = 'migration/sites.tsv';
  f.config.maxReviewInputBytes = 65536;
  atomicWrite(safePath(f.root, 'huge/Small.cs'), 'var x = Get();\n');
  atomicWrite(safePath(f.root, sitesFile), 'file\tsymbol\tsource_construct\n' + Array.from({ length: 628 }, (_, i) => `huge/Large.cs\tline-${i+1}\tnullable\n`).join('') + 'huge/Small.cs\tx\tnullable\n');
  const surveyed = [];
  const report = await runSurvey(f.root, f.config, 'inventory', async args => {
    const input = JSON.parse(args.reviewInput); surveyed.push(...input.files.map(file => file.path));
    return answer(args);
  }, { sitesFile });
  assert.deepEqual(surveyed, ['huge/Small.cs']); assert.equal(report.agentCalls, 1);
  const items = surveyStatus(f.root, f.config, 'inventory', { sitesFile }).scopes
    .flatMap(s => readJSON(safePath(f.root, `migration/surveys/inventory/${s.id}.json`)).items);
  assert.equal(items.length, 629);
  assert.equal(items.find(i => i.symbol === 'x').classification, 'VALUE');
  assert.equal(items.filter(i => i.classification === 'UNKNOWN').length, 628);
});

test('oversized required metadata reports its real capacity problem without dispatching oversized input', async t => {
  const f = fixture(t, '// source\n'), sitesFile = 'migration/sites.tsv';
  atomicWrite(safePath(f.root, 'migration/RULEBOOK.md'), 'required rule\n'.repeat(1000));
  atomicWrite(safePath(f.root, sitesFile), 'file\tsymbol\tsource_construct\nhuge/Large.cs\tA\tnullable\n');
  let calls = 0;
  await assert.rejects(runSurvey(f.root, f.config, 'inventory', async () => { calls++; }, { sitesFile }), /metadata exceeds maxReviewInputBytes/);
  assert.equal(calls, 0); assert.equal(surveyStatus(f.root, f.config, 'inventory', { sitesFile }).done, 0);
});
