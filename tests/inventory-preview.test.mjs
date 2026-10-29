// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepare } from './helpers.mjs';
import { atomicWrite, safePath, fileHash, readJSON, writeJSON } from '../lib/core.mjs';
import { previewInventory, mergeInventory } from '../lib/preparation.mjs';
import { preparationCommand } from '../scripts/preparation_cli.mjs';
import { runProcess } from '../lib/process.mjs';

const header = 'file\tsymbol\tsource_construct\tclassification\ttarget_translation\tevidence\tstatus';
const row = 'src/math_ops.py\tdivide\tnegative division\tNUMERIC\tfloor division\tsrc/math_ops.py:4\tconfirmed';
function fixture(t) {
  const f = prepare(t);
  const options = { shards: ['migration/inventory-shards/a.tsv', 'migration/inventory-shards/b.tsv'], sites: 'migration/inventory-sites.tsv' };
  atomicWrite(safePath(f.root, options.sites), 'file\tsymbol\tsource_construct\nsrc/math_ops.py\tdivide\tnegative division\n');
  atomicWrite(safePath(f.root, options.shards[0]), `\uFEFF# shared note\r\n# a note\r\n\r\n${header}\r\n${row}\r\n`);
  atomicWrite(safePath(f.root, options.shards[1]), `${header}\n${row}\n# shared note\n# z note\n`);
  atomicWrite(safePath(f.root, 'migration/inventory-merge.json'), '{"prior":"receipt must survive preview"}\n');
  return { ...f, options };
}
const official = f => ['migration/inventory.tsv', 'migration/inventory-merge.json'].map(p => fileHash(safePath(f.root, p)));

test('inventory preview preserves notes and exact merge bytes without changing the official inventory or receipt', t => {
  const f = fixture(t), before = official(f);
  const preview = previewInventory(f.root, f.config, f.options);
  assert.equal(preview.kind, 'inventory-preview'); assert.equal(preview.uniqueSites, 1);
  assert.deepEqual(official(f), before);
  assert.equal(fileHash(safePath(f.root, preview.out)), preview.outputHash);
  assert.equal(fs.readFileSync(safePath(f.root, preview.out), 'utf8'), `# a note\n# shared note\n# z note\n${header}\n${row}\n`);
  const reversed = previewInventory(f.root, f.config, { ...f.options, shards: f.options.shards.toReversed() });
  assert.equal(reversed.outputHash, preview.outputHash);
  const merged = mergeInventory(f.root, f.config, { ...f.options, expectedHash: preview.outputHash });
  assert.equal(merged.outputHash, preview.outputHash); assert.equal(merged.reviewedCandidateHash, preview.outputHash);
  assert.equal(fileHash(safePath(f.root, 'migration/inventory.tsv')), preview.outputHash);
});

test('a failed candidate validation preserves the old candidate, source shards and official records', t => {
  const f = fixture(t), preview = previewInventory(f.root, f.config, f.options), before = official(f);
  for (const [text, pattern] of [
    [`${header}\n${row.replace('floor division', 'truncate division')}\n`, /Conflicting/],
    [`${header}\nsrc/math_ops.py\tdivide\n`, /Partial or malformed/],
    [`file\tsymbol\n`, /Unexpected TSV header/],
    [`${header}\n${row.replace('confirmed', 'pending')}\n`, /confirmed or unknown/],
    [`${header}\n${row.replace('NUMERIC', 'UNKNOWN').replace('confirmed', 'unknown')}\n`, /TODO\(port\)/]
  ]) {
    atomicWrite(safePath(f.root, f.options.shards[1]), text);
    const shardHash = fileHash(safePath(f.root, f.options.shards[1]));
    assert.throws(() => previewInventory(f.root, f.config, f.options), pattern);
    assert.equal(fileHash(safePath(f.root, preview.out)), preview.outputHash);
    assert.deepEqual(official(f), before);
    assert.equal(fileHash(safePath(f.root, f.options.shards[1])), shardHash);
  }
  for (const shard of f.options.shards) atomicWrite(safePath(f.root, shard), `${header}\n`);
  assert.throws(() => previewInventory(f.root, f.config, f.options), /Incomplete inventory shards: 1 census sites missing/);
  assert.equal(fileHash(safePath(f.root, preview.out)), preview.outputHash);
  assert.deepEqual(official(f), before);
  atomicWrite(safePath(f.root, f.options.shards[0]), `${header}\n${row}\n`);
  atomicWrite(safePath(f.root, f.options.sites), 'file\tsymbol\tsource_construct\nsrc/math_ops.py\tmissing\tcall\n');
  assert.throws(() => previewInventory(f.root, f.config, f.options), /outside census/);
  assert.deepEqual(official(f), before);
});

test('a reviewed hash rejects changed valid shard answers before formal publication', t => {
  const f = fixture(t), preview = previewInventory(f.root, f.config, f.options), before = official(f);
  for (const shard of f.options.shards) atomicWrite(safePath(f.root, shard), `${header}\n${row.replace('floor division', 'revised translation')}\n`);
  assert.throws(() => mergeInventory(f.root, f.config, { ...f.options, expectedHash: preview.outputHash }), /differs from reviewed candidate/);
  assert.deepEqual(official(f), before);
  assert.throws(() => mergeInventory(f.root, f.config, { ...f.options, expectedHash: 'not-a-hash' }), /lowercase SHA-256/);
  assert.deepEqual(official(f), before);
});

test('inventory writers reject output collisions with the census, shards, formal receipts and file aliases', t => {
  const f = fixture(t), before = official(f);
  for (const out of [f.options.sites, f.options.shards[0], 'migration/inventory.tsv', 'migration/inventory-merge.json', 'src/math_ops.py', 'migration/inventory-shards/unselected.tsv', 'migration/surveys/contracts/001-src.json']) {
    const old = fileHash(safePath(f.root, out));
    assert.throws(() => previewInventory(f.root, f.config, { ...f.options, out }), /protected|Reports must be under/);
    assert.equal(fileHash(safePath(f.root, out)), old);
  }
  for (const [i, input] of [f.options.sites, f.options.shards[0], 'migration/inventory-merge.json'].entries()) {
    const out = `migration/alias-${i}.tsv`;
    fs.linkSync(safePath(f.root, input), safePath(f.root, out));
    const old = fileHash(safePath(f.root, input));
    assert.throws(() => previewInventory(f.root, f.config, { ...f.options, out }), /protected/);
    assert.equal(fileHash(safePath(f.root, input)), old);
  }
  assert.deepEqual(official(f), before);
  for (const kind of ['receipt-path', 'receipt-alias', 'inventory-path', 'inventory-alias']) {
    const g = fixture(t), output = kind.startsWith('receipt') ? 'migration/inventory-merge.json' : 'migration/inventory.tsv';
    if (kind.endsWith('alias')) {
      fs.rmSync(safePath(g.root, output));
      fs.linkSync(safePath(g.root, g.options.sites), safePath(g.root, output));
    } else {
      fs.copyFileSync(safePath(g.root, g.options.sites), safePath(g.root, output));
      g.options.sites = output;
    }
    const old = official(g), censusHash = fileHash(safePath(g.root, g.options.sites));
    assert.throws(() => mergeInventory(g.root, g.config, g.options), /protected input/);
    assert.deepEqual(official(g), old); assert.equal(fileHash(safePath(g.root, g.options.sites)), censusHash);
  }
});

test('a preview is allowed before phase approval but cannot authorize or publish the formal merge', t => {
  const f = fixture(t), before = official(f); f.config.phasePolicy = 'strict';
  const preview = previewInventory(f.root, f.config, f.options);
  assert.equal(preview.uniqueSites, 1);
  assert.throws(() => mergeInventory(f.root, f.config, { ...f.options, expectedHash: preview.outputHash }), /Phase .*not reviewed/);
  assert.deepEqual(official(f), before);
  assert.equal(fs.existsSync(safePath(f.root, 'migration/phases/01.json')), false);
});

test('all 628 census sites survive preview and hash-bound merge, including notes, unknowns and retried shards', t => {
  const f = prepare(t), sites = 'migration/sites.tsv', shards = [], census = [], rows = [];
  for (let i = 0; i < 628; i++) {
    const key = `src/math_ops.py\tsymbol-${i}\tnullable`;
    census.push(key);
    rows.push(`${key}\t${i % 10 ? 'VALUE\tnumber' : 'UNKNOWN\tPreserve value; TODO(port): check nullable contract'}\tsrc/math_ops.py:4\t${i % 10 ? 'confirmed' : 'unknown'}`);
  }
  atomicWrite(safePath(f.root, sites), 'file\tsymbol\tsource_construct\n' + census.join('\n') + '\n');
  for (let at = 0; at < rows.length; at += 40) {
    const shard = `migration/inventory-shards/part-${at}.tsv`; shards.push(shard);
    atomicWrite(safePath(f.root, shard), '# global note\n' + header + '\n' + rows.slice(at, at + 40).join('\n') + '\n');
  }
  const retry = 'migration/inventory-shards/retry.tsv';
  fs.copyFileSync(safePath(f.root, shards[0]), safePath(f.root, retry)); shards.push(retry);
  const before = official(f), preview = previewInventory(f.root, f.config, { sites, shards });
  assert.equal(preview.uniqueSites, 628); assert.equal(preview.unknown, 63); assert.deepEqual(official(f), before);
  const merged = mergeInventory(f.root, f.config, { sites, shards, expectedHash: preview.outputHash });
  assert.equal(merged.uniqueSites, 628); assert.equal(merged.outputHash, preview.outputHash);
  assert.equal(new Set(fs.readFileSync(safePath(f.root, 'migration/inventory.tsv'), 'utf8').trimEnd().split('\n').slice(2).map(l => l.split('\t').slice(0, 3).join('\t'))).size, 628);
});

test('the installed preparation CLI produces a preview and accepts its reviewed hash for the formal merge', async t => {
  const f = fixture(t), cli = safePath(f.root, 'migration-kit/scripts/preparation_cli.mjs');
  const options = ['--sites', f.options.sites, '--shards', f.options.shards.join(',')], before = official(f);
  const r = await runProcess(process.execPath, [cli, 'inventory-preview', ...options], { cwd: f.root });
  assert.equal(r.code, 0, r.stderr);
  const preview = JSON.parse(r.stdout); assert.equal(preview.kind, 'inventory-preview'); assert.deepEqual(official(f), before);
  const m = await runProcess(process.execPath, [cli, 'inventory-merge', ...options, '--expected-hash', preview.outputHash], { cwd: f.root });
  assert.equal(m.code, 0, m.stderr); assert.equal(JSON.parse(m.stdout).outputHash, preview.outputHash);
  assert.equal(readJSON(safePath(f.root, 'migration/inventory-merge.json')).reviewedCandidateHash, preview.outputHash);
  const direct = preparationCommand(f.root, f.config, 'inventory-preview', { sites: f.options.sites, shards: f.options.shards.join(','), out: 'migration/other-candidate.tsv' });
  assert.equal(direct.outputHash, preview.outputHash);
});
