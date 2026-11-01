// SPDX-License-Identifier: Apache-2.0
// 0.40.1: 0.40.0 took the kit's own files out of contextHash, but the judge
// input fingerprint of phase 00b still hashed the kit's lib, scripts and
// templates. A kit update then made 00b stale, 00b to 03 went stale in a
// chain, and rulebook accept was refused because phase 02 stayed out of date.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepare } from './helpers.mjs';
import { safePath, atomicWrite, writeJSON, readJSON, contextHash } from '../lib/core.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { judgeInputHash } from '../lib/judge.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Phases 00 to 02 recorded in strict order.
function recorded(t, layout) {
  const f = prepare(t, { count: 3, layout });
  f.config.phasePolicy = 'strict';
  writeJSON(safePath(f.root, 'migration/config.json'), f.config);
  for (const name of ['migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md']) atomicWrite(safePath(f.root, name), 'Synthetic preparation evidence; not actual AI review or human approval.\n');
  for (const id of ['00', '00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Test fixture reviewed preparation only' });
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '03');
  return f;
}

test('a plugin update keeps phase 00b and the phases after it', async t => {
  const f = recorded(t, 'plugin');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-plugin-update-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const dir of ['lib', 'scripts', 'prompts', 'docs', 'templates', 'skills', 'com.github.copilot']) fs.cpSync(path.join(kitRoot, dir), path.join(copy, dir), { recursive: true });
  for (const file of ['plugin.json', 'package.json']) fs.copyFileSync(path.join(kitRoot, file), path.join(copy, file));
  const judge = await import(pathToFileURL(path.join(copy, 'lib/judge.mjs')).href);
  const phases = await import(pathToFileURL(path.join(copy, 'scripts/phase_cli.mjs')).href);
  const before = { judge: judge.judgeInputHash(f.root, f.config), context: contextHash(f.root, f.config) };
  assert.equal(before.judge, judgeInputHash(f.root, f.config), 'the plugin location is not an input');
  for (const rel of ['lib/markers.mjs', 'scripts/run_migration.mjs', 'templates/RULEBOOK.md']) fs.appendFileSync(path.join(copy, rel), '\n// updated\n');
  assert.equal(judge.judgeInputHash(f.root, f.config), before.judge);
  const next = phases.phaseCommand(f.root, f.config, 'next');
  assert.equal(next.next, '03', 'no phase went stale');
  assert.equal(next.stale, undefined);
});

test('a copy-install update keeps phase 00b and the phases after it', t => {
  const f = recorded(t, 'repository');
  const before = judgeInputHash(f.root, f.config);
  const kit = safePath(f.root, 'migration-kit');
  for (const rel of ['lib/marker.mjs', 'scripts/new.mjs', 'templates/new.md']) {
    fs.mkdirSync(path.dirname(path.join(kit, rel)), { recursive: true });
    fs.writeFileSync(path.join(kit, rel), '// updated kit file\n');
  }
  assert.equal(judgeInputHash(f.root, f.config), before);
  const next = phaseCommand(f.root, f.config, 'next');
  assert.equal(next.next, '03');
  assert.equal(next.stale, undefined);
});

test('a real judge input still makes 00b stale', t => {
  const f = recorded(t, 'repository');
  const before = judgeInputHash(f.root, f.config);
  fs.appendFileSync(safePath(f.root, 'tests/judge.py'), '# changed\n');
  assert.notEqual(judgeInputHash(f.root, f.config), before);
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '00b');
});

test('updating from 0.40.0: the 00b record is checked and recorded again, not redone, and nothing else is lost', t => {
  const f = recorded(t, 'repository');
  // A 0.40.0 record: the old formula (with the kit) and no schema marker.
  const file = safePath(f.root, 'migration/phases/00b.json'), r = readJSON(file);
  delete r.judgeInputSchema; r.judgeInputHash = 'f'.repeat(64); writeJSON(file, r);
  const before = contextHash(f.root, f.config);
  const next = phaseCommand(f.root, f.config, 'next');
  assert.equal(next.next, '00b');
  assert.equal(next.stale.action, 'record-again');
  assert.deepEqual(next.stale.reasons.map(x => x.kind), ['judge-format']);
  assert.match(next.stale.next, /made before kit 0\.40\.1.*phase check 00b must pass.*phase complete 00b --note TEXT, then phases 01, 02 in order; finished units and approvals are kept/s);
  // Recording again in order brings the workflow back; the input fingerprint never moved.
  for (const id of ['00b', '01', '02']) phaseCommand(f.root, f.config, 'complete', id, { note: 'Re-recorded after the 0.40.1 update' });
  assert.equal(phaseCommand(f.root, f.config, 'next').next, '03');
  assert.equal(readJSON(file).judgeInputSchema, 2);
  assert.equal(contextHash(f.root, f.config), before);
});
