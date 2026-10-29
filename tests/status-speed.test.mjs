// SPDX-License-Identifier: Apache-2.0
// 0.23.0: phase next / status took minutes on Windows for a mid-sized C#
// project. contextHash re-checked every parent directory of every review
// dependency edge and walked each manifest unit's dependency closure from the
// start. One read now shares a path memo and walks the graph once; the checks
// and the hash itself are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare } from './helpers.mjs';
import { safePath, pathMemo, contextHash, reviewSources, reachableSources, writeJSON, atomicWrite } from '../lib/core.mjs';

test('a path memo keeps every symlink and parent check of safePath', t => {
  const { root } = prepare(t);
  fs.mkdirSync(path.join(root, 'src/deep/dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/deep/dir/a.py'), 'x = 1\n');
  const memo = pathMemo();
  assert.equal(safePath(root, 'src/deep/dir/a.py', memo), safePath(root, 'src/deep/dir/a.py'));
  // The last component is checked again even when its parents are memoized.
  try { fs.symlinkSync(path.join(root, 'src/deep/dir/a.py'), path.join(root, 'src/deep/dir/link.py')); } catch { t.skip('symlinks unavailable'); return; }
  assert.throws(() => safePath(root, 'src/deep/dir/link.py', memo), /Symlinks are not supported/);
  // A linked parent directory is refused the first time the memo meets it.
  fs.symlinkSync(path.join(root, 'src/deep'), path.join(root, 'src/alias'));
  assert.throws(() => safePath(root, 'src/alias/dir/a.py', memo), /Symlinks are not supported/);
  assert.throws(() => safePath(root, 'src/deep/dir/a.py/x', memo), /Parent is not a directory/);
  assert.throws(() => safePath(root, '../escape', memo), /normalized repository-relative path/);
});

test('one walk over all manifest sources finds what each unit closure finds', () => {
  const graph = { a: ['b'], b: ['c'], c: [], d: ['a'], e: [] };
  assert.deepEqual(reachableSources(graph, ['a', 'd']), ['a', 'b', 'c', 'd']);
  assert.deepEqual(reviewSources(null, null, 'd', graph), ['a', 'b', 'c', 'd']);
  // The same missing declaration is still reported.
  assert.throws(() => reachableSources({ a: ['b'] }, ['a']), /Review dependency declaration missing: b/);
  assert.throws(() => reachableSources({ a: [], x: ['y'] }, ['a', 'x']), /declaration missing: y/);
});

function wideProject(t, files = 120, fanIn = 60) {
  const { root, config } = prepare(t);
  const names = [];
  for (let i = 0; i < files; i++) {
    const name = `src/pkg/sub${i % 6}/m${i}.py`;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), `v${i} = ${i}\n`);
    names.push(name);
  }
  const dependencies = { 'src/math_ops.py': [], 'src/text_ops.py': [], 'src/main.py': ['src/math_ops.py', 'src/text_ops.py'] };
  names.forEach((name, i) => { dependencies[name] = names.slice(Math.max(0, i - fanIn), i); });
  writeJSON(safePath(root, 'migration/review-dependencies.json'), { schemaVersion: 1, dependencies });
  atomicWrite(safePath(root, 'migration/manifest.tsv'), 'source\ttarget\n' + names.map(n => `${n}\tported/${n.slice(4, -3)}.mjs\n`).join(''));
  return { root, config, names };
}

test('contextHash checks each parent directory once per read, not once per edge', t => {
  const { root, config, names } = wideProject(t);
  const counts = { lstatSync: 0, existsSync: 0, statSync: 0, realpathSync: 0 };
  const originals = Object.fromEntries(Object.keys(counts).map(k => [k, fs[k]]));
  const first = contextHash(root, config);
  try {
    for (const k of Object.keys(counts)) {
      const original = originals[k];
      fs[k] = function (...args) { counts[k]++; return original.apply(this, args); };
      if (k === 'realpathSync') fs[k].native = original.native;
    }
    assert.equal(contextHash(root, config), first, 'the hash is stable');
  } finally { Object.assign(fs, originals); }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // 120 units x 60 dependencies = 7,200 edges. Checking each edge's path from
  // the root again cost well over 100,000 calls here; per-file work stays.
  assert.ok(total < names.length * 120, `${total} file system calls for ${names.length} units`);
});

test('contextHash still notices a changed dependency, a missing declaration and a linked source', t => {
  const { root, config, names } = wideProject(t, 20, 5);
  const before = contextHash(root, config);
  fs.appendFileSync(path.join(root, names[3]), '# changed\n');
  assert.notEqual(contextHash(root, config), before);
  const map = JSON.parse(fs.readFileSync(path.join(root, 'migration/review-dependencies.json'), 'utf8'));
  delete map.dependencies[names[0]];
  writeJSON(safePath(root, 'migration/review-dependencies.json'), map);
  assert.throws(() => contextHash(root, config), new RegExp(`declaration missing: ${names[0]}`));
  map.dependencies[names[0]] = [];
  writeJSON(safePath(root, 'migration/review-dependencies.json'), map);
  fs.rmSync(path.join(root, names[1]));
  try { fs.symlinkSync(path.join(root, names[2]), path.join(root, names[1])); } catch { t.skip('symlinks unavailable'); return; }
  assert.throws(() => contextHash(root, config), /Symlinks are not supported/);
});
