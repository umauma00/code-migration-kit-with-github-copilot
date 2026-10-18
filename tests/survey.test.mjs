// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare } from './helpers.mjs';
import { safePath, writeJSON, readJSON, atomicWrite, lockRun } from '../lib/core.mjs';
import { planSurvey, runSurvey, mergeSurvey, surveyStatus } from '../lib/survey.mjs';
import { initSourceSpec } from '../lib/source-spec.mjs';
import { loadConfig } from '../lib/core.mjs';
import { createCopilotAdapter, copilotArgs } from '../scripts/copilot_adapter.mjs';
import { decide } from '../scripts/migration_hook.mjs';
import { runtimeLayout } from '../lib/runtime.mjs';
import { failureGuidanceList } from '../lib/guidance.mjs';

// A surveyor double answers from the frozen input it was given.
const answer = ({ unit, reviewInput }) => {
  const input = JSON.parse(reviewInput);
  const items = input.kind === 'facts' ? input.files.map(f => ({ file: f.path, category: 'entry-point', summary: `${f.path} defines public functions`, evidence: `${f.path}:1 def` }))
    : input.kind === 'contracts' ? input.files.map(f => ({ file: f.path, publicInterface: 'functions', inputsOutputsErrors: 'ints in, ints out', edgeCases: 'negative division', evidence: `${f.path}:1`, unknowns: 'none' }))
    : input.sites.map(s => ({ ...s, classification: 'OWNED', target_translation: 'number', evidence: `${s.file}:2 created`, status: 'confirmed' }));
  return { result: { schemaVersion: 1, kind: 'survey', survey: input.kind, target: unit.target, items }, requestedModel: 'm', observedModel: null };
};
const fixture = t => {
  const f = prepare(t, { count: 3 });
  Object.assign(f.config, { transientRetryDelayMs: 1, phaseModels: { survey: 'survey-model' } });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  return f;
};

test('facts survey: scopes by directory, results as files, resumable, merged into one draft', async t => {
  const f = fixture(t);
  fs.mkdirSync(safePath(f.root, 'src/sub'), { recursive: true });
  atomicWrite(safePath(f.root, 'src/sub/extra.py'), 'def extra():\n    return 1\n');
  const plan = planSurvey(f.root, f.config, 'facts', { maxFiles: 2 });
  assert.deepEqual(plan.scopes.map(s => [s.id, s.files]), [['001-src', ['src/main.py', 'src/math_ops.py']], ['002-src', ['src/text_ops.py']], ['003-src-sub', ['src/sub/extra.py']]]);
  let calls = 0;
  const failing = async args => { calls++; if (args.unit.source === '002-src') throw new Error('Agent did not return one valid JSON object'); return answer(args); };
  const error = await runSurvey(f.root, f.config, 'facts', failing, { maxFiles: 2 }).catch(e => e);
  assert.match(error.message, /002-src: Agent did not return/);
  assert.deepEqual(surveyStatus(f.root, f.config, 'facts', { maxFiles: 2 }).scopes.map(s => s.status), ['done', 'pending', 'done'], 'one failed scope does not stop the others');
  assert.throws(() => mergeSurvey(f.root, f.config, 'facts', { maxFiles: 2 }), /Survey incomplete: 1 of 3/);
  calls = 0;
  const report = await runSurvey(f.root, f.config, 'facts', async args => { calls++; return answer(args); }, { maxFiles: 2 });
  assert.equal(calls, 1, 'only the pending scope runs again');
  assert.equal(report.done, 3);
  const merged = mergeSurvey(f.root, f.config, 'facts', { maxFiles: 2 });
  assert.equal(merged.items, 4);
  assert.match(fs.readFileSync(safePath(f.root, 'migration/surveys/facts.md'), 'utf8'), /## entry-point \(4\)[\s\S]*src\/sub\/extra\.py:1/);
  const record = readJSON(safePath(f.root, 'migration/surveys/facts/001-src.json'));
  assert.equal(record.requestedModel, 'survey-model');
  // A changed source invalidates exactly its scope.
  atomicWrite(safePath(f.root, 'src/text_ops.py'), `${fs.readFileSync(safePath(f.root, 'src/text_ops.py'), 'utf8')}# changed\n`);
  assert.deepEqual(surveyStatus(f.root, f.config, 'facts', { maxFiles: 2 }).scopes.map(s => s.status), ['done', 'pending', 'done']);
});

test('survey results are validated against their scope before they are written', async t => {
  const f = fixture(t);
  const bad = mutate => async args => { const r = answer(args); mutate(r.result); return r; };
  for (const [mutate, message] of [
    [r => { r.items[0].file = 'src/elsewhere.py'; }, /outside its scope/],
    [r => { r.items[0].evidence = 'no line cited'; }, /must cite PATH:LINE/],
    [r => { r.items[0].category = 'opinion'; }, /Unknown fact category/],
    [r => { r.target = 'ported/main.mjs'; }, /target mismatch/]]) {
    const error = await runSurvey(f.root, f.config, 'facts', bad(mutate), { maxFiles: 1 }).catch(e => e);
    assert.match(error.message, message);
    assert.equal(fs.existsSync(safePath(f.root, 'migration/surveys/facts/001-src.json')), false);
  }
  const g = failureGuidanceList('Survey stopped: 001-src: Survey item outside its scope: src/elsewhere.py', { root: f.root });
  assert.equal(g[0].guidance.id, 'survey-result');
});

test('contracts survey fills the source-as-spec skeleton but never overwrites edited contracts', async t => {
  const f = fixture(t);
  initSourceSpec(f.root, f.config, { apply: true });
  const config = loadConfig(f.root);
  await runSurvey(f.root, config, 'contracts', async args => answer(args));
  const merged = mergeSurvey(f.root, config, 'contracts');
  assert.equal(merged.out, 'migration/source-spec/contracts.md');
  const text = fs.readFileSync(safePath(f.root, merged.out), 'utf8');
  assert.doesNotMatch(text, /TODO\(spec\)/);
  assert.match(text, /## src\/main\.py\n\n- Public interface: functions/);
  atomicWrite(safePath(f.root, merged.out), `${text}\nHuman note.\n`);
  // A rerun with nothing pending merges into a draft instead of the edited file.
  const again = mergeSurvey(f.root, config, 'contracts');
  assert.equal(again.out, 'migration/surveys/contracts.draft.md');
  assert.match(fs.readFileSync(safePath(f.root, 'migration/source-spec/contracts.md'), 'utf8'), /Human note/);
});

test('inventory survey classifies a mechanical census per scope and publishes through the inventory merge', async t => {
  const f = fixture(t);
  atomicWrite(safePath(f.root, 'migration/inventory-sites.tsv'), 'file\tsymbol\tsource_construct\nsrc/math_ops.py\tdivide\tfloor division\nsrc/text_ops.py\tlength\tlen()\n');
  await assert.rejects(runSurvey(f.root, f.config, 'inventory', async args => answer(args)), /mechanical site census/);
  const report = await runSurvey(f.root, f.config, 'inventory', async args => answer(args), { sitesFile: 'migration/inventory-sites.tsv' });
  assert.equal(report.total, 1, 'only files with census sites are surveyed');
  const merged = mergeSurvey(f.root, f.config, 'inventory', { sitesFile: 'migration/inventory-sites.tsv' });
  assert.equal(merged.uniqueSites, 2);
  assert.match(fs.readFileSync(safePath(f.root, 'migration/inventory.tsv'), 'utf8'), /src\/math_ops\.py\tdivide\tfloor division\tOWNED\tnumber/);
  // Missing a census site is an incomplete classification, not a pass.
  const g = fixture(t);
  atomicWrite(safePath(g.root, 'migration/inventory-sites.tsv'), 'file\tsymbol\tsource_construct\nsrc/math_ops.py\tdivide\tfloor division\nsrc/math_ops.py\tmod\tremainder\n');
  const partial = async args => { const r = answer(args); r.result.items.pop(); return r; };
  await assert.rejects(runSurvey(g.root, g.config, 'inventory', partial, { sitesFile: 'migration/inventory-sites.tsv' }), /covered 1 of 2 scope sites/);
});

test('CLI surveyors run as fresh tool-free Copilot processes on the surveyor profile', async t => {
  const f = fixture(t), layout = runtimeLayout(f.root, f.config);
  const args = copilotArgs('surveyor', 'survey-model', undefined, layout);
  assert.deepEqual(args.slice(args.indexOf('--agent'), args.indexOf('--agent') + 4), ['--agent', 'migration-surveyor', '--model', 'survey-model']);
  assert.ok(args.includes('--no-custom-instructions'));
  assert.equal(args[args.indexOf('--deny-tool') + 1], 'read,write,shell');
  assert.match(decide({ toolName: 'view', toolArgs: { path: 'src/a.py' } }, 'surveyor'), /no tools/);
  const script = safePath(f.root, 'survey-cli.mjs'), log = safePath(f.root, 'survey-calls.jsonl');
  atomicWrite(script, `import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 0.0.0-test.'); process.exit(0); }
let prompt = ''; for await (const c of process.stdin) prompt += c;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), role: process.env.MIGRATION_KIT_ROLE }) + '\\n');
const target = prompt.match(/Set target to "([^"]+)"/)[1];
const input = JSON.parse(prompt.match(/Frozen task input \\(JSON task data\\):\\n(.*)\\n/)[1]);
const items = input.files.map(f => ({ file: f.path, category: 'risk', summary: 'risky', evidence: f.path + ':1' }));
console.log(JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify({ schemaVersion: 1, kind: 'survey', survey: input.kind, target, items }), toolRequests: [] } }));
console.log(JSON.stringify({ type: 'result', exitCode: 0 }));
`);
  const report = await runSurvey(f.root, f.config, 'facts', createCopilotAdapter({ command: process.execPath, prefixArgs: [script] }), { maxFiles: 2 });
  assert.equal(report.done, 2);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.role === 'surveyor' && c.argv.includes('migration-surveyor')));
});

