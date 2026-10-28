// SPDX-License-Identifier: Apache-2.0
// User-facing presentation choices. Kept out of migration/config.json on
// purpose: contextHash covers config, so changing the report language must not
// revoke approvals or completion receipts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renameRetry } from './text.mjs';
import { safePath, readJSON, writeJSON } from './core.mjs';

export const preferencesFile = 'migration/preferences.json';
export const userLanguages = ['ja', 'en'];
// Whether the original implementation can still run here. Presentation only:
// it decides which choice failure guidance recommends, never what is approved.
export const originalRuntimes = ['available', 'unavailable'];
// How phase prerequisites are enforced. normal stops until they are met;
// relaxed warns, asks the person, and lets them proceed past an unfinished
// phase with a recorded waiver (phase waive). auto is relaxed without the
// person: gate commands run unasked (Copilot CLI autopilot can drive it) and
// every record it makes is marked auto. Kept here, not in config.json,
// so switching never revokes approvals or completion receipts.
export const phaseModes = ['normal', 'relaxed', 'auto'];
// Written when auto mode is chosen: the upstream sign-off gates (rule 3) are
// not followed from then on, and status shows since when.
import { autoModeFile, autoModeRecord, autoModeOn } from './auto-mode.mjs';
export { autoModeFile };

export function readPreferences(root) {
  const file = safePath(root, preferencesFile);
  if (!fs.existsSync(file)) return { schemaVersion: 1, userLanguage: null };
  const value = readJSON(file);
  if (value?.schemaVersion !== 1 || (value.userLanguage !== null && !userLanguages.includes(value.userLanguage))) throw new Error(`${preferencesFile} must have schemaVersion 1 and userLanguage ja or en`);
  if (value.originalRuntime !== undefined && value.originalRuntime !== null && !originalRuntimes.includes(value.originalRuntime)) throw new Error(`${preferencesFile}: originalRuntime must be available or unavailable`);
  if (value.phaseMode !== undefined && value.phaseMode !== null && !phaseModes.includes(value.phaseMode)) throw new Error(`${preferencesFile}: phaseMode must be normal, relaxed or auto`);
  return value;
}

export function setPreferences(root, { language, originalRuntime, phaseMode } = {}) {
  if (language === undefined && originalRuntime === undefined && phaseMode === undefined) throw new Error('Set --language ja|en, --original-runtime available|unavailable and/or --phase-mode normal|relaxed|auto');
  if (language !== undefined && !userLanguages.includes(language)) throw new Error('language must be ja or en');
  if (originalRuntime !== undefined && !originalRuntimes.includes(originalRuntime)) throw new Error('original-runtime must be available or unavailable');
  if (phaseMode !== undefined && !phaseModes.includes(phaseMode)) throw new Error('phase-mode must be normal, relaxed or auto');
  const old = readPreferences(root);
  const value = { ...old, schemaVersion: 1, ...(language !== undefined ? { userLanguage: language } : {}), ...(originalRuntime !== undefined ? { originalRuntime } : {}), ...(phaseMode !== undefined ? { phaseMode } : {}) };
  value.userLanguage ??= null;
  // The deviation record comes first: auto mode is in effect only with it.
  if (phaseMode === 'auto' && (old.phaseMode !== 'auto' || !autoModeRecord(root))) writeJSON(safePath(root, autoModeFile), { schemaVersion: 1, enabledAt: new Date().toISOString(),
    deviation: 'Auto mode: phase completions, approvals and waivers are recorded without the person (upstream rule 3, sign-off gates end the workflow, is not followed). Every such record is marked auto: true.' });
  // Leaving auto retires the record first, so a later hand edit back to auto
  // has none; a failure here leaves auto recorded but still chosen, never the
  // reverse.
  if (phaseMode !== undefined && phaseMode !== 'auto' && fs.existsSync(safePath(root, autoModeFile))) {
    const retired = safePath(root, `migration/phases/retired/auto-mode-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`);
    fs.mkdirSync(path.dirname(retired), { recursive: true });
    renameRetry(safePath(root, autoModeFile), retired);
  }
  writeJSON(safePath(root, preferencesFile), value);
  return value;
}

// What auto mode recorded without the person: phase receipts and approval
// gates marked auto, shown by status in every mode until they are redone
// (a later completion or approval by the person replaces the file).
export function autoModeReport(root) {
  const read = rel => { try { return readJSON(safePath(root, rel)); } catch { return null; } };
  const listed = dir => { try { return fs.readdirSync(safePath(root, dir)).filter(f => f.endsWith('.json')).sort(); } catch { return []; } };
  const records = [...listed('migration/phases').filter(f => f !== 'auto-mode.json').map(f => [`phase ${f.slice(0, -5)}`, `migration/phases/${f}`]),
    ...listed('migration/gates').map(f => [f.startsWith('build-loop-') ? 'build-loop' : `approve ${f.slice(0, -5)}`, `migration/gates/${f}`]),
    ...listed('migration/phases/waivers').map(f => [`waive ${f.slice(0, -5)}`, `migration/phases/waivers/${f}`])]
    .filter(([, rel]) => read(rel)?.auto === true).map(([name]) => name).filter((name, i, all) => all.indexOf(name) === i);
  const chosen = read(preferencesFile)?.phaseMode === 'auto', mode = autoModeOn(root) ? autoModeRecord(root) : null;
  if (!records.length && !chosen) return null;
  // Chosen without its record (a hand edit): not in effect, and said so.
  return { active: Boolean(mode), ...(chosen && !mode ? { unrecorded: true } : {}), ...(mode?.enabledAt ? { enabledAt: mode.enabledAt, deviation: mode.deviation } : {}), records };
}

// Tells the parent what to do when the choice is still missing.
export function preferencesReport(root) {
  const value = readPreferences(root);
  return { ...value, ...(value.userLanguage ? {} : { action: 'Ask the user to choose 日本語 (ja) or English (en) with the question tool, then run: preferences --language ja|en' }) };
}
