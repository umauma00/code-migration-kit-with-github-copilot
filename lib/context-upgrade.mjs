// SPDX-License-Identifier: Apache-2.0
// Until 0.44.x every record (a finished unit, an approval, a run, a record of
// phase 02 or later, a pilot grant, a repair intent or queue) held one hash
// of everything the kit read, the models and every command included, and
// phase 00b's judge fingerprint held the files every command names. 0.45.0
// binds each record to what its work depends on (lib/core.mjs, lib/judge.mjs).
// The first command of this kit that does work in a project writes down what
// the old hashes stand for at that moment, before anything it does can change
// the settings (migration/state/context-upgrade.json). An old record made for
// the inputs of that moment then holds for as long as what it depends on
// stays as it was, also after the models, a command or the tests change; one
// already out of date then stays out of date. So does one made before a copy
// update replaced the kit's .github/agents, when a record of phase 02 or
// later shows that nothing else changed (legacyEntries). Each part is written
// once: one that cannot be read yet (no manifest, no tests folder, a
// verificationInputs file missing) is written by the first command that can
// read it, from the configuration record as it was when this kit first did
// work here (kept as config until then), so a setting changed meanwhile (a
// model, say) does not change what the old records stand for.
import { safePath, writeJSON, readMemo, readConfigFile, scopeHashes, legacyEntries, readContextUpgrade, contextUpgradeFile, lockRun, stamp } from './core.mjs';
import { judgeInputHash, legacyJudgeInputHash } from './judge.mjs';

// Never throws: a part that cannot be read now waits for a later command. The
// caller has not changed the settings or any input yet in this command.
export function recordContextUpgrade(root) {
  const known = readContextUpgrade(root);
  if (known?.contexts && known?.judgeInput) return null;
  let record;
  try { record = readConfigFile(root); } catch { return null; }
  let release;
  try { release = lockRun(root, 'context-upgrade'); } catch { return null; }
  try {
    // Read again under the lock: another command may have written it meanwhile.
    const now = readContextUpgrade(root), next = { schemaVersion: 1, at: now?.at ?? stamp(), ...(now?.contexts ? { contexts: now.contexts } : {}), ...(now?.judgeInput ? { judgeInput: now.judgeInput } : {}) };
    // The record of the first command, while a part waits; the hashes of
    // both formulas are read from it, with the files as they are now.
    const config = isRecord(now?.config) ? now.config : record;
    const added = [];
    // One read for both formulas of each part, so they describe the same files.
    const memo = readMemo();
    if (!next.contexts) try {
      next.contexts = legacyEntries(root, config, memo, scopeHashes(root, config, memo, config), config);
      added.push('contexts');
    } catch {}
    if (!next.judgeInput) try {
      next.judgeInput = { legacy: legacyJudgeInputHash(root, config, memo), current: judgeInputHash(root, config, memo) };
      added.push('judgeInput');
    } catch {}
    const waiting = ['contexts', 'judgeInput'].filter(k => !next[k]);
    if (waiting.length) next.config = config;
    const wrote = added.length > 0 || (waiting.length > 0 && !isRecord(now?.config));
    if (wrote) writeJSON(safePath(root, contextUpgradeFile), next);
    return wrote ? { file: contextUpgradeFile, added, ...(waiting.length ? { waiting } : {}) } : null;
  } catch { return null; }
  finally { release(); }
}
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && value.schemaVersion === 1;
