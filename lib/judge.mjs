// SPDX-License-Identifier: Apache-2.0
import { hash, safePath, fileHash, treeHash, verificationFiles, readJSON, sourceOnlyPlan, requiredInputRoots, missingRootMessage, readMemo, memoFileHash } from './core.mjs';
import fs from 'node:fs';

// Judge correctness does not depend on an as-yet-unwritten rulebook or map.
// memo: a readMemo shared with the other reads of one check (requirePilot).
export function judgeInputHash(root, config, memo = readMemo()) {
  for (const p of requiredInputRoots(config)) if (!fs.existsSync(safePath(root, p))) throw new Error(missingRootMessage(config, p, 'Judge input root missing'));
  return hash(JSON.stringify({ schemaVersion: 1, sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage,
    mode: config.mode, verificationMode: config.verificationMode ?? 'runtime', sourceRoots: config.sourceRoots,
    verificationRoots: config.verificationRoots, commands: Object.fromEntries(['original', 'mutation', 'parity'].map(k => [k, config.commands?.[k] ?? null])),
    source: treeHash(root, config.sourceRoots, memo), judge: treeHash(root, config.verificationRoots, memo),
    inputs: verificationFiles(root, config).map(p => [p, memoFileHash(safePath(root, p, memo), memo)]),
    // 0.40.1: the kit's own files are not an input (as in contextHash since
    // 0.40.0), so a kit update keeps phase 00b and the phases after it.
    ...(config.verificationMode === 'source-only' ? { plan: sourceOnlyPlan(root, config, memo).files } : {}) }));
}
export function currentJudgePreparation(root, config) {
  const file = safePath(root, 'migration/results/judge-preparation.json');
  if (!fileHash(file)) return false;
  let record;
  try { record = readJSON(file); } catch (e) { if (e instanceof SyntaxError) return false; throw e; }
  const expected = config.verificationMode === 'source-only' ? [] : ['original', 'mutation'];
  return record.schemaVersion === 1 && record.stage === 'judge-preparation' && record.success && record.executionId && record.finishedAt &&
    record.verificationMode === (config.verificationMode ?? 'runtime') && Array.isArray(record.commands) && record.commands.length === expected.length &&
    record.commands.every((c, i) => c.name === expected[i] && c.status === 'success' && c.code === 0) &&
    record.inputHash === judgeInputHash(root, config) ? record : false;
}
