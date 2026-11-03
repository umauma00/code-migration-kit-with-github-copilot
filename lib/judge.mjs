// SPDX-License-Identifier: Apache-2.0
import { hash, safePath, fileHash, treeHash, verificationFiles, readJSON, sourceOnlyPlan, requiredInputRoots, missingRootMessage, readMemo, memoFileHash, readContextUpgrade, judgeCommandKeys } from './core.mjs';
import fs from 'node:fs';

// Judge correctness does not depend on an as-yet-unwritten rulebook or map.
// memo: a readMemo shared with the other reads of one check (requirePilot).
// Schema 3 (0.45.0): of the commands, only the judge's (original, mutation,
// parity) and the files they name are inputs, so a build, smoke or
// typecheck script keeps phase 00b; a source-only project runs none of them,
// so there none is. Schema 2 (0.40.1 to 0.44.x) had every command's files;
// 0.40.1 took the kit's own files out.
export const judgeInputSchema = 3;
export const judgeCommands = judgeCommandKeys;
export function judgeInputHash(root, config, memo = readMemo()) {
  return judgeInput(root, config, memo, judgeCommands);
}
// The schema 2 fingerprint, as 0.43.1 computed it.
export function legacyJudgeInputHash(root, config, memo = readMemo()) {
  return judgeInput(root, config, memo, undefined);
}
function judgeInput(root, config, memo, commands) {
  for (const p of requiredInputRoots(config)) if (!fs.existsSync(safePath(root, p))) throw new Error(missingRootMessage(config, p, 'Judge input root missing'));
  // Schema 2 is kept as it was computed (commands undefined: every command's files).
  const keys = commands && (config.verificationMode ?? 'runtime') === 'source-only' ? [] : judgeCommands;
  return hash(JSON.stringify({ schemaVersion: 1, sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage,
    mode: config.mode, verificationMode: config.verificationMode ?? 'runtime', sourceRoots: config.sourceRoots,
    verificationRoots: config.verificationRoots, commands: Object.fromEntries(keys.map(k => [k, config.commands?.[k] ?? null])),
    source: treeHash(root, config.sourceRoots, memo), judge: treeHash(root, config.verificationRoots, memo),
    inputs: verificationFiles(root, config, { commands: commands && keys }).map(p => [p, memoFileHash(safePath(root, p, memo), memo)]),
    // 0.40.1: the kit's own files are not an input (as in the context since
    // 0.40.0), so a kit update keeps phase 00b and the phases after it.
    ...(config.verificationMode === 'source-only' ? { plan: sourceOnlyPlan(root, config, memo).files } : {}) }));
}
// Whether a recorded judge fingerprint is current. current: judgeInputHash
// of this read. A schema 2 fingerprint counts for what it stood for when
// this kit first did work in the project (context-upgrade.json), or, before
// that, when it is the schema 2 fingerprint of now (of the configuration
// record that first command kept, when it could not read the inputs then).
// Older ones never count.
export function sameJudgeInput(root, config, recorded, schema, current, memo) {
  if (typeof recorded !== 'string') return false;
  if (schema === judgeInputSchema) return recorded === current;
  if (schema !== 2) return false;
  const upgrade = readContextUpgrade(root);
  if (upgrade?.judgeInput) return recorded === upgrade.judgeInput.legacy && upgrade.judgeInput.current === current;
  const first = upgrade?.config && typeof upgrade.config === 'object' && !Array.isArray(upgrade.config) ? upgrade.config : null;
  try { return first ? recorded === legacyJudgeInputHash(root, first, memo) && judgeInputHash(root, first, memo) === current : recorded === legacyJudgeInputHash(root, config, memo); } catch { return false; }
}
export function currentJudgePreparation(root, config) {
  const file = safePath(root, 'migration/results/judge-preparation.json');
  if (!fileHash(file)) return false;
  let record;
  try { record = readJSON(file); } catch (e) { if (e instanceof SyntaxError) return false; throw e; }
  const expected = config.verificationMode === 'source-only' ? [] : ['original', 'mutation'];
  if (!(record.schemaVersion === 1 && record.stage === 'judge-preparation' && record.success && record.executionId && record.finishedAt &&
    record.verificationMode === (config.verificationMode ?? 'runtime') && Array.isArray(record.commands) && record.commands.length === expected.length &&
    record.commands.every((c, i) => c.name === expected[i] && c.status === 'success' && c.code === 0))) return false;
  // A record of 0.44.x and earlier carries no schema: schema 2.
  const memo = readMemo();
  return sameJudgeInput(root, config, record.inputHash, record.inputSchema ?? 2, judgeInputHash(root, config, memo), memo) ? record : false;
}
