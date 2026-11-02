import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepare, fake, scopesOf } from './helpers.mjs';
import { approve, runStage, translate, currentRecord } from '../lib/pipeline.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, inputContext, verificationFiles, loadConfig, done } from '../lib/core.mjs';
import { doctor } from '../scripts/run_migration.mjs';

const write = (f, name, content) => atomicWrite(safePath(f.root, name), content);
function reload(f) {
  writeJSON(safePath(f.root, 'migration/state/config.json'), f.config);
  f.config = loadConfig(f.root);
}
async function start(f) {
  reload(f);
  await runStage(f.root, f.config, 'judge');
  approve(f.root, f.config, 'translation', 'Astra regression fixture');
  await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Astra regression fixture');
}

test('A1: compiler -c file arguments are tracked without explicit verification inputs', t => {
  const f = prepare(t);
  write(f, 'native/shim.c', 'int shim(void) { return 1; }\n');
  f.config.commands.build = ['cc', '-c', 'native/shim.c', '-o', '/dev/null'];
  reload(f);
  assert.ok(verificationFiles(f.root, f.config).includes('native/shim.c'));
  const before = scopesOf(f.root, f.config);
  write(f, 'native/shim.c', 'invalid C\n');
  assert.notEqual(scopesOf(f.root, f.config), before);
});

test('A1: node -c input changes send the build back and block downstream approval; reviewed units stay', async t => {
  const f = prepare(t);
  write(f, 'native/check.mjs', 'export const value = 1;\n');
  f.config.commands.build = [process.execPath, '-c', 'native/check.mjs'];
  await start(f);
  await runStage(f.root, f.config, 'build');
  const before = scopesOf(f.root, f.config);
  assert.ok(done(f.root, f.units[0], inputContext(f.root, f.config)));
  write(f, 'native/check.mjs', 'export const value = ;\n');
  assert.notEqual(scopesOf(f.root, f.config), before);
  // An input of the build only (0.45.0): the reviewed unit holds; the build
  // record and the build approval (bound to what the build runs) do not.
  const context = inputContext(f.root, f.config);
  assert.equal(done(f.root, f.units[0], context), true);
  assert.equal(currentRecord(f.root, f.config, 'build', context), false);
  assert.throws(() => approve(f.root, f.config, 'smoke', 'Stale build must not be reused'), /Run build successfully for the current inputs first/);
  await assert.rejects(runStage(f.root, f.config, 'build'), /build approval is stale/);
  approve(f.root, f.config, 'build', 'The changed build input was reviewed');
  await assert.rejects(runStage(f.root, f.config, 'build'), /build failed \(exit/);
});

test('A1: only known interpreter inline programs before an entrypoint are skipped', t => {
  const f = prepare(t);
  write(f, 'inlineProgram', 'This filename deliberately also looks like inline code.\n');
  write(f, 'tools/script.py', 'pass\n');
  write(f, 'tools/settings.json', '{}\n');
  for (const command of [
    ['node', '-e', 'inlineProgram'], ['node', '--eval=inlineProgram'],
    ['node.exe', '--print', 'inlineProgram'], ['node', '-r', 'tools/settings.json', '-e', 'inlineProgram'],
    ['python3.12', '-c', 'inlineProgram'], ['python.exe', '-X', 'dev', '-c', 'inlineProgram'],
    ['bash', '-lc', 'inlineProgram']
  ]) {
    f.config.commands.build = command;
    assert.equal(verificationFiles(f.root, f.config).includes('inlineProgram'), false, JSON.stringify(command));
  }
  for (const command of [
    ['custom-tool', '-e', 'tools/settings.json'], ['custom-tool', '--command', 'tools/settings.json'],
    ['python3', 'tools/script.py', '-c', 'tools/settings.json'], ['node', '--', '-e', 'tools/settings.json']
  ]) {
    f.config.commands.build = command;
    assert.ok(verificationFiles(f.root, f.config).includes('tools/settings.json'), JSON.stringify(command));
  }
  f.config.commands.build = ['node', '-e', 'x'.repeat(100000)];
  assert.doesNotThrow(() => scopesOf(f.root, f.config));
});

const artifactBuilder = `import fs from 'node:fs';
import path from 'node:path';
fs.mkdirSync(path.dirname(process.argv[2]), { recursive: true });
fs.writeFileSync(process.argv[2], 'generated object');
`;

test('A2: declared artifact creation and clean rebuild keep input fingerprints stable', async t => {
  const f = prepare(t);
  write(f, 'tools/build.mjs', artifactBuilder);
  f.config.commands.build = [process.execPath, 'tools/build.mjs', 'artifacts/shim.o'];
  f.config.buildArtifactRoots = ['artifacts'];
  await start(f);
  const before = scopesOf(f.root, f.config), inputs = verificationFiles(f.root, f.config);
  assert.ok(inputs.includes('tools/build.mjs'));
  assert.equal((await runStage(f.root, f.config, 'build')).success, true);
  assert.ok(fs.existsSync(safePath(f.root, 'artifacts/shim.o')));
  assert.deepEqual(verificationFiles(f.root, f.config), inputs);
  assert.equal(scopesOf(f.root, f.config), before);
  approve(f.root, f.config, 'smoke', 'Fresh build is valid');
  fs.rmSync(safePath(f.root, 'artifacts'), { recursive: true });
  assert.equal(scopesOf(f.root, f.config), before);
  approve(f.root, f.config, 'build', 'Clean rebuild');
  assert.equal((await runStage(f.root, f.config, 'build')).success, true);
  assert.equal(scopesOf(f.root, f.config), before);
});

test('A2: input changes during a build still fail when artifacts are excluded', async t => {
  const f = prepare(t);
  write(f, 'native/settings.json', '{"value":1}\n');
  write(f, 'tools/build.mjs', artifactBuilder + "fs.writeFileSync('native/settings.json', '{\"value\":2}\\n');\n");
  f.config.commands.build = [process.execPath, 'tools/build.mjs', 'artifacts/shim.o'];
  f.config.verificationInputs = ['native/settings.json'];
  f.config.buildArtifactRoots = ['artifacts'];
  await start(f);
  await assert.rejects(runStage(f.root, f.config, 'build'), /Protected migration inputs changed/);
  const record = readJSON(safePath(f.root, 'migration/results/build.json'));
  assert.equal(record.commands[0].code, 0);
  assert.equal(record.success, false);
  // A verification input: the judge goes back too, the reviewed units stay.
  assert.equal(done(f.root, f.units[0], inputContext(f.root, f.config)), true);
  assert.throws(() => approve(f.root, f.config, 'smoke', 'Changed input must not advance'), /Run judge successfully for the current inputs first/);
});

test('A2: artifact declarations cannot hide protected roots, explicit inputs or metadata', t => {
  const f = prepare(t);
  write(f, 'settings/options.json', '{}\n');
  f.config.verificationInputs = ['settings/options.json'];
  for (const root of ['src', 'src/nested', 'ported', 'tests', 'settings', 'settings/options.json/nested',
    '.git', '.github', '.claude', '.copilot', 'migration', 'migration/state', 'migration-kit',
    'package.json', 'tsconfig.json']) {
    f.config.buildArtifactRoots = [root];
    assert.throws(() => reload(f), /overlaps protected input\/output or metadata/, root);
  }
  f.config.sourceRoots = ['inputs/src'];
  f.config.buildArtifactRoots = ['inputs'];
  assert.throws(() => reload(f), /overlaps protected input\/output or metadata/);
  f.config.sourceRoots = ['src'];
  for (const value of ['artifacts', null, {}]) {
    f.config.buildArtifactRoots = value;
    assert.throws(() => reload(f), /must be an array/);
  }
  write(f, 'artifact-file', 'object');
  f.config.buildArtifactRoots = ['artifact-file'];
  assert.throws(() => reload(f), /must name directories/);
  f.config.buildArtifactRoots = ['../artifacts'];
  assert.throws(() => reload(f), /normalized repository-relative path/);
});

test('A2: unknown -o options keep inputs tracked and old configs require no new field', t => {
  const f = prepare(t);
  delete f.config.buildArtifactRoots;
  write(f, 'native/options.json', '{}\n');
  f.config.commands.build = ['custom-tool', '-o', 'native/options.json'];
  reload(f);
  assert.ok(verificationFiles(f.root, f.config).includes('native/options.json'));
  const before = scopesOf(f.root, f.config);
  write(f, 'native/options.json', '{"changed":true}\n');
  assert.notEqual(scopesOf(f.root, f.config), before);
});

test('A2: doctor reports declared artifact roots separately from protected inputs', async t => {
  const f = prepare(t);
  write(f, 'tools/build.mjs', artifactBuilder);
  write(f, 'artifacts/shim.o', 'object');
  f.config.commands.build = [process.execPath, 'tools/build.mjs', 'artifacts/shim.o'];
  f.config.buildArtifactRoots = ['artifacts'];
  reload(f);
  const checks = (await doctor(f.root, f.config)).checks;
  assert.deepEqual(checks.find(c => c.check === 'build artifact roots').roots, ['artifacts']);
  const inputs = checks.find(c => c.check === 'verification input files').files;
  assert.ok(inputs.includes('tools/build.mjs'));
  assert.equal(inputs.includes('artifacts/shim.o'), false);
});
