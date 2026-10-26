// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare, python } from './helpers.mjs';
import { kitRoot } from '../scripts/install.mjs';
import { runProcess } from '../lib/process.mjs';
import { atomicWrite, safePath, readManifest, readJSON } from '../lib/core.mjs';
import { sourceSpecReadiness } from '../lib/source-spec.mjs';

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-parsers-')), out = `${root}-out`;
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel); fs.mkdirSync(path.dirname(full), { recursive: true });
    if (body === null) fs.mkdirSync(full); else fs.writeFileSync(full, body);
  }
  return { root, out };
}
async function map(lang, p, options = []) {
  const script = path.join(kitRoot, `scripts/depmap_${lang}.${lang === 'ts' ? 'mjs' : 'py'}`);
  const r = await runProcess(lang === 'ts' ? process.execPath : python, [...(lang === 'ts' ? [] : ['-I']), script, '--root', p.root, '--out', p.out, ...options]);
  assert.equal(r.code, 0, r.stderr);
  return { ...r, edges: fs.readFileSync(path.join(p.out, 'edges.tsv'), 'utf8'), order: fs.readFileSync(path.join(p.out, 'order.txt'), 'utf8') };
}
const unresolved = p => fs.readFileSync(path.join(p.out, 'unresolved.tsv'), 'utf8');

test('Python honors UTF-8 BOM and declared Latin-1/cp932 identifiers instead of silently losing imports', async t => {
  const p = project(t, {
    'bom.py': Buffer.from('\uFEFFimport shared\n'), 'shared.py': 'value=1\n',
    'latin.py': Buffer.from('# coding: latin-1\nimport caf\xe9\n', 'latin1'), 'café.py': 'value=2\n',
    'sjis.py': Buffer.concat([Buffer.from('# coding: cp932\nimport '), Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from('\n')]), '日本.py': 'value=3\n'
  });
  const r = await map('python', p);
  assert.equal(r.edges, 'from\tto\nbom.py\tshared.py\nlatin.py\tcafé.py\nsjis.py\t日本.py\n');
  assert.doesNotMatch(r.stderr, /unparseable/);
});

test('Python keeps invalid/deep files visible as unresolved and ignores directories named .py', async t => {
  const p = project(t, { 'folder.py': null, 'a.py': 'import b\n', 'b.py': 'value=1\n', 'broken.py': 'def unfinished(\n', 'deep.py': 'x=' + '1+'.repeat(12000) + '1\n' });
  const r = await map('python', p);
  assert.match(r.edges, /a\.py\tb\.py/); assert.doesNotMatch(r.order, /folder\.py/);
  assert.match(r.order, /broken\.py/); assert.match(r.order, /deep\.py/);
  assert.match(unresolved(p), /broken\.py\t\(whole file\)/); assert.match(unresolved(p), /deep\.py\t\(whole file\)/);
  assert.doesNotMatch(r.stderr, /Traceback/);
});

test('PHP rejects malformed composer shapes as warnings while preserving valid autoload paths and source edges', async t => {
  for (const data of [[], null, 7, { autoload: ['bad'] }, { autoload: { 'psr-4': ['bad'] } }, { autoload: { classmap: [null, 5] } }]) {
    const p = project(t, { 'composer.json': JSON.stringify(data), 'A.php': '<?php require __DIR__."/B.php";', 'B.php': '<?php class B {}' });
    const r = await map('php', p);
    assert.match(r.edges, /A\.php\tB\.php/); assert.match(r.stderr, /composer\.json/); assert.doesNotMatch(r.stderr, /Traceback/);
  }
  const p = project(t, {
    'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Acme\\': [null, 7, 'src/'] } } }),
    'A.php': '<?php use Acme\\User; $x = new User;', 'src/User.php': '<?php namespace Acme; class User {}', 'other.php': '<?php namespace Acme; class User {}'
  });
  const r = await map('php', p);
  assert.match(r.edges, /A\.php\tsrc\/User\.php/); assert.doesNotMatch(r.edges, /A\.php\tother\.php/);
  assert.match(r.stderr, /invalid path/);
});

test('PHP tagged Drupal sources are detected after decoding UTF-16', async t => {
  const p = project(t, { 'A.php': '<?php require __DIR__."/Feature.install";', 'Feature.install': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?php function feature() {}', 'utf16le')]), 'ignored.install': 'plain text without a PHP tag' });
  const r = await map('php', p);
  assert.equal(r.edges, 'from\tto\nA.php\tFeature.install\n'); assert.doesNotMatch(r.order, /ignored/);
});

for (const [lang, ext, a, b] of [
  ['csharp', 'cs', 'class A { B b; }', 'class B {}'],
  ['java', 'java', 'class A { B b; }', 'class B {}'],
  ['vbnet', 'vb', 'Public Class A\nPublic b As B\nEnd Class', 'Public Class B\nEnd Class'],
  ['php', 'php', '<?php class A { public B $b; }', '<?php class B {}'],
  ['cobol', 'cbl', "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. A.\n       PROCEDURE DIVISION.\n           CALL 'B'.\n", '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. B.\n'],
  ['c', 'h', '#include "B.h"\n', '/* B */']
]) test(`${lang}: UTF-16/UTF-32 sources retain dependencies; binary files remain explicit unresolved nodes`, async t => {
  const utf32 = Buffer.alloc(b.length * 4 + 4); utf32.writeUInt32LE(0xFEFF, 0);
  for (let i = 0; i < b.length; i++) utf32.writeUInt32LE(b.charCodeAt(i), i * 4 + 4);
  const p = project(t, { [`A.${ext}`]: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(a, 'utf16le')]), [`B.${ext}`]: utf32, [`Binary.${ext}`]: Buffer.from([1, 0, 2, 3, 4, 0, 5]) });
  const r = await map(lang, p);
  assert.match(r.edges, new RegExp(`A\\.${ext}\\tB\\.${ext}`));
  assert.match(unresolved(p), /Binary\..*\t\(whole file\)\t.*NUL/);
});

for (const lang of ['csharp', 'vbnet']) test(`${lang}: 1200 literal project imports and an import loop are expanded without recursion failure`, async t => {
  const isCS = lang === 'csharp', ext = isCS ? 'cs' : 'vb';
  const files = {
    [`A.${ext}`]: isCS ? 'class A { B b; }' : 'Public Class A\nPublic b As B\nEnd Class\n',
    [`B.${ext}`]: isCS ? 'namespace Library { class B {} }' : 'Namespace Library\nPublic Class B\nEnd Class\nEnd Namespace',
    [`P.${isCS ? 'csproj' : 'vbproj'}`]: '<Project Sdk="Microsoft.NET.Sdk">\n<Import Project="p0.props" />\n</Project>'
  };
  for (let i = 0; i < 1200; i++) files[`p${i}.props`] = '<Project>\n' + (i < 1199 ? `<Import Project="p${i + 1}.props" />` : `<Import Project="p0.props" />\n<PropertyGroup><RootNamespace></RootNamespace></PropertyGroup>\n<ItemGroup><${isCS ? 'Using' : 'Import'} Include="Library" /></ItemGroup>`) + '\n</Project>';
  const p = project(t, files), r = await map(lang, p);
  assert.equal(r.edges, `from\tto\nA.${ext}\tB.${ext}\n`); assert.doesNotMatch(r.stderr, /Traceback|RecursionError/);
});

for (const lang of ['csharp', 'vbnet']) test(`${lang}: project imports outside the chosen root do not change source membership`, async t => {
  const isCS = lang === 'csharp', ext = isCS ? 'cs' : 'vb';
  const p = project(t, { [`A.${ext}`]: isCS ? 'class A { B b; }' : 'Public Class A\nPublic b As B\nEnd Class', [`B.${ext}`]: isCS ? 'class B {}' : 'Public Class B\nEnd Class' });
  const outside = `${p.root}-external.props`; t.after(() => fs.rmSync(outside, { force: true }));
  fs.writeFileSync(outside, `<Project><ItemGroup><Compile Remove="B.${ext}" /></ItemGroup></Project>`);
  fs.writeFileSync(path.join(p.root, `P.${isCS ? 'csproj' : 'vbproj'}`), `<Project Sdk="Microsoft.NET.Sdk"><Import Project="../${path.basename(outside)}" /></Project>`);
  const r = await map(lang, p);
  assert.equal(r.edges, `from\tto\nA.${ext}\tB.${ext}\n`); assert.match(r.stderr, /outside --root not read/);
});

for (const build of ['Maven', 'Gradle']) test(`Java: ${build} project visibility resolves duplicate names only to the declared module`, async t => {
  const files = { 'app/A.java': 'package app; import common.B; class A { B value; }', 'lib/B.java': 'package common; public class B {}', 'unused/B.java': 'package common; public class B {}' };
  if (build === 'Maven') for (const module of ['app', 'lib', 'unused']) files[`${module}/pom.xml`] = `<project><groupId>g</groupId><artifactId>${module}</artifactId>${module === 'app' ? '<dependencies><dependency><groupId>g</groupId><artifactId>lib</artifactId></dependency></dependencies>' : ''}</project>`;
  else {
    files['settings.gradle'] = "include ':app', ':lib', ':unused'\n";
    for (const module of ['app', 'lib', 'unused']) files[`${module}/build.gradle`] = module === 'app' ? "dependencies { implementation project(':lib') }" : 'plugins { id "java" }';
  }
  const p = project(t, files), r = await map('java', p);
  assert.equal(r.edges, 'from\tto\napp/A.java\tlib/B.java\n');
});

test('C/C++ masks commented/raw-string includes, handles continuations and reports missing/macro includes', async t => {
  const p = project(t, { 'folder.h': null,
    'A.h': '/*\n#include "B.h"\n*/\nconst char *s=R"tag(\n#include "B.h"\n)tag";\n', 'B.h': '#include"A.h"\n',
    'main.c': '#include/**/\\\n"B.h"\n#include "missing.h"\n#include HEADER_MACRO\n// comment \\\n#include "not-real.h"\n'
  });
  const r = await map('c', p);
  assert.equal(r.edges, 'from\tto\nB.h\tA.h\nmain.c\tB.h\n');
  assert.doesNotMatch(r.order, /folder\.h/);
  assert.match(unresolved(p), /missing\.h/); assert.match(unresolved(p), /HEADER_MACRO/); assert.doesNotMatch(unresolved(p), /not-real/);
  assert.equal(fs.readFileSync(path.join(p.out, 'cycles.txt'), 'utf8'), '# strongly connected components > 1 file: 0\n');
});

test('JS/TS masks comments, strings, regex and template text; resolves emitted suffixes and template-expression imports', async t => {
  const p = project(t, {
    'A.ts': `import type { B } from /* note */ './B.js';\nconst note="import './Fake'";\nconst rx=/from ".\\/Fake"/;\nconst t=\`from "./Fake" \${import(/* bundler */ './C.mjs')}\`;\nconst nested=\`\${\`inside \${import('./D.cjs')}\`}\`;\nconst loader={require:(name:string)=>name};loader.require('./Fake');\nconst e=require('./E');\n`,
    'B.ts': 'export class B {}', 'C.mts': 'export const C=1;', 'D.cts': 'export const D=1;', 'E.js': 'module.exports={};', 'Fake.ts': 'export const Fake=1;'
  });
  const r = await map('ts', p);
  assert.equal(r.edges, 'from\tto\nA.ts\tB.ts\nA.ts\tC.mts\nA.ts\tD.cts\nA.ts\tE.js\n');
});

test('JS/TS reports missing relative modules and undecodable/binary files without hiding healthy edges', async t => {
  const p = project(t, { 'A.js': 'require("./B"); import "./missing";', 'B.js': '', 'bad.js': Buffer.from([0xff, 0xfe, 0xff]), 'nul.js': Buffer.from('a\0b') });
  const r = await map('ts', p);
  assert.match(r.edges, /A\.js\tB\.js/); assert.match(unresolved(p), /missing/);
  assert.match(unresolved(p), /bad\.js\t\(whole file\)/); assert.match(unresolved(p), /nul\.js\t\(whole file\)/);
});

test('JS/TS records computed imports instead of inventing edges from a literal string prefix', async t => {
  const p = project(t, { 'A.js': 'const name="B"; require("./"+name); import(name); import(`./${name}.js`); require("./B");', 'B.js': '', 'index.js': '' });
  const r = await map('ts', p);
  assert.equal(r.edges, 'from\tto\nA.js\tB.js\n');
  assert.match(unresolved(p), /computed or unsupported/); assert.match(unresolved(p), /import\(name\)/); assert.doesNotMatch(r.edges, /index\.js/);
});

test('JSX closing tags preserve subsequent same-line imports and only JSX expressions create dependencies', async t => {
  const p = project(t, {
    'A.tsx': `const x=<><div title="from './Fake.js'">from './Fake.js'{require('./Attr.js')}<span>{\`value \${import('./Value.js')}\`}</span></div></>; import './B.js'; require('./C.js');`,
    'Plain.js': `const x=<div></div>; import './B.js'; const y=a < /from '.\\/Fake.js'/; require('./C.js');`,
    'Type.ts': `const x=<T>"</T> from './Fake.js'"; import './B.js';`,
    'B.js': '', 'C.js': '', 'Attr.js': '', 'Value.js': '', 'Fake.js': ''
  });
  const r = await map('ts', p);
  assert.equal(r.edges, 'from\tto\nA.tsx\tAttr.js\nA.tsx\tB.js\nA.tsx\tC.js\nA.tsx\tValue.js\nPlain.js\tB.js\nPlain.js\tC.js\nType.ts\tB.js\n');
});

test('shared reader records permission errors against the original source path rather than aborting the whole mapper', async t => {
  const p = project(t, { 'A.cs': 'class A { B b; }', 'B.cs': 'class B {}', 'Bad.cs': 'class Bad {}' });
  const scriptDir = path.join(kitRoot, 'scripts');
  const body = `import sys, errno\nfrom pathlib import Path\nfrom unittest.mock import patch\nsys.path.insert(0, ${JSON.stringify(scriptDir)})\nimport depmap_common, depmap_csharp\noriginal = Path.read_bytes\ndef read(p):\n    if p.name == 'Bad.cs': raise PermissionError(errno.EACCES, 'Permission denied')\n    return original(p)\nsys.argv = ['probe', '--root', sys.argv[1], '--out', sys.argv[2]]\nwith patch.object(Path, 'read_bytes', read):\n    depmap_common.run('probe', depmap_csharp.mapper)\n`;
  const r = await runProcess(python, ['-I', '-c', body, p.root, p.out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(unresolved(p), /Bad\.cs\t\(whole file\)\t.*Permission denied/);
  assert.match(fs.readFileSync(path.join(p.out, 'edges.tsv'), 'utf8'), /A\.cs\tB\.cs/);
});

test('deep source directories and metadata discovery use iterative walks in Java and PHP', { skip: process.platform === 'win32' && 'deep paths depend on Windows long-path policy' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depmap-deep-dirs-')), dirs = [];
  let leaf = root;
  t.after(() => {
    for (const name of ['B.java', 'B.php']) if (fs.existsSync(path.join(leaf, name))) fs.unlinkSync(path.join(leaf, name));
    for (const dir of dirs.toReversed()) fs.rmdirSync(dir);
    fs.rmSync(root, { recursive: true, force: true });
    for (const lang of ['java', 'php']) fs.rmSync(`${root}-${lang}-out`, { recursive: true, force: true });
  });
  for (let i = 0; i < 1050; i++) { leaf = path.join(leaf, 'd'); fs.mkdirSync(leaf); dirs.push(leaf); }
  fs.writeFileSync(path.join(root, 'A.java'), 'class A { B value; }'); fs.writeFileSync(path.join(leaf, 'B.java'), 'class B {}');
  fs.writeFileSync(path.join(root, 'A.php'), '<?php class A { public B $value; }'); fs.writeFileSync(path.join(leaf, 'B.php'), '<?php class B {}');
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project><groupId>g</groupId><artifactId>a</artifactId></project>');
  fs.writeFileSync(path.join(root, 'composer.json'), '{}');
  for (const lang of ['java', 'php']) {
    const r = await map(lang, { root, out: `${root}-${lang}-out` });
    assert.match(r.edges, new RegExp(`A\\.${lang}\\t(?:d/){1050}B\\.${lang}`)); assert.doesNotMatch(r.stderr, /RecursionError|Traceback/);
  }
});

const sourceCases = [
  ['Python', 'py', 'from shared.B import B\n', 'class B: pass\n'],
  ['PHP', 'php', '<?php require __DIR__."/../shared/B.php"; new B;', '<?php class B {}'],
  ['C#', 'cs', 'using Library; class A { B b; }', 'namespace Library { class B {} }'],
  ['Java', 'java', 'package app; import shared.B; class A { B b; }', 'package shared; public class B {}'],
  ['VB.NET', 'vb', 'Imports Library\nPublic Class A\nPublic b As B\nEnd Class', 'Namespace Library\nPublic Class B\nEnd Class\nEnd Namespace'],
  ['COBOL', 'cbl', "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. A.\n       PROCEDURE DIVISION.\n           CALL 'B'.\n", '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. B.\n'],
  ['C/C++', 'h', '#include "../shared/B.h"\n', '/* B */'],
  ['TypeScript', 'ts', "import {B} from '../shared/B.js';\n", 'export class B {}']
];
for (const [language, ext, a, b] of sourceCases) test(`${language}: source-as-spec commands parse all spaced source roots and generate a usable manifest/dependency declaration`, async t => {
  const f = prepare(t); f.config.sourceLanguage = language;
  f.config.sourceRoots = ['legacy code/app', 'legacy code/shared'];
  atomicWrite(safePath(f.root, `legacy code/app/A.${ext}`), a);
  atomicWrite(safePath(f.root, `legacy code/shared/B.${ext}`), b);
  // A same-named declaration outside config.sourceRoots must not create a
  // false ambiguity, edge or migration unit when parsing their common parent.
  atomicWrite(safePath(f.root, `legacy code/unselected/B.${ext}`), b);
  if (language === 'Python') for (const root of f.config.sourceRoots) atomicWrite(safePath(f.root, `${root}/__init__.py`), '');
  const commands = sourceSpecReadiness(f.root, f.config).commands;
  for (const command of [commands.dependencyMap, commands.manifest.replace('.SOURCE_EXT=.TARGET_EXT', `.${ext}=.mjs`), commands.reviewDependencies]) {
    const r = await runProcess('bash', ['-c', command], { cwd: f.root });
    assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  }
  const units = readManifest(f.root, f.config);
  assert.ok(units.some(u => u.source === `legacy code/shared/B.${ext}` && u.target === 'ported/shared/B.mjs'));
  assert.ok(units.some(u => u.source === `legacy code/app/A.${ext}` && u.target === 'ported/app/A.mjs'));
  assert.ok(units.every(u => !u.source.includes('/unselected/')));
  assert.doesNotMatch(fs.readFileSync(safePath(f.root, 'migration/depmap/order.txt'), 'utf8'), /unselected/);
  assert.deepEqual(readJSON(safePath(f.root, 'migration/review-dependencies.json')).dependencies[`legacy code/app/A.${ext}`], [`legacy code/shared/B.${ext}`]);
});

test('prefix-only manifest mappings preserve repeated interior directory names and reject unmapped sources before replacing an existing manifest', async t => {
  const p = project(t, { 'order.txt': '# order\nsrc/sub/src/A.py\nshared/B.py\n', 'manifest.tsv': 'prior reviewed manifest\n' });
  const script = path.join(kitRoot, 'scripts/make_manifest.py'), common = [script, '--order', path.join(p.root, 'order.txt'), '--out', path.join(p.root, 'manifest.tsv')];
  const noMapping = await runProcess(python, [...common, '--map-root', 'src=ported/src', '--sub', '.py=.mjs']);
  assert.notEqual(noMapping.code, 0); assert.match(noMapping.stderr, /no --map-root mapping/);
  assert.equal(fs.readFileSync(path.join(p.root, 'manifest.tsv'), 'utf8'), 'prior reviewed manifest\n');
  const mapped = await runProcess(python, [...common, '--map-root', 'src=ported/src', '--map-root', 'shared=ported/shared', '--sub', '.py=.mjs']);
  assert.equal(mapped.code, 0, mapped.stderr);
  assert.equal(fs.readFileSync(path.join(p.root, 'manifest.tsv'), 'utf8'), 'source\ttarget\nsrc/sub/src/A.py\tported/src/sub/src/A.mjs\nshared/B.py\tported/shared/B.mjs\n');
});

test('all eight mappers produce identical map files across independent runs and Python hash seeds', async t => {
  for (const [language, ext, a, b] of sourceCases) {
    const lang = ({ Python: 'python', PHP: 'php', 'C#': 'csharp', Java: 'java', 'VB.NET': 'vbnet', COBOL: 'cobol', 'C/C++': 'c', TypeScript: 'ts' })[language];
    const p = project(t, { [`app/A.${ext}`]: a, [`shared/B.${ext}`]: b });
    const script = path.join(kitRoot, `scripts/depmap_${lang}.${lang === 'ts' ? 'mjs' : 'py'}`), snapshots = [];
    for (const seed of ['0', '1', '42']) {
      // Deliberately omit -I here: it ignores PYTHONHASHSEED.
      const r = await runProcess(lang === 'ts' ? process.execPath : python, [script, '--root', p.root, '--out', p.out], { env: { ...process.env, PYTHONHASHSEED: seed } });
      assert.equal(r.code, 0, r.stderr);
      snapshots.push(['edges.tsv', 'order.txt', 'cycles.txt', 'unresolved.tsv'].map(name => fs.readFileSync(path.join(p.out, name), 'utf8')));
    }
    assert.deepEqual(snapshots[0], snapshots[1], language); assert.deepEqual(snapshots[1], snapshots[2], language);
  }
});

test('all eight mappers reject a non-directory root without replacing prior output', async t => {
  for (const lang of ['python', 'php', 'csharp', 'java', 'vbnet', 'cobol', 'c', 'ts']) {
    const p = project(t, { 'not-a-directory': 'text' }); fs.mkdirSync(p.out); fs.writeFileSync(path.join(p.out, 'edges.tsv'), 'prior map\n');
    const r = await runProcess(lang === 'ts' ? process.execPath : python, [path.join(kitRoot, `scripts/depmap_${lang}.${lang === 'ts' ? 'mjs' : 'py'}`), '--root', path.join(p.root, 'not-a-directory'), '--out', p.out]);
    assert.notEqual(r.code, 0, lang); assert.match(r.stderr, /not a directory/);
    assert.equal(fs.readFileSync(path.join(p.out, 'edges.tsv'), 'utf8'), 'prior map\n');
  }
});

test('all eight mappers reject unsafe or missing source selections before replacing prior output', async t => {
  for (const lang of ['python', 'php', 'csharp', 'java', 'vbnet', 'cobol', 'c', 'ts']) {
    const p = project(t, {}); fs.mkdirSync(p.out); fs.writeFileSync(path.join(p.out, 'edges.tsv'), 'prior map\n');
    const script = path.join(kitRoot, `scripts/depmap_${lang}.${lang === 'ts' ? 'mjs' : 'py'}`);
    for (const dir of ['../outside', 'missing']) {
      const r = await runProcess(lang === 'ts' ? process.execPath : python, [script, '--root', p.root, '--out', p.out, '--source-root', dir]);
      assert.notEqual(r.code, 0, `${lang}: ${dir}`);
      assert.equal(fs.readFileSync(path.join(p.out, 'edges.tsv'), 'utf8'), 'prior map\n');
    }
  }
});

test('source-as-spec safely quotes apostrophes in source paths through the full command chain', { skip: process.platform === 'win32' && 'POSIX quoting case; Windows uses PowerShell quoting' }, async t => {
  const f = prepare(t); f.config.sourceLanguage = 'Python'; f.config.sourceRoots = ["legacy's src"];
  atomicWrite(safePath(f.root, "legacy's src/A.py"), 'import B\n'); atomicWrite(safePath(f.root, "legacy's src/B.py"), 'x=1\n');
  const commands = sourceSpecReadiness(f.root, f.config).commands;
  for (const command of [commands.dependencyMap, commands.manifest.replace('.SOURCE_EXT=.TARGET_EXT', '.py=.mjs'), commands.reviewDependencies]) {
    const r = await runProcess('bash', ['-c', command], { cwd: f.root }); assert.equal(r.code, 0, r.stderr);
  }
  assert.equal(readManifest(f.root, f.config).length, 2);
  assert.deepEqual(readJSON(safePath(f.root, 'migration/review-dependencies.json')).dependencies["legacy's src/A.py"], ["legacy's src/B.py"]);
});
