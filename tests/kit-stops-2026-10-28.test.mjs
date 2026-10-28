// SPDX-License-Identifier: Apache-2.0
// Stops caused by the kit itself (2026-10-28 review): a phase asked the
// person about something the kit should have prepared or decided. Each case
// was reproduced on a real old OSS tree (NUnit v2, phpBB 3.0.0) first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { install, kitRoot } from '../scripts/install.mjs';
import { python } from './helpers.mjs';
import { safePath, readJSON, writeJSON, atomicWrite, loadConfig } from '../lib/core.mjs';
import { decodeSource } from '../lib/text.mjs';
import { migrationStatus } from '../lib/status.mjs';
import * as loadReadiness from '../lib/source-spec.mjs';

const runner = path.join(kitRoot, 'scripts/run_migration.mjs');
const run = (root, ...args) => {
  const r = spawnSync(process.execPath, [runner, ...args, '--root', root], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json };
};
// A source-as-spec project as the orchestrator leaves it after initialization:
// languages and roots set, models chosen, the installer's verificationRoots
// default ("tests") left as it is although the tree has no such directory.
function project(t, { profile = 'source-as-spec', files = { 'app/A.php': '<?php\nrequire_once __DIR__ . "/B.php";\n', 'app/B.php': '<?php\nfunction b() { return 1; }\n', 'app/config.php': '' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-stops-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double', language: 'ja', ...(profile ? { preparationProfile: profile } : {}) });
  for (const [name, content] of Object.entries(files)) atomicWrite(safePath(root, name), content);
  const file = safePath(root, 'migration/config.json'), config = readJSON(file);
  Object.assign(config, { sourceLanguage: 'PHP', targetLanguage: 'TypeScript', sourceRoots: ['app'] });
  writeJSON(file, config);
  assert.equal(run(root, 'phase', 'init').status, 0);
  return root;
}
const ok = (r, label) => assert.equal(r.status, 0, `${label}: ${r.stderr}`);
function reviewFeasibility(root) {
  ok(run(root, 'phase', 'start', '00'), 'phase start 00');
  atomicWrite(safePath(root, 'migration/feasibility.md'), '# Feasibility\nPHP to TypeScript.\n');
  ok(run(root, 'phase', 'complete', '00', '--note', 'reviewed'), 'phase complete 00');
}

test('source-as-spec 00b runs without a tests directory, with an empty source file, and without a consent stop for the kit\'s own drafts', t => {
  const root = project(t);
  reviewFeasibility(root);
  ok(run(root, 'phase', 'start', '00b'), 'phase start 00b');
  // Already source-as-spec: the drafts are written without --apply (no gate).
  const init = run(root, 'source-spec', 'init');
  ok(init, 'source-spec init');
  assert.equal(init.json.applied, true);
  assert.ok(fs.existsSync(safePath(root, 'migration/judge-plan.json')) && fs.existsSync(safePath(root, 'migration/source-spec/sources.md')));
  assert.ok(readJSON(safePath(root, 'migration/judge-plan.json')).sources.includes('app/config.php'));
  // verificationRoots is still ["tests"], which does not exist.
  assert.equal(fs.existsSync(safePath(root, 'tests')), false);
  const prepare = run(root, 'judge-prepare');
  ok(prepare, 'judge-prepare');
  assert.equal(prepare.json.success, true);
  atomicWrite(safePath(root, 'migration/judge-report.md'), '# Judge\nsource-as-spec\n');
  ok(run(root, 'phase', 'check', '00b'), 'phase check 00b');
});

test('a source-as-spec package starts 01 and 02 before 00b is recorded, checks the package whole and still records it in order', t => {
  const root = project(t);
  reviewFeasibility(root);
  ok(run(root, 'source-spec', 'init'), 'source-spec init');
  atomicWrite(safePath(root, 'migration/judge-report.md'), '# Judge\n');
  ok(run(root, 'phase', 'start', '01'), 'phase start 01 inside the package');
  const check = run(root, 'source-spec', 'check').json.commands;
  assert.match(check.manifest, /--ext '\.php=\.ts'/);
  assert.doesNotMatch(check.manifest, /SOURCE_EXT/);
  for (const command of [check.dependencyMap, check.manifest, check.reviewDependencies]) {
    const r = spawnSync(process.platform === 'win32' ? 'powershell' : 'bash', process.platform === 'win32' ? ['-Command', command] : ['-c', command], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `${command}\n${r.stderr}`);
  }
  assert.match(fs.readFileSync(safePath(root, 'migration/manifest.tsv'), 'utf8'), /app\/A\.php\tported\/A\.ts/);
  atomicWrite(safePath(root, 'migration/depmap/report.md'), '# Map\n');
  const one = run(root, 'phase', 'check', '01');
  ok(one, 'phase check 01 inside the package');
  assert.equal(one.json.recordWith, 'phase complete 00b,01,02', 'a lone package check says how it is recorded');
  ok(run(root, 'phase', 'start', '02'), 'phase start 02 inside the package');
  atomicWrite(safePath(root, 'migration/RULEBOOK.md'), '# PHP to TypeScript rules\n');
  atomicWrite(safePath(root, 'migration/inventory.tsv'), 'file\tissue\tdecision\napp/A.php\tinclude\tES import\n');
  atomicWrite(safePath(root, 'migration/gap-report.md'), '# Gaps\n');
  const whole = run(root, 'phase', 'check', '00b,01,02');
  ok(whole, 'phase check 00b,01,02');
  assert.deepEqual(whole.json.map(p => p.phase), ['00b', '01', '02']);
  // Recording 01 alone still needs 00b first: completion keeps the order.
  const alone = run(root, 'phase', 'complete', '01', '--note', 'x');
  assert.notEqual(alone.status, 0); assert.match(alone.stderr, /Phase 00b is not reviewed/);
  ok(run(root, 'phase', 'complete', '00b,01,02', '--note', 'package reviewed'), 'phase complete 00b,01,02');
  ok(run(root, 'judge'), 'judge');
});

test('status during preparation lists later artifacts as not written yet instead of blockers', t => {
  const root = project(t);
  reviewFeasibility(root);
  const report = migrationStatus(root);
  assert.equal(report.workflow.next, '00b');
  assert.deepEqual(report.blockers, []);
  assert.ok(report.pendingArtifacts.includes('migration/manifest.tsv'));
  const markdown = run(root, 'status', '--format', 'markdown').stdout;
  assert.doesNotMatch(markdown, /阻害要因/);
  assert.match(markdown, /未作成（現在または後の工程で作るもの。問題ではありません）/);
});

test('runtime projects still need their verification roots, and the error names the setting to fix', t => {
  const root = project(t, { profile: null });
  reviewFeasibility(root);
  const r = run(root, 'judge-prepare');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Judge input root missing: tests \(verificationRoots in migration\/config\.json/);
  assert.match(r.stderr, /verificationRoots を実在するディレクトリに直す/);
});

test('legacy encodings decode like the bundled mappers; binaries stay binary', () => {
  const cases = [
    [Buffer.from('// La informaci\xf3n general', 'latin1'), 'windows-1252', 'información'],
    [Buffer.from('// COPYRIGHT : \xa9 2004', 'latin1'), 'windows-1252', '©'],
    [Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x0a]), 'cp932', 'あい'],
    [Buffer.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0a]), 'euc-jp', 'あい'],
    [Buffer.from('﻿hello', 'utf8'), 'utf-8', '﻿hello'],
    [Buffer.from([0xff, 0xfe, 0x68, 0, 0x69, 0]), 'utf-16le', 'hi'],
    [Buffer.from([0x68, 0, 0x69, 0]), 'utf-16le', 'hi']
  ];
  for (const [data, encoding, text] of cases) {
    const decoded = decodeSource(data);
    assert.equal(decoded.encoding, encoding, data.toString('hex'));
    assert.ok(decoded.content.includes(text), `${encoding}: ${decoded.content}`);
  }
  assert.deepEqual(decodeSource(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13])), { binary: true });
  // The Python mappers pick the same Japanese encoding (EUC-JP included).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-decode-'));
  try {
    fs.writeFileSync(path.join(dir, 'e.txt'), Buffer.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0a]));
    const r = spawnSync(python, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(kitRoot, 'scripts'))}); from pathlib import Path; from depmap_common import read_source; w=[]; print(read_source(Path(${JSON.stringify(path.join(dir, 'e.txt'))}), w).strip(), w[0].split(':')[0])`], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'あい decoded as euc-jp');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('make_manifest refuses the extension placeholder and replaces only the file extension with --ext', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'order.txt'), 'lib.cs/a.cs\tb.CS\n');
  const script = path.join(kitRoot, 'scripts/make_manifest.py'), out = path.join(dir, 'm.tsv');
  const bad = spawnSync(python, [script, '--order', path.join(dir, 'order.txt'), '--out', out, '--prefix', 'src/', '--map-root', 'src=ported', '--ext', '.SOURCE_EXT=.TARGET_EXT'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /placeholder/); assert.equal(fs.existsSync(out), false);
  const good = spawnSync(python, [script, '--order', path.join(dir, 'order.txt'), '--out', out, '--prefix', 'src/', '--map-root', 'src=ported', '--ext', '.cs=.ts'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'source\ttarget\nsrc/lib.cs/a.cs\tported/lib.cs/a.ts\nsrc/b.CS\tported/b.ts\n');
});

test('the PHP mapper names the variables that leave most includes unresolved and --include-var resolves them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-php-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (const n of names) atomicWrite(safePath(root, `includes/${n}.php`), `<?php\nfunction ${n}() {}\n`);
  atomicWrite(safePath(root, 'index.php'), `<?php\n${names.map(n => `include($phpbb_root_path . 'includes/${n}.' . $phpEx);`).join('\n')}\n`);
  const script = path.join(kitRoot, 'scripts/depmap_php.py');
  const plain = spawnSync(python, [script, '--root', root, '--out', path.join(root, 'out1')], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, /6 includes compute their path; most use \$phpEx, \$phpbb_root_path .*--include-var phpEx=VALUE,phpbb_root_path=VALUE/);
  const fixed = spawnSync(python, [script, '--root', root, '--out', path.join(root, 'out2'), '--include-var', 'phpbb_root_path=,phpEx=php'], { encoding: 'utf8' });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.doesNotMatch(fixed.stderr, /compute their path/);
  assert.equal(fs.readFileSync(path.join(root, 'out2/edges.tsv'), 'utf8').trim().split('\n').length - 1, 6);
});

test('survey merge of an inventory no longer fails on its own run lock', async t => {
  const root = project(t, { files: { 'app/A.php': '<?php\nfunction a() { return 1; }\n' } });
  reviewFeasibility(root);
  ok(run(root, 'source-spec', 'init'), 'source-spec init');
  atomicWrite(safePath(root, 'migration/judge-report.md'), '# Judge\n');
  atomicWrite(safePath(root, 'migration/depmap/report.md'), '# Map\n');
  atomicWrite(safePath(root, 'migration/manifest.tsv'), 'source\ttarget\napp/A.php\tported/A.ts\n');
  writeJSON(safePath(root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies: { 'app/A.php': [] } });
  atomicWrite(safePath(root, 'migration/RULEBOOK.md'), '# Rules\n');
  ok(run(root, 'phase', 'complete', '00b,01', '--note', 'reviewed'), 'phase complete 00b,01');
  const sites = 'migration/sites.tsv';
  atomicWrite(safePath(root, sites), 'file\tsymbol\tsource_construct\napp/A.php\ta\treturn\n');
  const { runSurvey } = await import('../lib/survey.mjs');
  await runSurvey(root, loadConfig(root), 'inventory', async args => ({ result: { schemaVersion: 1, kind: 'survey', survey: 'inventory', target: 'x',
    items: [{ file: 'app/A.php', symbol: 'a', source_construct: 'return', classification: 'int', target_translation: 'number', evidence: 'app/A.php:2', status: 'confirmed' }] } }), { sitesFile: sites });
  const merge = run(root, 'survey', 'merge', '--kind', 'inventory', '--sites', sites);
  ok(merge, 'survey merge --kind inventory');
  assert.match(fs.readFileSync(safePath(root, 'migration/inventory.tsv'), 'utf8'), /app\/A\.php\ta\treturn\t/);
  assert.equal(fs.existsSync(safePath(root, 'migration/run.lock')), false);
});

test('a preparation audit uses the reviewer model when its phaseModels entry is not set', async t => {
  const root = project(t, { files: { 'app/A.php': '<?php\n' } });
  const { freezeAudit } = await import('../scripts/audit_inputs.mjs');
  const config = loadConfig(root);
  assert.equal(config.phaseModels.judgeAudit, undefined);
  const request = freezeAudit(root, config, { type: 'judge', files: ['app/A.php'] });
  assert.equal(readJSON(safePath(root, `${request.directory}/request.json`)).requestedModel, 'test-double');
});

test('a second source extension keeps its name in the target, so a.php and a.inc never collide', t => {
  const root = project(t, { files: { 'app/a.php': '<?php\n', 'app/b.php': '<?php\n', 'app/a.inc': '<?php\n' } });
  atomicWrite(safePath(root, 'migration/depmap/order.txt'), 'a.php\tb.php\na.inc\n');
  const { sourceSpecReadiness } = loadReadiness;
  const manifest = sourceSpecReadiness(root, loadConfig(root)).commands.manifest;
  assert.match(manifest, /--ext '\.php=\.ts' --ext '\.inc=\.inc\.ts'/);
  const r = spawnSync('bash', ['-c', manifest], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(safePath(root, 'migration/manifest.tsv'), 'utf8'), 'source\ttarget\napp/a.php\tported/a.ts\napp/b.php\tported/b.ts\napp/a.inc\tported/a.inc.ts\n');
});

test('re-review fixes: legacy audit inputs freeze, a wrong root stays a blocker, package checks stay in preparation, a declared encoding wins', async t => {
  const root = project(t, { files: { 'app/A.php': Buffer.from('<?php // caf\xe9\n', 'latin1'), 'app/K.php': Buffer.from([0x3c, 0x3f, 0x0a, 0x2f, 0x2f, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]) } });
  const { freezeAudit } = await import('../scripts/audit_inputs.mjs');
  const frozen = freezeAudit(root, loadConfig(root), { type: 'judge', files: ['app/A.php'] });
  assert.match(frozen.request.input.files[0].content, /café/);
  assert.equal(frozen.request.input.files[0].encoding, 'windows-1252');
  // Kanji without kana reads as Latin-1 by its bytes; a declared encoding decides.
  const { readReviewSource } = await import('../lib/review.mjs');
  assert.equal(readReviewSource(root, 'app/K.php').encoding, 'windows-1252');
  const file = safePath(root, 'migration/config.json');
  writeJSON(file, { ...readJSON(file), sourceEncoding: 'shift_jis' });
  assert.deepEqual(readReviewSource(root, 'app/K.php'), { content: '<?\n//日本語\n', encoding: 'shift_jis' });
  assert.equal(readReviewSource(root, 'app/A.php').encoding, 'windows-1252', 'a file the declared encoding cannot read still decodes');
  writeJSON(file, { ...readJSON(file), sourceEncoding: 'no-such-encoding' });
  assert.throws(() => loadConfig(root), /sourceEncoding must be an encoding label/);
  writeJSON(file, { ...readJSON(file), sourceEncoding: 'shift_jis', verificationMode: 'runtime', preparationProfile: 'standard' });
  reviewFeasibility(root);
  const report = migrationStatus(root);
  assert.ok(report.blockers.some(b => /Input root missing: tests \(verificationRoots/.test(b.reason)), 'a missing runtime root is still shown');
  const listed = run(root, 'phase', 'check', '00b,01,02,03');
  assert.notEqual(listed.status, 0); assert.match(listed.stderr, /Only preparation phases 00 through 02 can be checked together/);
  // Once the root exists, the review dependency map that 01 writes is pending, not a blocker.
  fs.mkdirSync(safePath(root, 'tests'));
  const later = migrationStatus(root);
  assert.deepEqual(later.blockers.filter(b => b.path === 'migration inputs'), []);
  // Worker input names Shift_JIS "cp932"; the same name is accepted as the setting.
  writeJSON(file, { ...readJSON(file), sourceEncoding: 'cp932' });
  assert.equal(readReviewSource(root, 'app/K.php').content, '<?\n//日本語\n');
  writeJSON(file, { ...readJSON(file), sourceEncoding: ['shift_jis'] });
  assert.throws(() => loadConfig(root), /sourceEncoding must be an encoding label/);
  writeJSON(file, { ...readJSON(file), sourceEncoding: 'shift_jis' });
  // A deleted audit input is a changed input with its recovery, not a raw ENOENT.
  fs.rmSync(safePath(root, 'app/A.php'));
  const { runAudit } = await import('../scripts/audit_inputs.mjs');
  await assert.rejects(runAudit(root, loadConfig(root), async () => { throw new Error('not called'); }, { directory: frozen.directory }), /Preparation audit inputs changed/);
  // Also for an input outside the source roots, which the snapshot does not cover.
  atomicWrite(safePath(root, 'migration/notes.md'), 'note\n');
  const outside = freezeAudit(root, loadConfig(root), { type: 'judge', files: ['migration/notes.md'] });
  fs.rmSync(safePath(root, 'migration/notes.md'));
  await assert.rejects(runAudit(root, loadConfig(root), async () => { throw new Error('not called'); }, { directory: outside.directory }), /Preparation audit inputs changed/);
  atomicWrite(safePath(root, 'migration/notes.md'), 'note\n');
  const turned = freezeAudit(root, loadConfig(root), { type: 'judge', files: ['migration/notes.md'] });
  fs.writeFileSync(safePath(root, 'migration/notes.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x49, 0x48]));
  await assert.rejects(runAudit(root, loadConfig(root), async () => { throw new Error('not called'); }, { directory: turned.directory }), /Preparation audit inputs changed/);
});

test('a legacy-encoded unit source over the input budget is named, not inlined', async t => {
  const root = project(t, { files: { 'app/K.php': Buffer.from([0x3c, 0x3f, 0x0a, ...Array(300).fill([0x93, 0xfa]).flat(), 0x82, 0xa0, 0x0a]) } });
  const { legacySources } = await import('../lib/review.mjs');
  const deps = safePath(root, 'migration/review-dependencies.json');
  writeJSON(deps, { schemaVersion: 1, dependencies: { 'app/K.php': [] } });
  const config = { ...loadConfig(root), maxReviewInputBytes: 256 };
  const [entry] = legacySources(root, config, { source: 'app/K.php' });
  assert.equal(entry.encoding, 'cp932'); assert.equal(entry.content, undefined);
  assert.equal(legacySources(root, { ...config, maxReviewInputBytes: 65536 }, { source: 'app/K.php' })[0].content.length, 305);
  // The unit's own source takes the budget before a dependency that sorts first.
  // Each fits alone (A 457 bytes, K 307 decoded), not both.
  fs.writeFileSync(safePath(root, 'app/A.php'), Buffer.from([0x3c, 0x3f, 0x0a, ...Array(150).fill([0x93, 0xfa]).flat(), 0x82, 0xa0, 0x0a]));
  fs.writeFileSync(safePath(root, 'app/K.php'), Buffer.from([0x3c, 0x3f, 0x0a, ...Array(100).fill([0x93, 0xfa]).flat(), 0x82, 0xa0, 0x0a]));
  writeJSON(deps, { schemaVersion: 1, dependencies: { 'app/K.php': ['app/A.php'], 'app/A.php': [] } });
  const ordered = legacySources(root, { ...config, maxReviewInputBytes: 600 }, { source: 'app/K.php' });
  assert.deepEqual(ordered.map(e => [e.path, typeof e.content]), [['app/K.php', 'string'], ['app/A.php', 'undefined']]);
});

test('Sonnet review: distinct blockers stay listed; missing source roots get no profile switch', async t => {
  const root = project(t, { profile: null });
  const file = safePath(root, 'migration/config.json');
  writeJSON(file, { ...readJSON(file), phasePolicy: 'legacy' });
  fs.rmSync(safePath(root, 'migration/phases/policy.json'), { force: true });
  const missing = migrationStatus(root).blockers.filter(b => b.reason === 'Preparation artifact missing').map(b => b.path);
  assert.ok(missing.length > 1, `every missing artifact is listed: ${missing}`);
  const { failureGuidance } = await import('../lib/guidance.mjs');
  const options = message => failureGuidance(new Error(message), { root }).options.map(o => o.id);
  assert.ok(!options('Input root missing: nosuch (sourceRoots in migration/config.json must name existing source directories)').includes('source-as-spec'));
  assert.ok(options('Input root missing: tests (verificationRoots in migration/config.json must name the existing directory)').includes('source-as-spec'));
});
