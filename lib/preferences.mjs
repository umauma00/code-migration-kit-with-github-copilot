// SPDX-License-Identifier: Apache-2.0
// User-facing presentation choices. Kept out of migration/config.json on
// purpose: contextHash covers config, so changing the report language must not
// revoke approvals or completion receipts.
import fs from 'node:fs';
import { safePath, readJSON, writeJSON } from './core.mjs';

export const preferencesFile = 'migration/preferences.json';
export const userLanguages = ['ja', 'en'];

export function readPreferences(root) {
  const file = safePath(root, preferencesFile);
  if (!fs.existsSync(file)) return { schemaVersion: 1, userLanguage: null };
  const value = readJSON(file);
  if (value?.schemaVersion !== 1 || (value.userLanguage !== null && !userLanguages.includes(value.userLanguage))) throw new Error(`${preferencesFile} must have schemaVersion 1 and userLanguage ja or en`);
  return value;
}

export function setPreferences(root, { language } = {}) {
  if (!userLanguages.includes(language)) throw new Error('language must be ja or en');
  const value = { ...readPreferences(root), schemaVersion: 1, userLanguage: language };
  writeJSON(safePath(root, preferencesFile), value);
  return value;
}

// Tells the parent what to do when the choice is still missing.
export function preferencesReport(root) {
  const value = readPreferences(root);
  return { ...value, ...(value.userLanguage ? {} : { action: 'Ask the user to choose 日本語 (ja) or English (en) with the question tool, then run: preferences --language ja|en' }) };
}
