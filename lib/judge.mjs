// SPDX-License-Identifier: Apache-2.0
import { hash, safePath, fileHash, treeHash, verificationFiles, readJSON, sourceOnlyPlan, requiredInputRoots, missingRootMessage } from './core.mjs';
import { runtimeLayout } from './runtime.mjs';
import fs from 'node:fs';

// Judge correctness does not depend on an as-yet-unwritten rulebook or map.
export function judgeInputHash(root, config) {
  for (const p of requiredInputRoots(config)) if (!fs.existsSync(safePath(root, p))) throw new Error(missingRootMessage(config, p, 'Judge input root missing'));
  const layout = runtimeLayout(root, config);
  return hash(JSON.stringify({ schemaVersion: 1, sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage,
    mode: config.mode, verificationMode: config.verificationMode ?? 'runtime', sourceRoots: config.sourceRoots,
    verificationRoots: config.verificationRoots, commands: Object.fromEntries(['original', 'mutation', 'parity'].map(k => [k, config.commands?.[k] ?? null])),
    source: treeHash(root, config.sourceRoots), judge: treeHash(root, config.verificationRoots),
    inputs: verificationFiles(root, config).map(p => [p, fileHash(safePath(root, p))]),
    ...(config.verificationMode === 'source-only' ? { plan: sourceOnlyPlan(root, config).files } : {}),
    runtime: layout.plugin ? treeHash(layout.root, ['lib', 'scripts', 'templates']) : treeHash(root, ['migration-kit/lib', 'migration-kit/scripts', 'migration-kit/templates']) }));
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
