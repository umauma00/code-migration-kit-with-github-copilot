import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, kitRoot } from '../scripts/install.mjs';
import { loadConfig } from '../lib/core.mjs';

const read = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');
const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-input-default-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('new installs default maxReviewInputBytes to 1 MiB in both layouts and the value validates', t => {
  assert.equal(JSON.parse(read('templates/migration-config.json')).maxReviewInputBytes, 1048576);
  for (const layout of ['repository', 'plugin']) {
    const root = temp(t);
    install(root, { apply: true, model: 'test-double', layout });
    assert.equal(loadConfig(root).maxReviewInputBytes, 1048576, layout);
  }
});

test('an existing config keeps its maxReviewInputBytes on reinstall', t => {
  const root = temp(t);
  install(root, { apply: true, model: 'test-double' });
  const file = path.join(root, 'migration/config.json'), config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.maxReviewInputBytes = 262144;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  install(root, { apply: true, model: 'test-double' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).maxReviewInputBytes, 262144);
});

test('documents state the 1 MiB default and no longer call 262144 the new-install default', () => {
  for (const rel of ['README.md', 'README.en.md', 'docs/INTERRUPTION-POLICY.md', 'docs/INTERRUPTION-POLICY.en.md']) {
    const text = read(rel);
    assert.match(text, /1048576/, rel);
    assert.doesNotMatch(text, /262144/, rel);
  }
});
