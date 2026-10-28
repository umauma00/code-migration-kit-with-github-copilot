// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, fake, mini } from './helpers.mjs';
import { install } from '../scripts/install.mjs';
import { loadConfig, safePath, writeJSON, atomicWrite } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { runSurvey, mergeSurvey } from '../lib/survey.mjs';
import { initSourceSpec, contractsFile, legacyContractsSkeleton, sourceSpecPlan } from '../lib/source-spec.mjs';
import { humanGate, interactiveDecision } from '../lib/guardrails.mjs';

const runner = 'node migration-kit/scripts/run_migration.mjs';

test('Astra S1: a chained approval still asks the person', t => {
  const f = prepare(t);
  for (const [command, gate] of [
    [`${runner} status && ${runner} approve translation --note reviewed`, 'approve translation'],
    [`${runner} status; ${runner} phase complete 02 --note ok`, 'phase complete 02'],
    [`${runner} status&&${runner} pilot prepare`, 'pilot prepare'],
    [`echo ok | ${runner} source-spec init --apply`, 'source-spec init --apply'],
    [`bash -c "${runner} status || ${runner} approve build"`, 'approve build']]) {
    assert.equal(humanGate(command), gate, command);
    assert.equal(interactiveDecision({ toolName: 'bash', toolArgs: { command }, cwd: f.root })?.decision, 'ask', command);
  }
  // --apply on a different segment does not make a preview an approval.
  assert.equal(humanGate(`${runner} source-spec init && echo --apply`), null);
  assert.equal(humanGate(`${runner} status && ${runner} guidance --message "approve translation"`), null);
});

const contractsAnswer = ({ unit, reviewInput }) => {
  const input = JSON.parse(reviewInput);
  return { result: { schemaVersion: 1, kind: 'survey', survey: 'contracts', target: unit.target,
    items: input.files.map(x => ({ file: x.path, publicInterface: 'functions', inputsOutputsErrors: 'ints', edgeCases: 'none', evidence: `${x.path}:1`, unknowns: 'none' })) } };
};

test('Astra S2: any edit to the contracts skeleton sends the merge to a draft', async t => {
  for (const edit of [
    text => text.replace('- Inputs, outputs and errors: TODO(spec)', '- Inputs, outputs and errors: Human note: ints only'),
    text => `${text}\nHuman note appended.\n`]) {
    const f = prepare(t, { count: 3 });
    initSourceSpec(f.root, f.config, { apply: true });
    const config = loadConfig(f.root), file = safePath(f.root, contractsFile);
    // A project drafted before 0.10.0 still holds the per-file contract skeleton.
    const edited = edit(`${legacyContractsSkeleton(config, sourceSpecPlan(f.root, config).sources)}\n`);
    atomicWrite(file, edited);
    await runSurvey(f.root, config, 'contracts', async args => contractsAnswer(args));
    const merged = mergeSurvey(f.root, config, 'contracts');
    assert.equal(merged.out, 'migration/surveys/contracts.draft.md');
    assert.match(merged.note, /has edits/);
    assert.equal(fs.readFileSync(file, 'utf8'), edited, 'the edited contracts stay untouched');
  }
});

test('Astra S3: parallel transient retries never exceed maxAgentCalls', async t => {
  const f = prepare(t, { count: 3 });
  Object.assign(f.config, { transientRetryDelayMs: 20, concurrency: 2, maxAgentCalls: 3 }); f.config.commands.typecheck = null;
  writeJSON(safePath(f.root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: Object.fromEntries(f.units.map(u => [u.source, []])) });
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Astra S3 fixture');
  let calls = 0; const failed = new Set();
  await assert.rejects(translate(f.root, f.config, async args => {
    calls++;
    if (args.role === 'implementer' && !failed.has(args.unit.target)) {
      failed.add(args.unit.target);
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('Copilot implementer failed (exit 1): 503 Service Unavailable');
    }
    return fake(args);
  }));
  assert.equal(failed.size, 2, 'both workers failed their first call');
  assert.equal(calls, 3);
});

test('Astra S4: a package whose later phase fails its hash checks records nothing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-s4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double', preparationProfile: 'source-as-spec' });
  fs.cpSync(path.join(mini, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  const write = (rel, text) => atomicWrite(safePath(root, rel), text);
  write('tests/README.md', 'No original runtime.\n');
  let config = loadConfig(root);
  initSourceSpec(root, config, { apply: true }); config = loadConfig(root);
  phaseCommand(root, config, 'init');
  write('migration/feasibility.md', 'Three files; no original runtime or spec.\n');
  phaseCommand(root, config, 'complete', '00', { note: 'User reviewed feasibility' });
  write('migration/judge-report.md', 'Source-derived contracts.\n');
  write('migration/depmap/edges.tsv', 'from\tto\nsrc/main.py\tsrc/math_ops.py\n');
  write('migration/depmap/order.txt', 'src/math_ops.py\nsrc/main.py\n');
  write('migration/depmap/report.md', 'Python parser over src.\n');
  write('migration/gap-report.md', 'Floor division decided from source.\n');
  write('migration/manifest.tsv', 'source\ttarget\nsrc/math_ops.py\tported/math_ops.mjs\nsrc/text_ops.py\tported/text_ops.mjs\nsrc/main.py\tported/main.mjs\n');
  write('migration/RULEBOOK.md', '# Rules drafted from source\n');
  write('migration/inventory.tsv', 'file\tissue\tdecision\nsrc/math_ops.py\tnegative division\tfloor\n');
  // src/text_ops.py has no declaration: only phase 02's context hash notices.
  const declare = deps => write('migration/review-dependencies.json', JSON.stringify({ schemaVersion: 1, dependencies: deps }));
  declare({ 'src/math_ops.py': [], 'src/main.py': ['src/math_ops.py'] });
  assert.throws(() => phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User OK' }), /declaration missing: src\/text_ops\.py/);
  for (const id of ['00b', '01', '02']) assert.equal(fs.existsSync(safePath(root, `migration/phases/${id}.json`)), false, id);
  declare({ 'src/math_ops.py': [], 'src/text_ops.py': [], 'src/main.py': ['src/math_ops.py'] });
  assert.deepEqual(phaseCommand(root, config, 'complete', '00b,01,02', { note: 'User OK' }).map(r => r.phase), ['00b', '01', '02']);
});
