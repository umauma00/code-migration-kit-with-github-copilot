import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare } from './helpers.mjs';
import { safePath, writeJSON, readJSON } from '../lib/core.mjs';
import { approve, runStage, translate } from '../lib/pipeline.mjs';
import { diagnosticsForUnits, diagnosticTsv, parseBuildOutput } from '../lib/diagnostics.mjs';
import { diagnoseBuild } from '../scripts/diagnostic_queue.mjs';
import { fake } from './helpers.mjs';

// Python, Node, bash and clang samples were captured from real tools (Python
// 3, Node 26, bash, Apple clang). javac, Maven, ShellCheck, tsc, ESLint,
// pyright, mypy and rustc samples follow their documented output formats.
const samples = root => ({
  python: `  File "ported/pkg/bad.py", line 1\n    def f(:\n          ^\nSyntaxError: invalid syntax\n`,
  compileall: `*** Error compiling 'ported/pkg/bad.py'...\n  File "ported/pkg/bad.py", line 1\n    def f(:\n          ^\nSyntaxError: invalid syntax\n`,
  traceback: `Traceback (most recent call last):\n  File "${root}/ported/pkg/run.py", line 3, in <module>\n    g()\n  File "${root}/ported/pkg/run.py", line 2, in g\n    return 1/0\nZeroDivisionError: division by zero\n`,
  mypy: `ported/pkg/run.py:2: error: Unsupported operand types for / ("int" and "str")  [operator]\nFound 1 error in 1 file (checked 2 source files)\n`,
  pyright: `${root}/ported/pkg/run.py\n  ${root}/ported/pkg/run.py:2:10 - error: Operator "/" not supported (reportOperatorIssue)\n1 error, 0 warnings, 0 informations\n`,
  javac: `ported/app/Main.java:5: error: cannot find symbol\n        return helper(x);\n               ^\n  symbol:   method helper(int)\n  location: class Main\n1 error\n`,
  maven: `[INFO] Compiling 2 source files\n[ERROR] ${root}/ported/app/Main.java:[5,16] cannot find symbol\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin\n`,
  nodeCheck: `${root}/ported/bad.mjs:1\nexport const x = ;\n                 ^\n\nSyntaxError: Unexpected token ';'\n    at checkSyntax (node:internal/main/check_syntax:84:5)\n\nNode.js v26.11.1\n`,
  nodeRuntime: `file://${root}/ported/rt.mjs:1\nexport function f() { return undefinedFn(); }\n                      ^\n\nReferenceError: undefinedFn is not defined\n    at f (file://${root}/ported/rt.mjs:1:23)\n    at ModuleJob.run (node:internal/modules/esm/module_job:569:25)\n`,
  eslint: `${root}/ported/rt.mjs:1:30: 'undefinedFn' is not defined. [Error/no-undef]\n${root}/ported/rt.mjs:2:1: Unexpected console statement. [Warning/no-console]\n`,
  tsc: `ported/rt.mjs(1,30): error TS2304: Cannot find name 'undefinedFn'.\n`,
  bash: `ported/bad.sh: line 1: syntax error near unexpected token \`then'\nported/bad.sh: line 1: \`if then'\n`,
  shellcheckGcc: `ported/bad.sh:3:6: warning: Double quote to prevent globbing and word splitting. [SC2086]\n`,
  shellcheckTty: `\nIn ported/bad.sh line 1:\nif then\n   ^--^ SC1048 (error): Can't have empty then clauses (use 'true' as a no-op).\n`,
  clang: `ported/bad.c:1:20: error: use of undeclared identifier 'y'\n    1 | int main(){ return y; }\n      |                    ^\n1 error generated.\n`,
  rust: `error[E0425]: cannot find value \`y\` in this scope\n --> ported/lib.rs:3:5\n  |\n3 |     y\n  |     ^ not found in this scope\n`
});

const units = ['ported/pkg/bad.py', 'ported/pkg/run.py', 'ported/app/Main.java', 'ported/bad.mjs', 'ported/rt.mjs', 'ported/bad.sh', 'ported/bad.c', 'ported/lib.rs']
  .map(target => ({ source: target.replace('ported/', 'src/'), target }));

test('bundled parsers map real and documented compiler output to manifest targets', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = {
    python: ['ported/pkg/bad.py', 'SyntaxError', 'line 1: invalid syntax'],
    compileall: ['ported/pkg/bad.py', 'SyntaxError', 'line 1: invalid syntax'],
    traceback: ['ported/pkg/run.py', 'ZeroDivisionError', 'line 2: division by zero'],
    mypy: ['ported/pkg/run.py', 'operator', 'line 2: Unsupported operand types for / ("int" and "str")'],
    pyright: ['ported/pkg/run.py', 'reportOperatorIssue', 'line 2: Operator "/" not supported'],
    javac: ['ported/app/Main.java', 'error', 'line 5: cannot find symbol; symbol: method helper(int); location: class Main'],
    maven: ['ported/app/Main.java', 'javac', 'line 5: cannot find symbol'],
    nodeCheck: ['ported/bad.mjs', 'SyntaxError', "line 1: Unexpected token ';'"],
    nodeRuntime: ['ported/rt.mjs', 'ReferenceError', 'line 1: undefinedFn is not defined'],
    eslint: ['ported/rt.mjs', 'no-undef', "line 1: 'undefinedFn' is not defined."],
    tsc: ['ported/rt.mjs', 'TS2304', "line 1: Cannot find name 'undefinedFn'."],
    bash: ['ported/bad.sh', 'bash', 'line 1: syntax error near unexpected token `then\''],
    shellcheckGcc: ['ported/bad.sh', 'SC2086', 'line 3: Double quote to prevent globbing and word splitting.'],
    shellcheckTty: ['ported/bad.sh', 'SC1048', "line 1: Can't have empty then clauses (use 'true' as a no-op)."],
    clang: ['ported/bad.c', 'error', "line 1: use of undeclared identifier 'y'"],
    rust: ['ported/lib.rs', 'E0425', 'line 3: cannot find value `y` in this scope']
  };
  for (const [name, text] of Object.entries(samples(root))) {
    const { rows } = diagnosticsForUnits(root, units, text);
    assert.deepEqual(rows.map(r => [r.file, r.code, r.message]), [expected[name]], name);
    assert.equal(rows[0].module, path.posix.dirname(expected[name][0]), name);
  }
});

test('diagnostics keep errors over warnings, report unmapped paths and resolve unique suffixes', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const text = 'pkg/run.py:2: error: bad call  [arg-type]\nvendor/x.c:1:1: error: outside\nported/bad.sh:3:6: warning: quote [SC2086]\n';
  const { rows, unmapped } = diagnosticsForUnits(root, units, text);
  assert.deepEqual(rows.map(r => r.file), ['ported/pkg/run.py']);
  assert.deepEqual(unmapped, ['vendor/x.c:1: outside']);
  assert.match(diagnosticTsv(rows), /^file\tmodule\tcode\tmessage\nported\/pkg\/run\.py\tported\/pkg\targ-type\tline 2: bad call\n$/);
  assert.equal(parseBuildOutput('All good\n').length, 0);
});

test('diagnose turns a failed recorded build into a repair queue and round log; repair completes it', async t => {
const f = prepare(t, { count: 3 });
  f.config.commands.build = [process.execPath, '-e', 'console.error("ported/math_ops.mjs:3:5: error: boom\\nvendor/lib.c:1:1: error: not ours"); process.exit(1)'];
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture translation');
  await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Fixture build');
  await assert.rejects(runStage(f.root, f.config, 'build'), /build failed/);
  const diagnosis = diagnoseBuild(f.root, f.config);
  assert.equal(diagnosis.clean, false); assert.deepEqual(diagnosis.targets, ['ported/math_ops.mjs']);
  assert.equal(diagnosis.unmappedCount, 1); assert.equal(diagnosis.round, 1);
  assert.equal(readJSON(safePath(f.root, diagnosis.queue)).jobs.length, 1);
  assert.equal(diagnoseBuild(f.root, f.config).round, 1, 'the same build is logged once');
  const repaired = await translate(f.root, f.config, fake, { repairQueue: diagnosis.queue });
  assert.equal(repaired.done, 3);
  const rounds = fs.readFileSync(safePath(f.root, 'migration/build-rounds.tsv'), 'utf8').trim().split('\n');
  assert.equal(rounds[0], 'round\tbuild_execution\tfinished_at\tsuccess\tdiagnostics\ttargets\tunmapped');
  assert.deepEqual(rounds[1].split('\t').slice(3), ['false', '1', '1', '1']);
});

test('diagnose refuses to guess when a failed build maps to no manifest target', async t => {
const f = prepare(t);
  f.config.commands.build = [process.execPath, '-e', 'console.error("linker: undefined reference"); process.exit(1)'];
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  await runStage(f.root, f.config, 'judge'); approve(f.root, f.config, 'translation', 'Fixture translation');
  await translate(f.root, f.config, fake);
  approve(f.root, f.config, 'build', 'Fixture build');
  await assert.rejects(runStage(f.root, f.config, 'build'), /build failed/);
  assert.throws(() => diagnoseBuild(f.root, f.config), /no diagnostic maps to a manifest target/);
});

test('Node diagnostics keep Windows paths that contain spaces', () => {
  const text = ['C:\\Users\\Taro Yamada\\proj\\ported\\a.mjs:3', '  bad(', '  ^', 'SyntaxError: Unexpected token', '',
    'TypeError: x is not a function', '    at main (C:\\Users\\Taro Yamada\\proj\\ported\\b.mjs:7:3)', '    at node:internal/x:1:1', '',
    'Error: boom', '    at file:///C:/Users/Taro%20Yamada/proj/ported/c.mjs:2:9', '', 'RangeError: r', '    at Object.<anonymous> (ported\\d.cjs:4:1)'].join('\r\n');
  assert.deepEqual(parseBuildOutput(text).map(d => [d.file, d.line, d.code]), [
    ['C:\\Users\\Taro Yamada\\proj\\ported\\a.mjs', '3', 'SyntaxError'], ['C:\\Users\\Taro Yamada\\proj\\ported\\b.mjs', '7', 'TypeError'],
    ['file:///C:/Users/Taro%20Yamada/proj/ported/c.mjs', '2', 'Error'], ['ported\\d.cjs', '4', 'RangeError']]);
});
