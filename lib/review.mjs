// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { safePath, relativeName, reviewSources, hash } from './core.mjs';
import { readUtf8 } from './text.mjs';

export const isReviewer = role => role.startsWith('reviewer-');

export function validateWorkerProfile(root, role) {
  const content = fs.readFileSync(safePath(root, `.github/agents/migration-${role}.agent.md`), 'utf8');
  const front = content.split('---')[1] ?? '';
  if (/^model\s*:/m.test(front)) throw new Error(`Remove profile model override; config owns model selection: ${role}`);
  const expected = isReviewer(role) ? /^tools:\s*\[\s*\]\s*$/m : /^tools:\s*\[\s*["']?view["']?\s*,\s*["']?grep["']?\s*,\s*["']?glob["']?\s*\]\s*$/m;
  if (!expected.test(front)) throw new Error(`${role} requires ${isReviewer(role) ? 'tools: []' : 'tools: ["view", "grep", "glob"]'} in its profile`);
}

export function readReviewText(root, name) {
  return readUtf8(safePath(root, name), name);
}

export function inventorySlice(root, sources) {
  const lines = readReviewText(root, 'migration/inventory.tsv').replace(/^\uFEFF/, '').split(/\r?\n/);
  const selected = new Set(sources), kept = [];
  let columns;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) { kept.push(line); continue; }
    const cells = line.split('\t');
    if (!columns) {
      if (cells[0] !== 'file' || cells.length < 2 || cells.some(c => !c) || new Set(cells).size !== cells.length) throw new Error('Inventory header must begin with file<TAB> and have unique column names');
      columns = cells; kept.push(line); continue;
    }
    if (cells.length !== columns.length) throw new Error(`Malformed inventory row at line ${i + 1}`);
    relativeName(cells[0]);
    if (selected.has(cells[0])) kept.push(line);
  }
  if (!columns) throw new Error('Inventory header missing');
  return kept.join('\n');
}

// Same frozen data for both reviewers; no receipts, other findings, generated
// explanations or other target files. Cross-module behavior is validated by
// build/smoke/parity. Original dependencies are included without repository reads.
export function reviewInput(root, config, unit, diagnostic = null, { candidate = true } = {}) {
  const sources = reviewSources(root, config, unit.source);
  const paths = [...new Set([
    'migration/RULEBOOK.md', 'migration/inventory.tsv',
    ...sources, unit.target
  ])].sort();
  const limit = config.maxReviewInputBytes ?? 65536;
  const files = [];
  let bytes = 0;
  for (const name of paths) {
    let content;
    if (name === 'migration/inventory.tsv') content = inventorySlice(root, sources);
    else if (name === unit.target && !candidate) content = '';
    else {
      const file = safePath(root, name);
      if (fs.statSync(file).size > limit - bytes) throw new Error(`Review input exceeds maxReviewInputBytes (${limit}) at ${name}; reduce the audited unit or raise the limit after checking model capacity`);
      content = readReviewText(root, name);
    }
    const entry = { path: name, content };
    bytes += Buffer.byteLength(JSON.stringify(entry)); files.push(entry);
    if (bytes > limit) throw new Error(`Review input exceeds maxReviewInputBytes (${limit}) at ${name}; no content was truncated`);
  }
  const text = JSON.stringify({ schemaVersion: 1, source: unit.source, target: unit.target, diagnostic, sources, files });
  if (Buffer.byteLength(text) > limit) throw new Error(`Review input exceeds maxReviewInputBytes (${limit}); no content was truncated`);
  return { text, hash: hash(text) };
}
