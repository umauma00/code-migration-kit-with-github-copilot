// SPDX-License-Identifier: Apache-2.0
// User-facing presentation choices. Kept out of migration/config.json on
// purpose: contextHash covers config, so changing the report language must not
// revoke approvals or completion receipts.
import fs from 'node:fs';
import { safePath, readJSON, writeJSON } from './core.mjs';

export const preferencesFile = 'migration/preferences.json';
export const userLanguages = ['ja', 'en'];
// Whether the original implementation can still run here. Presentation only:
// it decides which choice failure guidance recommends, never what is approved.
export const originalRuntimes = ['available', 'unavailable'];

export function readPreferences(root) {
  const file = safePath(root, preferencesFile);
  if (!fs.existsSync(file)) return { schemaVersion: 1, userLanguage: null };
  const value = readJSON(file);
  if (value?.schemaVersion !== 1 || (value.userLanguage !== null && !userLanguages.includes(value.userLanguage))) throw new Error(`${preferencesFile} must have schemaVersion 1 and userLanguage ja or en`);
  if (value.originalRuntime !== undefined && value.originalRuntime !== null && !originalRuntimes.includes(value.originalRuntime)) throw new Error(`${preferencesFile}: originalRuntime must be available or unavailable`);
  return value;
}

export function setPreferences(root, { language, originalRuntime } = {}) {
  if (language === undefined && originalRuntime === undefined) throw new Error('Set --language ja|en and/or --original-runtime available|unavailable');
  if (language !== undefined && !userLanguages.includes(language)) throw new Error('language must be ja or en');
  if (originalRuntime !== undefined && !originalRuntimes.includes(originalRuntime)) throw new Error('original-runtime must be available or unavailable');
  const value = { ...readPreferences(root), schemaVersion: 1, ...(language !== undefined ? { userLanguage: language } : {}), ...(originalRuntime !== undefined ? { originalRuntime } : {}) };
  value.userLanguage ??= null;
  writeJSON(safePath(root, preferencesFile), value);
  return value;
}

// Tells the parent what to do when the choice is still missing.
export function preferencesReport(root) {
  const value = readPreferences(root);
  return { ...value, ...(value.userLanguage ? {} : { action: 'Ask the user to choose 日本語 (ja) or English (en) with the question tool, then run: preferences --language ja|en' }) };
}
