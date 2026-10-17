// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { safePath, relativeName, reviewSources, hash, fileHash } from './core.mjs';
import { readUtf8 } from './text.mjs';
import { runtimeLayout, assertNoPluginAgentOverride, agentMetadata } from './runtime.mjs';
import { markerEvidence } from './markers.mjs';

export const isReviewer = role => role.startsWith('reviewer-');
// Oversized evidence switches a review to read-only "-read" profiles that open
// the listed files themselves; normal reviewers stay tool-free.
export const toolAssistedRole = role => `${role}-read`;
export const assistedReviewerRoles = ['reviewer-semantics', 'reviewer-rules'].map(toolAssistedRole);
export const isToolFreeReviewer = role => isReviewer(role) && !role.endsWith('-read');

export function validateNativeProfile(root, role, config) {
  const layout = runtimeLayout(root, config), name = layout.nativeAgentPath(role);
  const content = readUtf8(safePath(layout.root, name)), front = agentMetadata(content, name);
  if (!Array.isArray(front?.tools) || front.tools.length !== 0) throw new Error(`${role}: native workers require tools: []`);
  if (typeof front.name !== 'string' || !front.name.trim()) throw new Error(`${role}: native workers require a selectable name`);
  if (layout.plugin) assertNoPluginAgentOverride(root, layout.nativeAgentId(role), [front.name]);
  if (Object.hasOwn(front, 'model')) throw new Error(`Remove native profile model override: ${role}`);
  return { id: layout.nativeAgentId(role), name: front.name, path: name, content };
}

export function validateWorkerProfile(root, role, config = {}) {
  const layout = runtimeLayout(root, config);
  if (layout.plugin) assertNoPluginAgentOverride(root, layout.agentId(role));
  const content = fs.readFileSync(safePath(layout.root, layout.agentPath(role)), 'utf8');
  const front = agentMetadata(content, layout.agentPath(role));
  if (front && Object.hasOwn(front, 'model')) throw new Error(`Remove profile model override; config owns model selection: ${role}`);
  const expected = isToolFreeReviewer(role) ? [] : ['view', 'grep', 'glob'];
  if (!Array.isArray(front?.tools) || JSON.stringify(front.tools) !== JSON.stringify(expected)) throw new Error(`${role} requires ${isToolFreeReviewer(role) ? 'tools: []' : 'tools: ["view", "grep", "glob"]'} in its profile`);
}

export function readReviewText(root, name) {
  return readUtf8(safePath(root, name), name);
}
export function validatePreparationProfile(root, config) {
  const layout = runtimeLayout(root, config), role = 'preparation-auditor';
  if (layout.plugin) assertNoPluginAgentOverride(root, layout.agentId(role));
  const file = layout.agentPath(role), front = agentMetadata(readReviewText(layout.root, file), file);
  if (!Array.isArray(front?.tools) || front.tools.length || Object.hasOwn(front, 'model')) throw new Error('Preparation auditor requires tools: [] and explicit host model selection without a profile override');
  return fileHash(safePath(layout.root, file));
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

const tooLarge = message => Object.assign(new Error(message), { code: 'REVIEW_INPUT_TOO_LARGE' });
const reviewPaths = (config, unit, sources) => [...new Set(['migration/RULEBOOK.md', 'migration/inventory.tsv', ...(config.designInputs ?? []), ...sources, unit.target])].sort();

// Same frozen data for both reviewers; no receipts, other findings, generated
// explanations or other target files. Cross-module behavior is validated by
// build/smoke/parity. Original dependencies are included without repository reads.
export function reviewInput(root, config, unit, diagnostic = null, { candidate = true } = {}) {
  const sources = reviewSources(root, config, unit.source);
  const paths = reviewPaths(config, unit, sources);
  const limit = config.maxReviewInputBytes ?? 65536;
  const files = [];
  let bytes = 0;
  for (const name of paths) {
    let content;
    if (name === 'migration/inventory.tsv') content = inventorySlice(root, sources);
    else if (name === unit.target && !candidate) content = '';
    else {
      const file = safePath(root, name);
      if (fs.statSync(file).size > limit - bytes) throw tooLarge(`Review input exceeds maxReviewInputBytes (${limit}) at ${name}; reduce the audited unit or raise the limit after checking model capacity`);
      content = readReviewText(root, name);
    }
    const entry = { path: name, content };
    bytes += Buffer.byteLength(JSON.stringify(entry)); files.push(entry);
    if (bytes > limit) throw tooLarge(`Review input exceeds maxReviewInputBytes (${limit}) at ${name}; no content was truncated`);
  }
  const markers = candidate ? markerEvidence(config, files.find(f => f.path === unit.target).content) : null;
  const text = JSON.stringify({ schemaVersion: 1, source: unit.source, target: unit.target, diagnostic, sources, files, ...(markers ? { markerEvidence: markers } : {}) });
  if (Buffer.byteLength(text) > limit) throw tooLarge(`Review input exceeds maxReviewInputBytes (${limit}); no content was truncated`);
  return { text, hash: hash(text) };
}

// Frozen input when it fits; otherwise (CLI only) an identical file list bound
// by SHA-256 that tool-assisted reviewers read themselves. The receipt records
// which mode ran. Native workers have no tools, so they keep the hard stop.
export function reviewEvidence(root, config, unit, diagnostic = null, { candidate = true } = {}) {
  try { return { ...reviewInput(root, config, unit, diagnostic, { candidate }), mode: 'frozen' }; }
  catch (e) {
    if (e.code !== 'REVIEW_INPUT_TOO_LARGE') throw e;
    if (config.workerBackend === 'native') throw new Error(`${e.message}. Native workers have no tools, so the tool-assisted review fallback is unavailable; raise maxReviewInputBytes after checking model capacity, or use the copilot-cli backend.`);
    const sources = reviewSources(root, config, unit.source), limit = config.maxReviewInputBytes ?? 65536;
    const inventory = inventorySlice(root, sources);
    const files = reviewPaths(config, unit, sources).filter(name => name !== unit.target || candidate).map(name => {
      readReviewText(root, name); // Same UTF-8 validation as frozen evidence.
      return { path: name, sha256: fileHash(safePath(root, name)), bytes: fs.statSync(safePath(root, name)).size };
    });
    const markers = candidate ? markerEvidence(config, readReviewText(root, unit.target)) : null;
    const inlineInventory = Buffer.byteLength(inventory) <= limit / 2;
    const text = JSON.stringify({ schemaVersion: 1, mode: 'tool-assisted', reason: e.message, source: unit.source, target: unit.target,
      diagnostic, sources, files, ...(inlineInventory ? { inventoryRows: inventory } : { inventorySha256: hash(inventory) }),
      ...(markers ? { markerEvidence: markers } : {}) });
    if (Buffer.byteLength(text) > limit) throw tooLarge(`Even the tool-assisted file list exceeds maxReviewInputBytes (${limit}) for ${unit.target}; raise the limit or split the unit`);
    return { text, hash: hash(text), mode: 'tool-assisted' };
  }
}
