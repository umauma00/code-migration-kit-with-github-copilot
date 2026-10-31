import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { install, kitRoot } from '../scripts/install.mjs';

// 0.18.0: development records live in history/ and never reach a migration project.
test('a copy install leaves out the kit development records', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { changes } = install(root);
  assert.ok(changes.includes('migration-kit/docs/OPERATING-MANUAL.md'));
  assert.ok(changes.includes('.github/skills/code-migration/SKILL.md'));
  assert.deepEqual(changes.filter(rel => /(?:^|\/)(?:history|skill)\/|docs\/(?:reviews|validation|plans)\/|REVIEW-FIXES/.test(rel)), []);
});

test('copied documents link to the records in the kit repository', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  install(root, { apply: true, model: 'test-double' });
  const testing = fs.readFileSync(path.join(root, 'migration-kit/docs/TESTING.md'), 'utf8');
  assert.match(testing, /\]\(https:\/\/github\.com\/[^)]+\/blob\/HEAD\/history\/validation\/automated-tests\.tap\)/);
  for (const rel of ['migration-kit/README.md', 'migration-kit/README.en.md', 'migration-kit/CHANGELOG.md', 'migration-kit/docs/TESTING.md', 'migration-kit/docs/TESTING.en.md', 'migration-kit/docs/UPGRADING.md', 'migration-kit/docs/UPGRADING.en.md']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(text, /\]\((?!https?:)[^)]*history\//, rel);
  }
});

test('each skill has one copy per install layout and no stray skill folder', () => {
  assert.equal(fs.existsSync(path.join(kitRoot, 'skill')), false);
  for (const dir of ['docs/reviews', 'docs/validation', 'docs/plans']) assert.equal(fs.existsSync(path.join(kitRoot, dir)), false, dir);
  const names = dir => fs.readdirSync(path.join(kitRoot, dir)).sort();
  assert.deepEqual(names('skills'), names('.github/skills'));
});

// 0.36.0: the Claude Code settings file was never read by the kit or Copilot; it is gone
// from the kit and from what a copy install writes.
test('no Claude Code settings reference is kept or installed', t => {
  assert.equal(fs.existsSync(path.join(kitRoot, 'templates/claude-settings.reference.json')), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { changes } = install(root);
  assert.deepEqual(changes.filter(rel => /claude-settings/.test(rel)), []);
  const readme = fs.readFileSync(path.join(kitRoot, 'templates/settings.README.md'), 'utf8');
  assert.doesNotMatch(readme, /claude-settings\.reference\.json/);
});
