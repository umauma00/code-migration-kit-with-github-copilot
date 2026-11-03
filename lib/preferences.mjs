// SPDX-License-Identifier: Apache-2.0
// User-facing presentation choices. Kept out of the configuration record on
// purpose: records are bound to settings of that record (the content, and the
// inputs of each run), so changing the report language must never touch
// approvals or completion receipts. The person sets them in
// migration/settings.json (or answers a setup question); this is the kit's
// record of them, beside the configuration record. Until 0.44.x it was
// migration/preferences.json; the next command that does work moves it here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renameRetry } from './text.mjs';
import { safePath, readJSON, writeJSON, readMovedJSON } from './core.mjs';

export const preferencesFile = 'migration/state/preferences.json';
export const legacyPreferencesFile = 'migration/preferences.json';
// Where the record is written: its place, or the old one while it is still there.
export const preferencesFileOf = root => !fs.existsSync(safePath(root, preferencesFile)) && fs.existsSync(safePath(root, legacyPreferencesFile)) ? legacyPreferencesFile : preferencesFile;
export const userLanguages = ['ja', 'en'];
// Whether the original implementation can still run here. Presentation only:
// it decides which choice failure guidance recommends, never what is approved.
export const originalRuntimes = ['available', 'unavailable'];
// Whether a specification or portable test suite exists, asked at setup only
// when the original cannot run: unavailable means the source is the only
// specification, and setup switches to source-as-spec before phase 00.
export const specifications = ['available', 'unavailable'];
// How phase prerequisites are enforced. normal stops until they are met;
// relaxed warns, asks the person, and lets them proceed past an unfinished
// phase with a recorded waiver (phase waive). auto is relaxed without the
// person: gate commands run unasked (Copilot CLI autopilot can drive it) and
// every record it makes is marked auto. Kept here, not in the configuration
// record, so switching never revokes approvals or completion receipts.
export const phaseModes = ['normal', 'relaxed', 'auto'];
// Written when auto mode is chosen: the upstream sign-off gates (rule 3) are
// not followed from then on, and status shows since when.
import { autoModeFile, autoModeRecord, autoModeOn } from './auto-mode.mjs';
export { autoModeFile };

// A record left while auto is not chosen (a hand edit of the mode, or an
// interrupted switch) is retired, so editing the mode back never revives it.
function retireAutoRecord(root, { strict = true } = {}) {
  if (!fs.existsSync(safePath(root, autoModeFile))) return;
  // Reading never fails on it (another reader retired it first, a read-only
  // checkout); setPreferences retires strictly before saving another mode.
  if (!strict) { try { retireAutoRecord(root); } catch {} return; }
  const retired = safePath(root, `migration/phases/retired/auto-mode-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`);
  fs.mkdirSync(path.dirname(retired), { recursive: true });
  renameRetry(safePath(root, autoModeFile), retired);
}

export function readPreferences(root) {
  // Read wherever it is, also while the next command moves it from the old
  // place: a record missing in both is what retires the auto-mode record.
  const found = readMovedJSON(root, preferencesFile, legacyPreferencesFile);
  if (!found) { retireAutoRecord(root, { strict: false }); return { schemaVersion: 1, userLanguage: null }; }
  const { name, value } = found;
  if (value?.schemaVersion !== 1 || (value.userLanguage !== null && !userLanguages.includes(value.userLanguage))) throw new Error(`${name} must have schemaVersion 1 and userLanguage ja or en`);
  if (value.originalRuntime !== undefined && value.originalRuntime !== null && !originalRuntimes.includes(value.originalRuntime)) throw new Error(`${name}: originalRuntime must be available or unavailable`);
  if (value.specification !== undefined && value.specification !== null && !specifications.includes(value.specification)) throw new Error(`${name}: specification must be available or unavailable`);
  if (value.phaseMode !== undefined && value.phaseMode !== null && !phaseModes.includes(value.phaseMode)) throw new Error(`${name}: phaseMode must be normal, relaxed or auto`);
  if (value.phaseMode !== 'auto') retireAutoRecord(root, { strict: false });
  return value;
}

export function setPreferences(root, { language, originalRuntime, phaseMode, specification } = {}) {
  if (language === undefined && originalRuntime === undefined && phaseMode === undefined && specification === undefined) throw new Error('Set --language ja|en, --original-runtime available|unavailable, --phase-mode normal|relaxed|auto and/or --specification available|unavailable');
  if (specification !== undefined && !specifications.includes(specification)) throw new Error('specification must be available or unavailable');
  if (language !== undefined && !userLanguages.includes(language)) throw new Error('language must be ja or en');
  if (originalRuntime !== undefined && !originalRuntimes.includes(originalRuntime)) throw new Error('original-runtime must be available or unavailable');
  if (phaseMode !== undefined && !phaseModes.includes(phaseMode)) throw new Error('phase-mode must be normal, relaxed or auto');
  const old = readPreferences(root);
  const value = { ...old, schemaVersion: 1, ...(language !== undefined ? { userLanguage: language } : {}), ...(originalRuntime !== undefined ? { originalRuntime } : {}), ...(phaseMode !== undefined ? { phaseMode } : {}), ...(specification !== undefined ? { specification } : {}) };
  value.userLanguage ??= null;
  // Leaving auto retires the record first, so a later hand edit back to auto
  // has none; a failure here leaves auto recorded but still chosen, never the
  // reverse.
  if (value.phaseMode !== 'auto') retireAutoRecord(root);
  const target = preferencesFileOf(root);
  writeJSON(safePath(root, target), value);
  // Another command moved the record into its place meanwhile (this command
  // does not hold the run lock): the value just written goes there too.
  if (target === legacyPreferencesFile && fs.existsSync(safePath(root, preferencesFile))) renameRetry(safePath(root, legacyPreferencesFile), safePath(root, preferencesFile));
  // Entering auto writes the record last: a failure in between leaves auto
  // chosen without its record, which is not in effect.
  if (phaseMode === 'auto' && (old.phaseMode !== 'auto' || !autoModeRecord(root))) writeJSON(safePath(root, autoModeFile), { schemaVersion: 1, enabledAt: new Date().toISOString(),
    deviation: 'Auto mode: phase completions, approvals and waivers are recorded without the person (upstream rule 3, sign-off gates end the workflow, is not followed). Every such record is marked auto: true.' });
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
    .filter(([, rel]) => read(rel)?.auto === true).map(([name]) => name)
    .concat((read('migration/phases/rulebook-amendments.json')?.log ?? []).some(e => e?.auto === true) ? ['rulebook accept'] : [])
    .filter((name, i, all) => all.indexOf(name) === i);
  // Sections auto mode accepted without telling which finished files they touch.
  const unresolved = (read('migration/phases/rulebook-amendments.json')?.log ?? []).filter(e => e?.auto === true && Array.isArray(e.unresolved) && e.unresolved.length)
    .map(e => ({ at: e.at, sections: e.unresolved.filter(s => typeof s === 'string') }));
  let recorded = null;
  try { recorded = readMovedJSON(root, preferencesFile, legacyPreferencesFile)?.value ?? null; } catch {}
  const chosen = recorded?.phaseMode === 'auto', mode = autoModeOn(root) ? autoModeRecord(root) : null;
  if (!records.length && !chosen) return null;
  // Chosen without its record (a hand edit): not in effect, and said so.
  return { active: Boolean(mode), ...(chosen && !mode ? { unrecorded: true } : {}), ...(mode?.enabledAt ? { enabledAt: mode.enabledAt, deviation: mode.deviation } : {}), records, ...(unresolved.length ? { rulebookUnchecked: unresolved } : {}) };
}

// Tells the parent what to do when the choice is still missing.
export function preferencesReport(root) {
  const value = readPreferences(root);
  return { ...value, ...(value.userLanguage ? {} : { action: 'Ask the user to choose 日本語 (ja) or English (en) with the question tool, then run: preferences --language ja|en' }) };
}
