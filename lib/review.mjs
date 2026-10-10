// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { filesUnder, safePath, readManifest, hash } from './core.mjs';

export const isReviewer = role => role.startsWith('reviewer-');

export function validateWorkerProfile(root, role) {
  const content = fs.readFileSync(safePath(root, `.github/agents/migration-${role}.agent.md`), 'utf8');
  const front = content.split('---')[1] ?? '';
  if (/^model\s*:/m.test(front)) throw new Error(`Remove profile model override; config owns model selection: ${role}`);
  const expected = isReviewer(role) ? /^tools:\s*\[\s*\]\s*$/m : /^tools:\s*\[\s*["']?read["']?\s*,\s*["']?search["']?\s*\]\s*$/m;
  if (!expected.test(front)) throw new Error(`${role} requires ${isReviewer(role) ? 'tools: []' : 'read/search-only tools'} in its profile`);
}

export function readReviewText(root, name) {
  const data = fs.readFileSync(safePath(root, name));
  if (!isUtf8(data)) throw new Error(`Review input must be valid UTF-8: ${name}; convert the file to UTF-8 before retrying`);
  const content = data.toString('utf8');
  if (content.includes('\0')) throw new Error(`Review input must be text: ${name}`);
  return content;
}

// Same frozen data for both reviewers; no receipts, other findings, generated
// explanations or other target files. Cross-module behavior is validated by
// build/smoke/parity. Original dependencies are included without repository reads.
export function reviewInput(root, config, unit, diagnostic = null) {
  const paths = [...new Set([
    'migration/RULEBOOK.md', 'migration/inventory.tsv',
    ...config.sourceRoots.flatMap(r => filesUnder(root, r)),
    ...readManifest(root, config).map(u => u.source), unit.target
  ])].sort();
  const limit = config.maxReviewInputBytes ?? 65536;
  const files = [];
  let bytes = 0;
  for (const name of paths) {
    const file = safePath(root, name);
    if (fs.statSync(file).size > limit - bytes) throw new Error(`Review input exceeds maxReviewInputBytes (${limit}); select a smaller source scope or raise the limit after checking model capacity`);
    const content = readReviewText(root, name);
    const entry = { path: name, content };
    bytes += Buffer.byteLength(JSON.stringify(entry)); files.push(entry);
  }
  const text = JSON.stringify({ schemaVersion: 1, source: unit.source, target: unit.target, diagnostic, files });
  if (Buffer.byteLength(text) > limit) throw new Error(`Review input exceeds maxReviewInputBytes (${limit}); no content was truncated`);
  return { text, hash: hash(text) };
}
