import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ready, fake } from './helpers.mjs';
import { safePath, contextHash, done, readJSON } from '../lib/core.mjs';
import { translate } from '../lib/pipeline.mjs';
import { readPreferences, setPreferences, preferencesReport } from '../lib/preferences.mjs';
import { migrationStatus, statusMarkdown } from '../lib/status.mjs';
import { install } from '../scripts/install.mjs';

test('report language is chosen once, kept outside config, and never revokes receipts', async t => {
  const f = await ready(t);
  await translate(f.root, f.config, fake);
  assert.match(preferencesReport(f.root).action, /Ask the user/);
  const before = contextHash(f.root, f.config);
  setPreferences(f.root, { language: 'ja' });
  assert.equal(readPreferences(f.root).userLanguage, 'ja');
  assert.equal(preferencesReport(f.root).action, undefined);
  assert.equal(contextHash(f.root, f.config), before);
  assert.equal(done(f.root, f.units[0], before), true);
  assert.throws(() => setPreferences(f.root, { language: 'fr' }), /ja or en/);
  const report = migrationStatus(f.root);
  assert.match(statusMarkdown(report, 'ja'), /^検証方式: /); assert.match(statusMarkdown(report, 'ja'), /レビュー済み単位: 1\/1/);
  assert.match(statusMarkdown(report), /^Verification: /);
});

test('installer records the chosen language for both layouts without overwriting a choice', t => {
  for (const layout of ['repository', 'plugin']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `language-${layout}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.throws(() => install(root, { layout, language: 'de' }), /ja or en/);
    install(root, { apply: true, layout, language: 'en' });
    assert.equal(readJSON(path.join(root, 'migration/preferences.json')).userLanguage, 'en');
    setPreferences(root, { language: 'ja' });
    const again = install(root, { apply: true, layout, language: 'en' });
    assert.ok(!again.changes.includes('migration/preferences.json'));
    assert.equal(readJSON(path.join(root, 'migration/preferences.json')).userLanguage, 'ja');
  }
});
