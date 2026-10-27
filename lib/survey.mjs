// SPDX-License-Identifier: Apache-2.0
// Delegated preparation surveys. The parent no longer reads the whole codebase
// into its own context for phases 00/00b/02: the source is split into scopes
// (directory, then size), each scope goes to a fresh tool-free "surveyor"
// worker (a new Copilot CLI process) with a
// frozen input, and every answer lands in its own file. Done-ness is the file
// on disk bound to the scope's input hash (upstream rule 2), so runs resume.
// Results are drafts for the phase's own reviews and the human gate; merging
// them never records a phase.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { safePath, readJSON, writeJSON, atomicWrite, fileHash, filesUnder, hash, stamp, lockRun, inside, workerModel, workerEffort, workerContext } from './core.mjs';
import { readReviewText } from './review.mjs';
import { isTransientFailure, isSystemicFailure, retryDelayMs } from './failures.mjs';
import { costEvent, recordCost } from './cost.mjs';
import { mergeInventory } from './preparation.mjs';
import { sourceSpecPlan, legacyContractsSkeleton } from './source-spec.mjs';
import { recordSession } from './sessions.mjs';
import { executionLimits, ignoredLimits } from './execution-policy.mjs';
import { surveyRequests, combineSurveyParts } from './survey-parts.mjs';

const surveyRoot = 'migration/surveys';
const inventoryHeader = 'file\tsymbol\tsource_construct\tclassification\ttarget_translation\tevidence\tstatus';
const factCategories = ['entry-point', 'data-format', 'external-dependency', 'platform', 'generated', 'pain-point', 'risk', 'test'];

export const surveyKinds = {
  facts: { phase: '00', task: language => `Survey these source files for a migration to ${language}. Return one item per notable fact: {"file":"PATH","category":"${factCategories.join('|')}","summary":"one sentence","evidence":"PATH:LINE ..."}. Cover public entry points, data formats, external dependencies, platform-specific code, generated code, pain points that motivate the migration, risky constructs and tests. Facts only, from the given files; cite PATH:LINE; do not propose translations.` },
  contracts: { phase: '00b', task: () => `The source code is the only specification. For EVERY file in the input return exactly one item: {"file":"PATH","publicInterface":"...","inputsOutputsErrors":"...","edgeCases":"...","evidence":"PATH:LINE ...","unknowns":"... or none"}. Use only the given source; write "unknown" where the source cannot decide; never claim observed runtime behavior.` },
  inventory: { phase: '02', task: () => `Classify EVERY site listed in "sites" for the gap inventory, following the RULEBOOK. Return exactly one item per site: {"file":"PATH","symbol":"...","source_construct":"...","classification":"...","target_translation":"...","evidence":"PATH:LINE created/changed/escapes ...","status":"confirmed|unknown"}. Trace where the value is created, changes and escapes and cite those lines. When the rulebook and source cannot decide, use classification UNKNOWN, status unknown, and a target_translation with the most conservative representation plus TODO(port) and the open question.` }
};
const requireKind = kind => { if (!surveyKinds[kind]) throw new Error(`Survey kind must be one of ${Object.keys(surveyKinds).join(', ')}`); return surveyKinds[kind]; };
const resultPath = (kind, id) => `${surveyRoot}/${kind}/${id}.json`;
// A NAME.EXT:LINE outside the scope is a foreign citation unless it reads as a
// host name or a short member access: a URL (//host:port), or a name without a
// directory whose extension is a common domain (example.com:8443,
// example.rs:8080) or one/two letters such as self.r:5. A scope file's own
// extension always counts, so other.rs:3 in a Rust scope is still rejected.
const plainExtensions = new Set(['com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'jp', 'uk', 'de', 'fr', 'cn', 'ru', 'br', 'in', 'au', 'ca', 'us', 'eu',
  'nl', 'se', 'no', 'es', 'it', 'ch', 'kr', 'tw', 'info', 'biz', 'app', 'dev', 'ai', 'me', 'tv', 'cloud', 'local', 'localhost', 'internal', 'lan', 'test', 'example',
  'xyz', 'site', 'online', 'tech', 'cc', 'py', 'rs', 'sh', 'md', 'pl', 'pm', 'ml', 'hs', 'f', 's', 'm', 'r', 'ex', 'pc']);
function anchors(text, files) {
  const value = String(text ?? ''), known = [];
  for (const file of files) {
    const literal = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_./-])(?:\\./)?${literal}:(\\d+)(?:[-–](\\d+))?`, 'gu'))) {
      known.push({ file, line: Number(m[1]), end: Number(m[2] ?? m[1]), start: m.index, stop: m.index + m[0].length });
    }
  }
  const own = new Set(files.map(f => path.posix.extname(f).slice(1).toLowerCase()).filter(Boolean));
  const citation = (name, ext) => own.has(ext) || (!name.startsWith('//') && (name.includes('/') || !plainExtensions.has(ext)));
  const other = [...value.matchAll(/([\p{L}\p{N}_.\/-]*[\p{L}\p{N}_-]\.([A-Za-z][A-Za-z0-9]*)):(\d+)(?:[-–](\d+))?/gu)]
    .filter(m => citation(m[1], m[2].toLowerCase()) && !known.some(a => m.index >= a.start && m.index + m[0].length <= a.stop))
    .map(m => ({ file: m[1].replace(/^\.\//, ''), line: Number(m[3]), end: Number(m[4] ?? m[3]) }));
  return [...known, ...other];
}
const sourceLines = content => {
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
};

function sites(root, config, sitesFile) {
  if (!sitesFile?.startsWith('migration/')) throw new Error('The inventory survey needs a mechanical site census: --sites migration/PATH.tsv (file<TAB>symbol<TAB>source_construct)');
  const lines = readReviewText(root, sitesFile).replace(/^﻿/, '').split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  if (lines.shift() !== 'file\tsymbol\tsource_construct') throw new Error(`Unexpected TSV header: ${sitesFile}`);
  return lines.map(l => { const [file, symbol, construct] = l.split('\t'); return { file, symbol, source_construct: construct }; });
}

// Deterministic scopes: files of one directory stay together, split by count
// and by the frozen-input byte budget the workers receive.
export function planSurvey(root, config, kind, { maxFiles, sitesFile } = {}) {
  let saved;
  try { saved = readJSON(safePath(root, `${surveyRoot}/${kind}/plan.json`)); } catch {}
  maxFiles ??= saved?.maxFiles ?? 20;
  requireKind(kind);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 200) throw new Error('--max-files must be an integer from 1 to 200');
  const limit = config.maxReviewInputBytes ?? 65536;
  const shared = kind === 'inventory' ? Buffer.byteLength(readReviewText(root, 'migration/RULEBOOK.md')) : 0;
  const census = kind === 'inventory' ? sites(root, config, sitesFile) : null;
  // Group by directory first so one directory's files stay in adjacent scopes.
  const censusFiles = census && new Set(census.map(s => s.file));
  const allFiles = new Set(config.sourceRoots.flatMap(dir => filesUnder(root, dir)));
  const files = [...allFiles]
    .filter(p => !censusFiles || censusFiles.has(p))
    .sort((a, b) => { const da = path.posix.dirname(a), db = path.posix.dirname(b); return da === db ? (a < b ? -1 : a > b ? 1 : 0) : (da < db ? -1 : 1); });
  const skipped = censusFiles ? [...censusFiles].filter(file => !allFiles.has(file)).map(file => ({ file: String(file ?? '(missing file)'), reason: 'Census source is missing or outside the configured source roots' })) : [];
  if (!allFiles.size) skipped.push({ file: config.sourceRoots.join(', '), reason: 'No source files under configured source roots' });
  else if (census && !census.length) skipped.push({ file: sitesFile, reason: 'Inventory census has no sites; an empty inventory cannot be merged' });
  const scopes = [];
  let current = null;
  for (const file of files) {
    let size;
    try { size = Buffer.byteLength(readReviewText(root, file)); } catch (e) { skipped.push({ file, reason: e.message }); continue; }
    const dir = path.posix.dirname(file);
    const budget = limit - shared - 4096;
    if (!current || current.dir !== dir || current.files.length >= maxFiles || current.bytes + size > budget) {
      current = { dir, files: [], bytes: 0 }; scopes.push(current);
    }
    current.files.push(file); current.bytes += size;
  }
  const plan = { schemaVersion: 1, kind, maxFiles, maxReviewInputBytes: limit, ...(sitesFile ? { sites: sitesFile } : {}),
    scopes: scopes.map((s, i) => ({ id: `${String(i + 1).padStart(3, '0')}-${s.dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root'}`, dir: s.dir, files: s.files,
      ...(s.bytes + shared + 4096 > limit ? { tooLarge: true } : {}) })), skipped };
  // Keep the existing scope IDs and completed receipts on resume. Adding source
  // numbering must not silently repartition every previously completed scope.
  const savedFiles = saved?.scopes?.flatMap(s => Array.isArray(s.files) ? s.files : []);
  if (saved?.schemaVersion === 1 && saved.kind === kind && saved.maxFiles === maxFiles && saved.sites === sitesFile &&
      Array.isArray(savedFiles) && new Set(savedFiles).size === savedFiles.length && new Set(saved.scopes.map(s => s.id)).size === saved.scopes.length &&
      saved.scopes.every(s => /^[A-Za-z0-9_-]+$/.test(s.id) && typeof s.dir === 'string' && Array.isArray(s.files) && s.files.length > 0)) {
    // A previously unreadable file becoming readable must not shift the IDs
    // of every successful scope after it. Keep existing memberships/IDs and
    // append newly readable/new files. Removed files invalidate only their own
    // scope through its changed input, never another scope's identity.
    const readable = new Set(plan.scopes.flatMap(s => s.files));
    const retained = saved.scopes.map(({ id, dir, files }) => ({ id, dir, files: files.filter(p => readable.has(p)) })).filter(s => s.files.length);
    const assigned = new Set(retained.flatMap(s => s.files));
    let next = saved.scopes.reduce((n, s) => Math.max(n, Number(s.id.match(/^\d+/)?.[0]) || 0), 0);
    const used = new Set(saved.scopes.map(s => s.id));
    const additions = plan.scopes.flatMap(scope => {
      const files = scope.files.filter(p => !assigned.has(p));
      if (!files.length) return [];
      let id;
      do { id = `${String(++next).padStart(3, '0')}-${scope.dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root'}`; } while (used.has(id));
      used.add(id);
      return [{ id, dir: scope.dir, files }];
    });
    plan.scopes = [...retained, ...additions];
  }
  for (const scope of plan.scopes) {
    const bytes = Buffer.byteLength(surveyInput(root, config, kind, scope, { sitesFile }).text);
    if (bytes > limit) scope.tooLarge = true;
  }
  return plan;
}

export function surveyInput(root, config, kind, scope, { sitesFile } = {}) {
  const spec = requireKind(kind);
  const census = kind === 'inventory' ? sites(root, config, sitesFile).filter(s => scope.files.includes(s.file)) : undefined;
  const original = { schemaVersion: 1, kind, task: spec.task(config.targetLanguage),
    ...(kind === 'inventory' ? { rulebook: readReviewText(root, 'migration/RULEBOOK.md'), sites: census } : {}),
    files: scope.files.map(p => ({ path: p, content: readReviewText(root, p) })), scope: scope.id, sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage };
  const files = original.files.map(file => {
    const lines = sourceLines(file.content);
    return { path: file.path, firstLine: 1, lastLine: lines.length, content: lines.map((line, i) => `${i + 1}|${line}`).join('\n') };
  });
  const text = JSON.stringify({ ...original, files,
    citationRules: 'The prefix before | is the original source line number, not source code. Copy PATH:LINE from these numbers; never count JSON lines or invent a line. Cite only supplied files and lines. Unknown behavior stays unknown.' });
  return { text, hash: hash(text), legacyHash: hash(JSON.stringify(original)), sites: census,
    lines: Object.fromEntries(files.map(f => [f.path, f.lastLine])) };
}

function validateItems(kind, scope, items, census, lines, ranges) {
  if (!Array.isArray(items)) throw new Error('Survey result requires an items array');
  const inScope = p => scope.files.includes(p);
  const cited = item => anchors(item.evidence, scope.files).some(a => inScope(a.file));
  const text = (v, f) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`Survey item requires ${f}`); };
  for (const item of items) {
    text(item?.file, 'file'); text(item.evidence, 'evidence');
    if (!inScope(item.file)) throw new Error(`Survey item outside its scope: ${item.file}`);
    if (!cited(item)) throw new Error(`Survey item must cite PATH:LINE inside its scope: ${item.file}`);
    for (const a of anchors(item.evidence, scope.files)) {
      if (!inScope(a.file) || a.line < 1 || a.end < a.line || (lines && a.end > lines[a.file]) ||
          (ranges && !ranges[a.file]?.some(r => a.line >= r.first && a.end <= r.last))) {
      throw new Error(`Survey citation outside source lines: ${a.file}:${a.line}${a.end === a.line ? '' : `-${a.end}`} (allowed ${ranges?.[a.file]?.map(r => `${r.first}-${r.last}`).join(', ') ?? `1-${lines?.[a.file] ?? 0}`})`);
      }
    }
  }
  if (kind === 'facts') for (const item of items) { text(item.summary, 'summary'); if (!factCategories.includes(item.category)) throw new Error(`Unknown fact category: ${item.category}`); }
  if (kind === 'contracts') {
    for (const item of items) for (const f of ['publicInterface', 'inputsOutputsErrors', 'edgeCases', 'unknowns']) text(item[f], f);
    const covered = items.map(i => i.file).sort();
    if (JSON.stringify(covered) !== JSON.stringify([...scope.files].sort())) throw new Error('Contracts survey must return exactly one item per scope file');
  }
  if (kind === 'inventory') {
    const key = r => JSON.stringify([r.file, r.symbol, r.source_construct]);
    const expected = new Set(census.map(key)), seen = new Set();
    for (const item of items) {
      for (const f of ['symbol', 'source_construct', 'classification', 'target_translation']) text(item[f], f);
      if (/[\t\r\n]/.test(Object.values(item).join(''))) throw new Error('Inventory cells cannot contain tabs or newlines');
      if (!expected.has(key(item)) || seen.has(key(item))) throw new Error(`Inventory item is not a scope census site or is duplicated: ${item.file}:${item.symbol}`);
      if (!['confirmed', 'unknown'].includes(item.status)) throw new Error('Inventory items must be confirmed or unknown');
      if (item.status === 'unknown' && (item.classification !== 'UNKNOWN' || !item.target_translation.includes('TODO(port)'))) throw new Error('UNKNOWN requires a deterministic target representation plus TODO(port) and the open question');
      seen.add(key(item));
    }
    if (seen.size !== expected.size) throw new Error(`Inventory survey covered ${seen.size} of ${expected.size} scope sites`);
  }
  return items;
}

const current = (root, kind, scope, input) => {
  try {
    const r = readJSON(safePath(root, resultPath(kind, scope.id)));
    if (r?.schemaVersion !== 1 || ![input.hash, input.legacyHash].includes(r.inputHash) || r.kind !== kind) return null;
    validateItems(kind, scope, r.items, input.sites, input.lines);
    return r;
  }
  catch { return null; }
};

// Keep valid rows from a rejected answer. Only the missing/bad files or census
// sites need another fresh worker; never rewrite a citation to make it pass.
function acceptedItems(kind, scope, items, input) {
  if (!Array.isArray(items) || !['contracts', 'inventory'].includes(kind)) return [];
  const key = item => kind === 'contracts' ? item?.file : JSON.stringify([item?.file, item?.symbol, item?.source_construct]);
  const expected = kind === 'contracts' ? scope.files.map(file => ({ file })) : input.sites;
  return expected.flatMap(site => {
    const matches = items.filter(item => key(item) === key(site));
    if (matches.length !== 1) return [];
    try { validateItems(kind, { ...scope, files: [site.file] }, matches, kind === 'inventory' ? [site] : undefined, input.lines, input.ranges); return matches; }
    catch { return []; }
  });
}

// After the one focused correction, rows still without a valid answer become
// UNKNOWN with TODO(port). Their evidence names only the range that was read,
// never a model's rejected line, and the item carries uncited: true.
function uncitedItems(kind, part, accepted, rejectedPath, lines) {
  if (kind === 'facts') return accepted;
  const key = item => kind === 'contracts' ? item.file : JSON.stringify([item.file, item.symbol, item.source_construct]);
  const done = new Set(accepted.map(key));
  const range = file => { const r = part.input.ranges?.[file]?.[0] ?? { first: 1, last: lines?.[file] || 1 }; return r.first === r.last ? `${r.first}` : `${r.first}-${r.last}`; };
  const evidence = file => `${file}:${range(file)} (no verified citation after one correction; rejected answer: ${rejectedPath})`;
  const missing = kind === 'contracts' ? part.scope.files.filter(file => !done.has(file)).map(file => ({ file })) : part.input.sites.filter(site => !done.has(key(site)));
  return [...accepted, ...missing.map(site => kind === 'contracts'
    ? { file: site.file, publicInterface: 'unknown', inputsOutputsErrors: 'unknown', edgeCases: 'unknown', evidence: evidence(site.file),
      unknowns: 'unknown: the surveyor gave no valid citation after one correction; read the source during review', uncited: true }
    : { ...site, classification: 'UNKNOWN', status: 'unknown', evidence: evidence(site.file), uncited: true,
      target_translation: 'Preserve source representation; TODO(port): the surveyor gave no valid citation after one correction; trace where the value is created, changes and escapes during the inventory review.' })];
}

function repairInput(kind, scope, input, accepted, error) {
  if (kind === 'facts') {
    const data = JSON.parse(input.text), text = JSON.stringify({ ...data, repair: { error, instruction: 'Correct the invalid facts using only the supplied source ranges.' } });
    return { scope, input: { ...input, text }, accepted: [] };
  }
  const key = item => kind === 'contracts' ? item.file : JSON.stringify([item.file, item.symbol, item.source_construct]);
  const known = new Set(accepted.map(key));
  const census = kind === 'inventory' ? input.sites.filter(s => !known.has(key(s))) : undefined;
  const files = kind === 'contracts' ? scope.files.filter(p => !known.has(p)) : [...new Set(census.map(s => s.file))];
  // Unknown/extra items may have invalidated an otherwise complete answer.
  // Retry the whole scope in that case rather than silently dropping extras.
  if (!files.length) return { input, scope, accepted: [] };
  const data = JSON.parse(input.text);
  const text = JSON.stringify({ ...data, files: data.files.filter(f => files.includes(f.path)), ...(census ? { sites: census } : {}),
    repair: { error, instruction: 'Return only the listed files/sites. Other rows were already validated and preserved. Copy original numbered source anchors; do not renumber them.' } });
  return { input: { ...input, text, sites: census }, scope: { ...scope, files }, accepted };
}

export function surveyStatus(root, config, kind, options = {}) {
  const plan = planSurvey(root, config, kind, options);
  const scopes = plan.scopes.map(scope => {
    const input = surveyInput(root, config, kind, scope, options);
    const done = current(root, kind, scope, input);
    return { id: scope.id, files: scope.files.length, status: done ? 'done' : 'pending', ...(scope.tooLarge ? { partitioned: true } : {}), ...(done ? { items: done.items.length } : {}) };
  });
  const done = scopes.filter(s => s.status === 'done').length;
  return { kind, total: scopes.length, done, complete: done === scopes.length && !plan.skipped.length, scopes, skipped: plan.skipped };
}

// The worker sees the scope as the unit: unit.target is the result file the
// coordinator writes, so the usual "never take a destination from model
// output" rule holds. Failures block only their scope; systemic ones stop all.
export async function runSurvey(root, config, kind, adapter, { signal, onProgress = () => {}, maxFiles, sitesFile } = {}) {
  const spec = requireKind(kind);
  const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, startedAt = stamp();
  const release = lockRun(root, 'survey', { runId });
  let calls = 0, reservations = 0, systemic = null;
  const errors = [], completed = [], unresolved = { uncited: 0, droppedFacts: 0, droppedAnswers: 0, unsurveyedOversizedFiles: [] };
  const active = new Set();
  const partProgress = {};
  const limits = executionLimits(config);
  let total = 0, priorDone = 0, unreadableFiles = 0;
  const progressPath = `${surveyRoot}/${kind}/runs/${runId}.progress.json`;
  let progressWarning = false;
  const progress = state => {
    try { writeJSON(safePath(root, progressPath), { schemaVersion: 1, kind, runId, state, startedAt,
      updatedAt: stamp(), agentCalls: calls, done: priorDone + completed.length, total, unreadableFiles, activeScopes: [...active], parts: partProgress }); }
    catch (e) {
      // Optional progress must not kill an otherwise healthy worker. Primary
      // result/partial/attempt writes remain mandatory and propagate errors.
      if (!progressWarning) console.error(`WARNING: survey progress could not be saved: ${e.message}`);
      progressWarning = true;
    }
  };
  let heartbeat;
  try {
    const plan = planSurvey(root, config, kind, { maxFiles, sitesFile });
    writeJSON(safePath(root, `${surveyRoot}/${kind}/plan.json`), plan);
    total = plan.scopes.length;
    unreadableFiles = plan.skipped.length;
    const queue = [];
    for (const scope of plan.scopes) {
      const input = surveyInput(root, config, kind, scope, { sitesFile });
      if (current(root, kind, scope, input)) { priorDone++; continue; }
      queue.push({ scope, input });
    }
    progress('running');
    heartbeat = setInterval(() => { try { progress('running'); } catch {} }, 15000);
    heartbeat.unref();
    const runOne = async ({ scope, input }) => {
      const unit = { id: `survey-${kind}-${scope.id}`, source: scope.id, target: resultPath(kind, scope.id) };
      const partialPath = `${surveyRoot}/${kind}/${scope.id}.partial.json`;
      let request = { input, scope, accepted: [] };
      try {
        const partial = readJSON(safePath(root, partialPath));
        if (partial.schemaVersion === 1 && partial.kind === kind && [input.hash, input.legacyHash].includes(partial.inputHash)) {
          const accepted = acceptedItems(kind, scope, partial.items, input);
          if (accepted.length) request = repairInput(kind, scope, input, accepted, 'Resume only the unfinished rows');
        }
      } catch {}
      const parts = surveyRequests(kind, request, config.maxReviewInputBytes ?? 65536), finished = [];
      partProgress[scope.id] = { done: 0, total: parts.length };
      active.add(scope.id); progress('running');
      let preserved = [...request.accepted];
      const preserve = rows => {
        const key = item => kind === 'contracts' ? item.file : JSON.stringify([item.file, item.symbol, item.source_construct]);
        preserved = acceptedItems(kind, scope, [...new Map([...preserved, ...rows].map(item => [key(item), item])).values()], input);
        if (preserved.length) writeJSON(safePath(root, partialPath), { schemaVersion: 1, kind, inputHash: input.hash, items: preserved });
      };
      const runPart = async (part, index) => {
        if (part.mechanical) return { ...part, items: validateItems(kind, part.scope, part.mechanical, part.input.sites, input.lines, part.input.ranges) };
        const requestHash = hash(part.input.text), partPath = `${surveyRoot}/${kind}/${scope.id}.parts/${requestHash}.json`;
        try {
          const cached = readJSON(safePath(root, partPath));
          if (cached.schemaVersion === 1 && cached.kind === kind && cached.scopeInputHash === input.hash && cached.requestHash === requestHash) {
            validateItems(kind, part.scope, cached.items, part.input.sites, input.lines, part.input.ranges);
            return { ...part, items: cached.items, reused: true, dropped: cached.droppedFacts ?? 0, lostAnswer: cached.droppedAnswer === true };
          }
        } catch {}
        let pending = { ...part, accepted: [] }, repaired = false, retry = 0, dropped = 0, lostAnswer = false;
        const partPartialPath = `${partPath}.partial.json`;
        try {
          const saved = readJSON(safePath(root, partPartialPath));
          if (saved.scopeInputHash === input.hash && saved.requestHash === requestHash) {
            const accepted = acceptedItems(kind, part.scope, saved.items, part.input);
            if (accepted.length) pending = repairInput(kind, part.scope, part.input, accepted, 'Resume only unfinished fragment rows');
          }
        } catch {}
        for (;;) {
          if (signal?.aborted) throw new Error('Interrupted');
          if (systemic) throw systemic;
          if (reservations >= limits.calls) throw new Error('Agent call limit reached; resume with a new run after reviewing usage');
          // Keep correction details out of an already full source envelope.
          // They are still passed as extra task data and saved verbatim below.
          let validationError;
          if (Buffer.byteLength(pending.input.text) > (config.maxReviewInputBytes ?? 65536)) {
            const data = JSON.parse(pending.input.text); validationError = data.repair?.error; delete data.repair;
            pending.input = { ...pending.input, text: JSON.stringify(data) };
          }
          if (Buffer.byteLength(pending.input.text) > (config.maxReviewInputBytes ?? 65536)) throw new Error('Survey metadata exceeds maxReviewInputBytes during correction');
          reservations++; calls++;
          partProgress[scope.id].activePart = index + 1; progress('running');
          onProgress({ unit: scope.id, stage: `surveyor${repaired ? ' citation repair' : retry ? ` retry ${retry}` : ''} part ${index + 1}/${parts.length}`, calls });
          try {
            const sessionId = recordSession(root, runId, { role: 'surveyor', target: unit.target });
            let response, result, items;
            try {
              response = await adapter({ root, config, role: 'surveyor', unit,
                extra: { survey: { kind, scope: scope.id, part: index + 1, parts: parts.length, maxFiles: plan.maxFiles,
                  ...(validationError ? { validationError } : {}), ...(sitesFile ? { sitesFile } : {}) } },
                signal, reviewInput: pending.input.text, context: input.hash, runId, sessionId });
              result = response.result;
              if (result?.schemaVersion !== 1 || result.kind !== 'survey' || result.survey !== kind || result.target !== unit.target) throw new Error('Invalid survey result: schemaVersion/kind/survey/target mismatch');
              validateItems(kind, pending.scope, result.items, pending.input.sites, input.lines, pending.input.ranges);
              items = validateItems(kind, part.scope, [...pending.accepted, ...result.items], part.input.sites, input.lines, part.input.ranges);
            } catch (e) {
              // The production adapter rejects malformed model JSON/schema
              // before returning. Route those failures through the same saved
              // rejection and focused correction as item/citation failures.
              if (!response && e.code !== 'SURVEY_VALIDATION') throw e;
              result ??= e.surveyResult;
              e.code = 'SURVEY_VALIDATION';
              const rejectedPath = `${surveyRoot}/${kind}/runs/${runId}-${scope.id}-${calls}-rejected.json`;
              writeJSON(safePath(root, rejectedPath), {
                schemaVersion: 1, kind: 'survey-rejected-answer', scope: scope.id, requestHash, inputHash: input.hash, error: e.message, result: result ?? null,
                ...(typeof e.rawAgentResult === 'string' ? { rawAgentResult: e.rawAgentResult } : {}), recordedAt: stamp() });
              const validEnvelope = result?.schemaVersion === 1 && result.kind === 'survey' && result.survey === kind && result.target === unit.target;
              const accepted = acceptedItems(kind, part.scope, [...pending.accepted, ...(validEnvelope && Array.isArray(result?.items) ? result.items : [])], part.input);
              if (accepted.length) {
                writeJSON(safePath(root, partPartialPath), { schemaVersion: 1, kind, scopeInputHash: input.hash, requestHash, items: accepted });
                if (!part.fragment) preserve(accepted);
              }
              // A wrong answer is a real validation failure, not elapsed time
              // or load. One focused correction avoids unbounded bad-answer loops.
              if (!repaired && reservations < limits.calls && !signal?.aborted) {
                pending = repairInput(kind, part.scope, part.input, accepted, e.message); repaired = true; continue;
              }
              if (signal?.aborted) throw e;
              // A rerun would ask the same question again. Keep every valid row
              // and finish the rest as explicit, uncited unknowns instead of
              // stopping the whole survey; the rejected answer stays on disk.
              const offered = kind === 'facts' && Array.isArray(result?.items) ? result.items : [];
              const kept = kind === 'facts' && validEnvelope ? offered.filter(item => {
                try { validateItems(kind, part.scope, [item], undefined, input.lines, part.input.ranges); return true; } catch { return false; }
              }) : kind === 'facts' ? [] : accepted;
              dropped = offered.length - kept.length;
              // A facts answer with a wrong envelope loses the whole part; count it too.
              lostAnswer = kind === 'facts' && !validEnvelope;
              items = validateItems(kind, part.scope, uncitedItems(kind, part, kept, rejectedPath, input.lines), part.input.sites, input.lines, part.input.ranges);
            }
            writeJSON(safePath(root, partPath), { schemaVersion: 1, kind, scopeInputHash: input.hash, requestHash,
              ...(part.fragment ? { fragment: part.fragment } : {}), finishedAt: stamp(), items,
              ...(items.some(i => i.uncited) ? { uncited: items.filter(i => i.uncited).length } : {}), ...(dropped ? { droppedFacts: dropped } : {}), ...(lostAnswer ? { droppedAnswer: true } : {}),
              requestedModel: workerModel(config, 'surveyor'), observedModel: response?.observedModel ?? null,
              ...(response?.cliSessionId ? { cliSessionId: response.cliSessionId } : {}) });
            fs.rmSync(safePath(root, partPartialPath), { force: true });
            return { ...part, items, response, dropped, lostAnswer };
          } catch (e) {
            if (e.code === 'SURVEY_VALIDATION') throw e;
            if (isSystemicFailure(e)) { systemic ??= e; throw e; }
            if (!isTransientFailure(e) || retry >= limits.retries || signal?.aborted) throw e;
            onProgress({ unit: scope.id, stage: `surveyor waiting after transient failure (retry ${retry + 1})`, calls });
            await sleep(retryDelayMs(config, retry++), undefined, { signal }).catch(() => { throw new Error('Interrupted'); });
          }
        }
      };
      const failures = [];
      for (const [index, part] of parts.entries()) {
        if (signal?.aborted || systemic) {
          failures.push(new Error(signal?.aborted ? 'Interrupted' : systemic.message)); break;
        }
        try {
          const result = await runPart(part, index); finished.push(result);
          partProgress[scope.id].done++; progress('running');
          if (!part.fragment) preserve(result.items);
          onProgress({ unit: scope.id, stage: `surveyor part done ${partProgress[scope.id].done}/${parts.length}`, calls });
        } catch (e) { failures.push(e); }
      }
      if (failures.length) throw failures[0];
      const items = validateItems(kind, scope, [...request.accepted, ...combineSurveyParts(kind, finished)], input.sites, input.lines);
      // No whole-scope result until every source range and every census site
      // has a validated receipt and the original source is still unchanged.
      if (surveyInput(root, config, kind, scope, { sitesFile }).hash !== input.hash) throw new Error('Survey scope inputs changed during the worker call');
      const response = finished.findLast(p => p.response)?.response ?? {};
      writeJSON(safePath(root, unit.target), { schemaVersion: 1, kind, scope: { id: scope.id, files: scope.files }, inputHash: input.hash, runId,
        requestedModel: workerModel(config, 'surveyor'), ...(workerEffort(config, 'surveyor') ? { requestedEffort: workerEffort(config, 'surveyor') } : {}), ...(workerContext(config, 'surveyor') ? { requestedContext: workerContext(config, 'surveyor') } : {}), observedModel: response.observedModel ?? null,
        ...(response.modelVerification ? { modelVerification: response.modelVerification } : {}), promptBytes: response.promptBytes ?? null,
        ...(response.cliSessionId ? { cliSessionId: response.cliSessionId } : {}), parts: parts.length,
        partReceipts: finished.map(p => ({ requestHash: hash(p.input.text), ...(p.fragment ? { fragment: p.fragment } : {}), ...(p.mechanical ? { mechanical: 'oversized-source' } : {}) })),
        ...(finished.some(p => p.mechanical) ? { unsurveyedOversizedFiles: finished.filter(p => p.mechanical).map(p => p.scope.files[0]) } : {}),
        ...(items.some(i => i.uncited) ? { uncited: items.filter(i => i.uncited).length } : {}),
        ...(finished.some(p => p.dropped) ? { droppedFacts: finished.reduce((n, p) => n + (p.dropped ?? 0), 0) } : {}),
        ...(finished.some(p => p.lostAnswer) ? { droppedAnswers: finished.filter(p => p.lostAnswer).length } : {}), finishedAt: stamp(), items });
      // Totals for this run's report: what the review package must mention.
      unresolved.uncited += items.filter(i => i.uncited).length;
      unresolved.droppedFacts += finished.reduce((n, p) => n + (p.dropped ?? 0), 0);
      unresolved.droppedAnswers += finished.filter(p => p.lostAnswer).length;
      unresolved.unsurveyedOversizedFiles.push(...finished.filter(p => p.mechanical).map(p => p.scope.files[0]));
      fs.rmSync(safePath(root, partialPath), { force: true });
      completed.push(scope.id); active.delete(scope.id); progress('running'); onProgress({ unit: scope.id, stage: 'done', calls });
    };
    const running = new Set();
    for (const job of queue) {
      if (signal?.aborted || systemic) break;
      while (running.size >= config.concurrency) await Promise.race(running);
      if (signal?.aborted || systemic) break;
      const p = runOne(job).catch(e => errors.push({ scope: job.scope.id, error: e.message })).finally(() => { active.delete(job.scope.id); running.delete(p); progress('running'); });
      running.add(p);
    }
    await Promise.all(running);
    const status = surveyStatus(root, config, kind, { maxFiles, sitesFile });
    const report = { runId, kind, executionMode: config.executionMode ?? 'continuous', ...(ignoredLimits(config).length ? { ignoredLimits: ignoredLimits(config) } : {}), startedAt, finishedAt: stamp(), agentCalls: calls, completed, done: status.done, total: status.total,
      complete: status.complete, skipped: status.skipped, errors,
      ...(unresolved.uncited ? { uncited: unresolved.uncited } : {}), ...(unresolved.droppedFacts ? { droppedFacts: unresolved.droppedFacts } : {}), ...(unresolved.droppedAnswers ? { droppedAnswers: unresolved.droppedAnswers } : {}),
      ...(unresolved.unsurveyedOversizedFiles.length ? { unsurveyedOversizedFiles: unresolved.unsurveyedOversizedFiles } : {}), next: status.skipped.length
      ? `${status.skipped.length} source or census inputs need attention; inspect skipped reasons, correct missing/out-of-root paths or prepare valid UTF-8 input. Completed scopes are preserved; resume the same survey after correcting the inputs.`
      : status.complete
      ? `All scopes done. Run survey merge --kind ${kind}${kind === 'inventory' ? ` --sites ${sitesFile}` : ''}, then review the merged draft in phase ${spec.phase}.`
      : `Resume with survey run --kind ${kind}; only scopes without a current result run again.` };
    writeJSON(safePath(root, `${surveyRoot}/${kind}/runs/${runId}.json`), report);
    recordCost(root, costEvent({ id: `survey-${runId}`, step: spec.phase, startedAt, finishedAt: report.finishedAt, subagents: calls, tokens: null, model: null }));
    if (errors.length || status.skipped.length || signal?.aborted) {
      const message = [...errors.map(e => `${e.scope}: ${e.error}`), ...status.skipped.slice(0, 5).map(s => `${s.file}: ${s.reason}`),
        ...(status.skipped.length > 5 ? [`${status.skipped.length - 5} more unreadable files; see skipped in ${surveyRoot}/${kind}/runs/${runId}.json`] : [])].join('; ');
      throw Object.assign(new Error(`Survey stopped: ${message || 'Interrupted'}`), { report });
    }
    return report;
  } finally { clearInterval(heartbeat); try { progress('stopped'); } finally { release(); } }
}

// Merge every current scope result into the phase's draft artifact.
export function mergeSurvey(root, config, kind, { maxFiles, sitesFile } = {}) {
  requireKind(kind);
  const plan = planSurvey(root, config, kind, { maxFiles, sitesFile });
  if (plan.skipped.length) throw new Error(`Survey incomplete: ${plan.skipped.length} source files could not be read or found (${plan.skipped.slice(0, 5).map(s => s.file).join(', ')}); inspect skipped reasons, correct paths or prepare valid UTF-8 input and resume. Completed scopes are preserved.`);
  const results = plan.scopes.map(scope => current(root, kind, scope, surveyInput(root, config, kind, scope, { sitesFile })));
  const missing = plan.scopes.filter((s, i) => !results[i]).map(s => s.id);
  if (missing.length) throw new Error(`Survey incomplete: ${missing.length} of ${plan.scopes.length} scopes have no current result (${missing.slice(0, 10).join(', ')}); resume survey run --kind ${kind}`);
  const items = results.flatMap(r => r.items);
  // Survey-wide counts the review package must report, summed from every
  // scope record (a run report covers only the scopes that run finished).
  const sum = key => results.reduce((n, r) => n + (r[key] ?? 0), 0);
  const unresolved = { ...(items.some(i => i.uncited) ? { uncited: items.filter(i => i.uncited).length } : {}),
    ...(sum('droppedFacts') ? { droppedFacts: sum('droppedFacts') } : {}), ...(sum('droppedAnswers') ? { droppedAnswers: sum('droppedAnswers') } : {}),
    ...(results.some(r => r.unsurveyedOversizedFiles?.length) ? { unsurveyedOversizedFiles: results.flatMap(r => r.unsurveyedOversizedFiles ?? []) } : {}) };
  if (kind === 'facts') {
    const out = `${surveyRoot}/facts.md`;
    const lines = ['# Source survey facts (draft for phase 00)', '', `${items.length} facts from ${plan.scopes.length} scopes; each cites PATH:LINE. Verify before relying on a fact.`, ''];
    for (const category of factCategories) {
      const list = items.filter(i => i.category === category);
      if (!list.length) continue;
      lines.push(`## ${category} (${list.length})`, '', ...list.map(i => `- ${i.summary} — ${i.evidence}`), '');
    }
    atomicWrite(safePath(root, out), `${lines.join('\n')}\n`);
    return { kind, out, items: items.length, scopes: plan.scopes.length, ...unresolved };
  }
  if (kind === 'contracts') {
    const target = 'migration/source-spec/contracts.md', file = safePath(root, target);
    // Never overwrite contracts a person already edited: only a missing file or
    // the skeleton exactly as source-spec init drafts it. Any change goes to a draft.
    // Since 0.10.0 source-spec init drafts no memo, so a missing file is not
    // part of any plan: the merge then writes only the draft.
    const replace = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === `${legacyContractsSkeleton(config, sourceSpecPlan(root, config).sources)}\n`;
    const out = replace ? target : `${surveyRoot}/contracts.draft.md`;
    const body = [`# Source-derived contracts (${config.sourceLanguage} -> ${config.targetLanguage})`, '',
      'The source code is the only specification. Every statement below cites source lines; expectations are inferred, never observed on the original runtime.', '',
      ...items.sort((a, b) => a.file < b.file ? -1 : 1).flatMap(i => [`## ${i.file}`, '', `- Public interface: ${i.publicInterface}`, `- Inputs, outputs and errors: ${i.inputsOutputsErrors}`,
        `- Edge cases and numeric/text semantics: ${i.edgeCases}`, `- Evidence (source lines): ${i.evidence}`, `- Unknowns: ${i.unknowns}`, ''])].join('\n');
    atomicWrite(safePath(root, out), `${body}\n`);
    return { kind, out, items: items.length, scopes: plan.scopes.length, ...unresolved, ...(replace ? {} : { note: fs.existsSync(file) ? `${target} has edits, so the merged draft went to ${out}; reconcile it by hand` : `No contract memo is part of the plan (source-spec init no longer drafts one), so the merge went to ${out}` }) };
  }
  const shards = results.map(r => {
    const shard = `migration/inventory-shards/survey-${r.scope.id}.tsv`;
    atomicWrite(safePath(root, shard), `${inventoryHeader}\n${r.items.map(i => [i.file, i.symbol, i.source_construct, i.classification, i.target_translation, i.evidence, i.status].join('\t')).join('\n')}\n`);
    return shard;
  });
  return { kind, shards, ...mergeInventory(root, config, { shards, sites: sitesFile }), ...unresolved };
}
