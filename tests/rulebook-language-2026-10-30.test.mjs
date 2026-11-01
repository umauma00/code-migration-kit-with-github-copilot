// SPDX-License-Identifier: Apache-2.0
// A person who chose 日本語 got an English RULEBOOK: the report language
// covered user-facing text only, and the rulebook template was English. With
// ja the installer now starts from the Japanese template, which keeps every
// marker and tag the runner and workers rely on, and phase 02 still refuses it
// untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare } from './helpers.mjs';
import { safePath, loadConfig } from '../lib/core.mjs';
import { sourceSpecReadiness } from '../lib/source-spec.mjs';
import { setPreferences } from '../lib/preferences.mjs';
import { phaseCommand } from '../scripts/phase_cli.mjs';
import { install } from '../scripts/install.mjs';

const kitRoot = path.join(import.meta.dirname, '..');
const template = name => fs.readFileSync(path.join(kitRoot, 'templates', name), 'utf8');
const rulebook = root => fs.readFileSync(path.join(root, 'migration/RULEBOOK.md'), 'utf8');

test('the installer starts the RULEBOOK in the chosen language for both layouts', t => {
  for (const layout of ['repository', 'plugin']) {
    const fresh = language => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `rulebook-${layout}-`));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      install(root, { apply: true, layout, ...(language ? { language } : {}) });
      return root;
    };
    assert.equal(rulebook(fresh('ja')), template('RULEBOOK.ja.md'), layout);
    assert.equal(rulebook(fresh('en')), template('RULEBOOK.md'), layout);
    assert.equal(rulebook(fresh()), template('RULEBOOK.md'), layout);
    // A recorded choice is kept by the installer, so the RULEBOOK follows it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `rulebook-recorded-${layout}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'migration'));
    setPreferences(root, { language: 'ja' });
    install(root, { apply: true, layout, language: 'en' });
    assert.equal(rulebook(root), template('RULEBOOK.ja.md'), layout);
    // Recorded English wins over --language ja; an unreadable or unset record
    // falls back to the option.
    for (const [recorded, option, expected] of [['{"schemaVersion":1,"userLanguage":"en"}', 'ja', 'RULEBOOK.md'],
      ['not json', 'ja', 'RULEBOOK.ja.md'], ['{"schemaVersion":1,"userLanguage":null}', 'ja', 'RULEBOOK.ja.md']]) {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), `rulebook-fallback-${layout}-`));
      t.after(() => fs.rmSync(other, { recursive: true, force: true }));
      fs.mkdirSync(path.join(other, 'migration'));
      fs.writeFileSync(path.join(other, 'migration/preferences.json'), recorded);
      install(other, { apply: true, layout, language: option });
      assert.equal(rulebook(other), template(expected), `${layout} ${recorded}`);
    }
    // A RULEBOOK that exists is never replaced.
    fs.writeFileSync(path.join(root, 'migration/RULEBOOK.md'), '# Rules\nFloor division.\n');
    const again = install(root, { apply: true, layout, language: 'ja' });
    assert.ok(!again.changes.includes('migration/RULEBOOK.md'), layout);
    assert.equal(rulebook(root), '# Rules\nFloor division.\n');
  }
});

test('the Japanese template keeps the sections, markers and tags of the English one', () => {
  const en = template('RULEBOOK.md'), ja = template('RULEBOOK.ja.md');
  const sections = text => text.match(/^## \d+\./gm);
  assert.deepEqual(sections(ja), sections(en));
  assert.match(ja, /[぀-ゟ]/);
  for (const literal of ['[source language]', '[target language]', 'TODO(port):', 'PERF(port):', 'BUG(port):', '// SAFETY:',
    '// PORT STATUS: confidence=medium todos=2', 'DEV-001', '`allocation-guard`', '`precondition-guard`',
    '`todo-lines-v1`', 'migration/inventory.tsv', 'templates/inventory.tsv', 'docs/EXECUTION-SCOPES.md', '<!-- Copilot adaptation:'])
    assert.ok(en.includes(literal) && ja.includes(literal), literal);
});

test('phase 02 refuses the untouched Japanese template', t => {
  const f = prepare(t);
  fs.writeFileSync(safePath(f.root, 'migration/gap-report.md'), '# Gaps\nReviewed.\n');
  fs.copyFileSync(path.join(kitRoot, 'templates/RULEBOOK.ja.md'), safePath(f.root, 'migration/RULEBOOK.md'));
  assert.throws(() => phaseCommand(f.root, f.config, 'check', '02'), /RULEBOOK\.md is still the installed template/);
  const status = sourceSpecReadiness(f.root, loadConfig(f.root)).items.find(i => i.path === 'migration/RULEBOOK.md').status;
  assert.equal(status, 'template');
});

test('the orchestrator instructions put the RULEBOOK prose in the report language', () => {
  for (const rel of ['skills/code-migration/SKILL.md', '.github/skills/code-migration/SKILL.md']) {
    const text = fs.readFileSync(path.join(kitRoot, rel), 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /migration\/RULEBOOK\.md \(its prose;/, rel);
    assert.match(text, /installer starts the RULEBOOK from the Japanese template/, rel);
    assert.match(text, /Never translate a RULEBOOK that already holds rules/, rel);
  }
  for (const rel of ['.github/agents/migration-orchestrator.agent.md', 'com.github.copilot/agents/code-migration-plugin-orchestrator.agent.md'])
    assert.match(fs.readFileSync(path.join(kitRoot, rel), 'utf8'), /including the RULEBOOK's prose/, rel);
});
