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
export function autoModeOn(root) {
  return read(path.join(root, 'migration/preferences.json'))?.phaseMode === 'auto' && Boolean(autoModeRecord(root));
}
