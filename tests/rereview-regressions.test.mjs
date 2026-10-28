import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, fake, result, finding } from './helpers.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, contextHash, readManifest, done, loadConfig, unitState } from '../lib/core.mjs';
import { reviewInput, reviewEvidence } from '../lib/review.mjs';
import { agentPrompt } from '../scripts/copilot_adapter.mjs';

const write = (root, name, content) => atomicWrite(safePath(root, name), content);
const persist = f => writeJSON(safePath(f.root, 'migration/config.json'), f.config);
async function start(f) {
  persist(f);
  f.config = loadConfig(f.root);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Rereview regression fixture');
  await translate(f.root, f.config, fake);
}
async function build(f) {
  approve(f.root, f.config, 'build', 'Rereview regression fixture');
  await runStage(f.root, f.config, 'build');
}

test('RR1: changing a command script under migration invalidates receipts and downstream approval', async t => {
  const f = prepare(t);
  write(f.root, 'migration/build.mjs', 'process.exit(0);\n');
  f.config.commands.build = [process.execPath, 'migration/build.mjs'];
  await start(f); await build(f);
  const unit = readManifest(f.root, f.config)[0], before = contextHash(f.root, f.config);
  assert.ok(done(f.root, unit, before));
  write(f.root, 'migration/build.mjs', 'process.exit(9);\n');
  assert.notEqual(contextHash(f.root, f.config), before);
  assert.equal(done(f.root, unit, contextHash(f.root, f.config)), false);
  assert.throws(() => approve(f.root, f.config, 'smoke', 'Old build must be rejected'), /current reviewed receipts/);
  await assert.rejects(runStage(f.root, f.config, 'build'), /stale/);
});

test('RR1: explicit verification inputs under migration are accepted and invalidate approval when changed', async t => {
  const f = prepare(t);
  write(f.root, 'migration/build-settings.json', '{"mode":"a"}\n');
  f.config.verificationInputs = ['migration/build-settings.json'];
  await start(f); await build(f);
  const before = contextHash(f.root, f.config);
  write(f.root, 'migration/build-settings.json', '{"mode":"b"}\n');
  assert.notEqual(contextHash(f.root, f.config), before);
  assert.throws(() => approve(f.root, f.config, 'smoke', 'Changed input must revoke old results'), /current reviewed receipts/);
});

test('RR1: generated runtime paths cannot become command files or explicit verification inputs', async t => {
  const f = prepare(t);
  for (const name of ['migration/state/script.mjs', 'migration/results/script.mjs', 'migration/gates/config.json', 'migration/runs/script.mjs', 'migration/run.lock']) {
    f.config.verificationInputs = [name]; persist(f);
    assert.throws(() => loadConfig(f.root), /overlaps outputs or runtime state/, name);
    delete f.config.verificationInputs;
    f.config.commands.original = [process.execPath, name]; persist(f);
    await assert.rejects(runStage(f.root, f.config, 'judge'), /generated migration state/, name);
    assert.equal(fs.existsSync(safePath(f.root, 'migration/results/judge.json')), false);
    assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
  }
});

test('RR2: validation fails if any explicitly mapped output under an excluded directory is changed', async t => {
  for (const directory of ['node_modules', '__pycache__', '.git']) {
    const f = prepare(t), target = `ported/${directory}/math_ops.mjs`;
    write(f.root, 'migration/manifest.tsv', `source\ttarget\nsrc/math_ops.py\t${target}\n`);
    f.config.commands.build = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(target)}, '\\nthrow new Error("Changed during validation");\\n');`];
    await start(f);
    const unit = readManifest(f.root, f.config)[0];
    assert.ok(done(f.root, unit, contextHash(f.root, f.config)));
    approve(f.root, f.config, 'build', 'Mapped source outputs must not change');
    await assert.rejects(runStage(f.root, f.config, 'build'), /Output source tree changed/, directory);
    const record = readJSON(safePath(f.root, 'migration/results/build.json'));
    assert.equal(record.success, false);
    assert.equal(record.commands[0].code, 0, 'Command succeeds but validation must fail');
    assert.match(record.error, /Output source tree changed/);
    assert.equal(done(f.root, unit, contextHash(f.root, f.config)), false);
    assert.throws(() => approve(f.root, f.config, 'smoke', 'Invalid build must not advance'), /current reviewed receipts/);
  }
});

// A legacy-encoded original stays as it is (it is the specification and may
// still run); workers read it decoded, told which encoding it came from,
// instead of the run stopping to ask for a conversion (0.10.1).
test('RR3: a non-UTF-8 source is decoded for workers, names its encoding and does not stop translation', async t => {
  const f = prepare(t), unit = f.units[0], inputs = [];
  write(f.root, unit.source, Buffer.from("# coding: latin-1\nvalue = 'caf\xe9'\n", 'latin1'));
  persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Encoding fixture');
  await translate(f.root, f.config, args => { inputs.push(args); return fake(args); });
  assert.ok(inputs.length);
  const file = JSON.parse(inputs.find(a => a.reviewInput).reviewInput).files.find(x => x.path === unit.source);
  assert.equal(file.encoding, 'windows-1252');
  const implementer = inputs.find(a => a.role === 'implementer').extra.legacyEncodedSources;
  assert.deepEqual(implementer.map(x => [x.path, x.encoding]), [[unit.source, 'windows-1252']]);
  assert.match(implementer[0].content, /café/);
  assert.match(file.content, /value = 'café'/);
  assert.equal(done(f.root, unit, contextHash(f.root, f.config)), true);
  assert.equal(fs.readFileSync(safePath(f.root, unit.source)).includes(0xe9), true, 'the original bytes are untouched');
});

// The arbiter and tool-assisted reviewers read files with tools (UTF-8): they
// get the decoded legacy source or at least its encoding (Sonnet review).
test('RR3: the arbiter and tool-assisted reviewers are told a source is legacy-encoded', async t => {
  const f = prepare(t), unit = f.units[0], arbiter = [];
  write(f.root, unit.source, Buffer.from("# coding: latin-1\nvalue = 'caf\xe9'\n", 'latin1'));
  persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Encoding fixture');
  await translate(f.root, f.config, async args => {
    if (args.role === 'reviewer-rules') return { result: result(args.role, args.unit, { findings: [finding] }) };
    if (args.role === 'arbiter') { arbiter.push(args); return { result: result(args.role, args.unit, { decisions: args.extra.findings.map(x => ({ finding: x.reference, confirmed: false, reason: 'Rule already satisfied' })) }) }; }
    return fake(args);
  });
  assert.equal(arbiter.length, 1);
  assert.deepEqual(arbiter[0].extra.legacyEncodedSources.map(x => [x.path, x.encoding]), [[unit.source, 'windows-1252']]);
  const assisted = reviewEvidence(f.root, { ...f.config, maxReviewInputBytes: 900 }, unit);
  assert.equal(assisted.mode, 'tool-assisted');
  assert.equal(JSON.parse(assisted.text).files.find(x => x.path === unit.source).encoding, 'windows-1252');
  assert.match(agentPrompt({ role: 'reviewer-rules', unit, reviewInput: assisted.text, reviewMode: 'tool-assisted' }), /stored in that legacy encoding/);
});

test('RR3: a Shift_JIS repair diagnostic (a Japanese Windows compiler log) is decoded, not refused', async t => {
  const f = prepare(t), seen = [];
  await start(f);
  const evidence = 'migration/build-diagnostic.txt';
  write(f.root, evidence, Buffer.from([0x83, 0x47, 0x83, 0x89, 0x81, 0x5b, 0x3a, 0x20, 0x78, 0x0a])); // エラー: x
  await translate(f.root, f.config, args => { seen.push(args); return fake(args); }, { onlyTarget: f.units[0].target, evidence });
  assert.ok(seen.some(a => a.reviewInput.includes('エラー: x')));
  assert.equal(fs.existsSync(safePath(f.root, 'migration/run.lock')), false);
});

test('RR3: binary sources still stop before model calls and name the file', async t => {
  const f = prepare(t), unit = f.units[0], calls = [];
  write(f.root, unit.source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
  persist(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Binary fixture');
  await assert.rejects(translate(f.root, f.config, args => { calls.push(args.role); return fake(args); }), /must be text: src\/math_ops\.py/);
  assert.deepEqual(calls, []);
});

test('RR3: valid UTF-8 Unicode, BOM and an actual replacement character remain lossless', t => {
  const f = prepare(t), unit = f.units[0];
  const content = '\uFEFFvalue = "café 日本語 😀 \uFFFD"\n';
  write(f.root, unit.source, content);
  write(f.root, unit.target, result('implementer', unit).content);
  const snapshot = JSON.parse(reviewInput(f.root, f.config, unit).text);
  assert.equal(snapshot.files.find(file => file.path === unit.source).content, content);
});
