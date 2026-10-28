// SPDX-License-Identifier: Apache-2.0
// Whether auto phase mode is in effect. Dependency-free so the hook can read it.
// It needs both the preference and its deviation record, which only the runner
// writes when the person chooses auto (and retires when they leave it), so a
// hand edit of migration/preferences.json never turns it on.
import fs from 'node:fs';
import path from 'node:path';

export const autoModeFile = 'migration/phases/auto-mode.json';
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
export function autoModeRecord(root) {
  const value = read(path.join(root, autoModeFile));
  return value?.schemaVersion === 1 && typeof value.enabledAt === 'string' ? value : null;
}
// The same checks as readPreferences (lib/preferences.mjs): an invalid
// preferences file is never auto mode, for the hook, the runner and status alike.
const validPreferences = p => p?.schemaVersion === 1 && [null, 'ja', 'en'].includes(p.userLanguage)
  && [undefined, null, 'available', 'unavailable'].includes(p.originalRuntime) && [undefined, null, 'normal', 'relaxed', 'auto'].includes(p.phaseMode)
  && [undefined, null, 'available', 'unavailable'].includes(p.specification);
export function autoModeOn(root) {
  const preferences = read(path.join(root, 'migration/preferences.json'));
  return validPreferences(preferences) && preferences.phaseMode === 'auto' && Boolean(autoModeRecord(root));
}
