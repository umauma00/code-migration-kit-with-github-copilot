// SPDX-License-Identifier: Apache-2.0
// Delegated preparation surveys. The parent no longer reads the whole codebase
// into its own context for phases 00/00b/02: the source is split into scopes
// (directory, then size), each scope goes to a fresh tool-free "surveyor"
// worker (a new Copilot CLI process, or a host subagent in native mode) with a
// frozen input, and every answer lands in its own file. Done-ness is the file
// on disk bound to the scope's input hash (upstream rule 2), so runs resume.
// Results are drafts for the phase's own reviews and the human gate; merging
// them never records a phase.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { safePath, readJSON, writeJSON, atomicWrite, fileHash, filesUnder, hash, stamp, lockRun, inside, workerModel } from './core.mjs';
import { readReviewText } from './review.mjs';
import { isTransientFailure, isSystemicFailure, retryDelayMs } from './failures.mjs';
import { costEvent, recordCost } from './cost.mjs';
import { mergeInventory } from './preparation.mjs';
import { sourceSpecPlan } from './source-spec.mjs';

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
const anchors = text => [...String(text ?? '').matchAll(/([A-Za-z0-9_.\/-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+):(\d+)/g)].map(m => m[1].replace(/^\.\//, ''));

function sites(root, config, sitesFile) {
  if (!sitesFile?.startsWith('migration/')) throw new Error('The inventory survey needs a mechanical site census: --sites migration/PATH.tsv (file<TAB>symbol<TAB>source_construct)');
  const lines = readReviewText(root, sitesFile).replace(/^﻿/, '').split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  if (lines.shift() !== 'file\tsymbol\tsource_construct') throw new Error(`Unexpected TSV header: ${sitesFile}`);
  return lines.map(l => { const [file, symbol, construct] = l.split('\t'); return { file, symbol, source_construct: construct }; });
}

// Deterministic scopes: files of one directory stay together, split by count
// and by the frozen-input byte budget the workers receive.
export function planSurvey(root, config, kind, { maxFiles = 20, sitesFile } = {}) {
  maxFiles ??= 20;
  requireKind(kind);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 200) throw new Error('--max-files must be an integer from 1 to 200');
  const limit = config.maxReviewInputBytes ?? 65536;
  const shared = kind === 'inventory' ? Buffer.byteLength(readReviewText(root, 'migration/RULEBOOK.md')) : 0;
  const census = kind === 'inventory' ? sites(root, config, sitesFile) : null;
  // Group by directory first so one directory's files stay in adjacent scopes.
  const files = [...new Set(config.sourceRoots.flatMap(dir => filesUnder(root, dir)))]
    .filter(p => !census || census.some(s => s.file === p))
    .sort((a, b) => { const da = path.posix.dirname(a), db = path.posix.dirname(b); return da === db ? (a < b ? -1 : a > b ? 1 : 0) : (da < db ? -1 : 1); });
  const skipped = [], scopes = [];
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
  return plan;
}

export function surveyInput(root, config, kind, scope, { sitesFile } = {}) {
  const spec = requireKind(kind);
  const census = kind === 'inventory' ? sites(root, config, sitesFile).filter(s => scope.files.includes(s.file)) : undefined;
  const text = JSON.stringify({ schemaVersion: 1, kind, task: spec.task(config.targetLanguage),
    ...(kind === 'inventory' ? { rulebook: readReviewText(root, 'migration/RULEBOOK.md'), sites: census } : {}),
    files: scope.files.map(p => ({ path: p, content: readReviewText(root, p) })), scope: scope.id, sourceLanguage: config.sourceLanguage, targetLanguage: config.targetLanguage });
  return { text, hash: hash(text), sites: census };
}

function validateItems(kind, scope, items, census) {
  if (!Array.isArray(items)) throw new Error('Survey result requires an items array');
  const inScope = p => scope.files.includes(p);
  const cited = item => anchors(item.evidence).some(inScope);
  const text = (v, f) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`Survey item requires ${f}`); };
  for (const item of items) {
    text(item?.file, 'file'); text(item.evidence, 'evidence');
    if (!inScope(item.file)) throw new Error(`Survey item outside its scope: ${item.file}`);
    if (!cited(item)) throw new Error(`Survey item must cite PATH:LINE inside its scope: ${item.file}`);
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

const current = (root, kind, scope, inputHash) => {
  try { const r = readJSON(safePath(root, resultPath(kind, scope.id))); return r?.schemaVersion === 1 && r.inputHash === inputHash && r.kind === kind ? r : null; }
  catch { return null; }
};

export function surveyStatus(root, config, kind, options = {}) {
  const plan = planSurvey(root, config, kind, options);
  const scopes = plan.scopes.map(scope => {
    const { hash: inputHash } = surveyInput(root, config, kind, scope, options);
    const done = current(root, kind, scope, inputHash);
    return { id: scope.id, files: scope.files.length, status: done ? 'done' : scope.tooLarge ? 'too-large' : 'pending', ...(done ? { items: done.items.length } : {}) };
  });
  return { kind, total: scopes.length, done: scopes.filter(s => s.status === 'done').length, scopes, skipped: plan.skipped };
}

// The worker sees the scope as the unit: unit.target is the result file the
// coordinator writes, so the usual "never take a destination from model
// output" rule holds. Failures block only their scope; systemic ones stop all.
export async function runSurvey(root, config, kind, adapter, { signal, onProgress = () => {}, maxFiles, sitesFile } = {}) {
  const spec = requireKind(kind);
  const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, startedAt = stamp();
  const release = lockRun(root, 'survey', { runId });
  let calls = 0, reservations = 0, systemic = null;
  const errors = [], completed = [];
  try {
    const plan = planSurvey(root, config, kind, { maxFiles, sitesFile });
    writeJSON(safePath(root, `${surveyRoot}/${kind}/plan.json`), plan);
    const queue = [];
    for (const scope of plan.scopes) {
      const input = surveyInput(root, config, kind, scope, { sitesFile });
      if (current(root, kind, scope, input.hash)) continue;
      if (scope.tooLarge) { errors.push({ scope: scope.id, error: `Review input exceeds maxReviewInputBytes for survey scope ${scope.id}; raise maxReviewInputBytes after checking model capacity, or split the directory` }); continue; }
      queue.push({ scope, input });
    }
    const runOne = async ({ scope, input }) => {
      const unit = { id: `survey-${kind}-${scope.id}`, source: scope.id, target: resultPath(kind, scope.id) };
      for (let retry = 0; ; retry++) {
        if (signal?.aborted) throw new Error('Interrupted');
        if (systemic) throw systemic;
        if (reservations >= config.maxAgentCalls) throw new Error('Agent call limit reached; resume with a new run after reviewing usage');
        reservations++; calls++;
        try {
          onProgress({ unit: scope.id, stage: retry ? `surveyor retry ${retry}` : 'surveyor', calls });
          const response = await adapter({ root, config, role: 'surveyor', unit, extra: { survey: { kind, scope: scope.id, maxFiles: plan.maxFiles, ...(sitesFile ? { sitesFile } : {}) } }, signal, reviewInput: input.text, context: input.hash, runId });
          const result = response.result;
          if (result?.schemaVersion !== 1 || result.kind !== 'survey' || result.survey !== kind || result.target !== unit.target) throw new Error('Invalid survey result: schemaVersion/kind/survey/target mismatch');
          const items = validateItems(kind, scope, result.items, input.sites);
          // Inputs must not have changed while the worker ran.
          if (surveyInput(root, config, kind, scope, { sitesFile }).hash !== input.hash) throw new Error('Survey scope inputs changed during the worker call');
          writeJSON(safePath(root, unit.target), { schemaVersion: 1, kind, scope: { id: scope.id, files: scope.files }, inputHash: input.hash, runId,
            requestedModel: workerModel(config, 'surveyor'), observedModel: response.observedModel ?? null, ...(response.modelVerification ? { modelVerification: response.modelVerification } : {}),
            promptBytes: response.promptBytes ?? null, finishedAt: stamp(), items });
          completed.push(scope.id); onProgress({ unit: scope.id, stage: 'done', calls });
          return;
        } catch (e) {
          if (isSystemicFailure(e)) { systemic ??= e; throw e; }
          if (!isTransientFailure(e) || retry >= (config.transientRetries ?? 2) || signal?.aborted) throw e;
          await sleep(retryDelayMs(config, retry), undefined, { signal }).catch(() => { throw new Error('Interrupted'); });
        }
      }
    };
    const running = new Set();
    for (const job of queue) {
      if (signal?.aborted || systemic) break;
      while (running.size >= config.concurrency) await Promise.race(running);
      const p = runOne(job).catch(e => errors.push({ scope: job.scope.id, error: e.message })).finally(() => running.delete(p));
      running.add(p);
    }
    await Promise.all(running);
    const status = surveyStatus(root, config, kind, { maxFiles, sitesFile });
    const report = { runId, kind, startedAt, finishedAt: stamp(), agentCalls: calls, completed, done: status.done, total: status.total, errors, next: status.done === status.total
      ? `All scopes done. Run survey merge --kind ${kind}${kind === 'inventory' ? ` --sites ${sitesFile}` : ''}, then review the merged draft in phase ${spec.phase}.`
      : `Resume with survey run --kind ${kind}; only scopes without a current result run again.` };
    writeJSON(safePath(root, `${surveyRoot}/${kind}/runs/${runId}.json`), report);
    recordCost(root, costEvent({ id: `survey-${runId}`, step: spec.phase, startedAt, finishedAt: report.finishedAt, subagents: calls, tokens: null, model: null }));
    if (errors.length || signal?.aborted) throw new Error(`Survey stopped: ${errors.map(e => `${e.scope}: ${e.error}`).join('; ') || 'Interrupted'}`);
    return report;
  } finally { release(); }
}

// Merge every current scope result into the phase's draft artifact.
export function mergeSurvey(root, config, kind, { maxFiles, sitesFile } = {}) {
  requireKind(kind);
  const plan = planSurvey(root, config, kind, { maxFiles, sitesFile });
  const results = plan.scopes.map(scope => current(root, kind, scope, surveyInput(root, config, kind, scope, { sitesFile }).hash));
  const missing = plan.scopes.filter((s, i) => !results[i]).map(s => s.id);
  if (missing.length) throw new Error(`Survey incomplete: ${missing.length} of ${plan.scopes.length} scopes have no current result (${missing.slice(0, 10).join(', ')}); resume survey run --kind ${kind}`);
  const items = results.flatMap(r => r.items);
  if (kind === 'facts') {
    const out = `${surveyRoot}/facts.md`;
    const lines = ['# Source survey facts (draft for phase 00)', '', `${items.length} facts from ${plan.scopes.length} scopes; each cites PATH:LINE. Verify before relying on a fact.`, ''];
    for (const category of factCategories) {
      const list = items.filter(i => i.category === category);
      if (!list.length) continue;
      lines.push(`## ${category} (${list.length})`, '', ...list.map(i => `- ${i.summary} — ${i.evidence}`), '');
    }
    atomicWrite(safePath(root, out), `${lines.join('\n')}\n`);
    return { kind, out, items: items.length, scopes: plan.scopes.length };
  }
  if (kind === 'contracts') {
    const target = 'migration/source-spec/contracts.md', file = safePath(root, target);
    // Never overwrite contracts a person already edited: only a missing file or
    // the skeleton exactly as source-spec init drafts it. Any change goes to a draft.
    const replace = !fs.existsSync(file) || fs.readFileSync(file, 'utf8') === `${sourceSpecPlan(root, config).contracts}\n`;
    const out = replace ? target : `${surveyRoot}/contracts.draft.md`;
    const body = [`# Source-derived contracts (${config.sourceLanguage} -> ${config.targetLanguage})`, '',
      'The source code is the only specification. Every statement below cites source lines; expectations are inferred, never observed on the original runtime.', '',
      ...items.sort((a, b) => a.file < b.file ? -1 : 1).flatMap(i => [`## ${i.file}`, '', `- Public interface: ${i.publicInterface}`, `- Inputs, outputs and errors: ${i.inputsOutputsErrors}`,
        `- Edge cases and numeric/text semantics: ${i.edgeCases}`, `- Evidence (source lines): ${i.evidence}`, `- Unknowns: ${i.unknowns}`, ''])].join('\n');
    atomicWrite(safePath(root, out), `${body}\n`);
    return { kind, out, items: items.length, scopes: plan.scopes.length, ...(replace ? {} : { note: `${target} has edits, so the merged draft went to ${out}; reconcile it by hand` }) };
  }
  const shards = results.map(r => {
    const shard = `migration/inventory-shards/survey-${r.scope.id}.tsv`;
    atomicWrite(safePath(root, shard), `${inventoryHeader}\n${r.items.map(i => [i.file, i.symbol, i.source_construct, i.classification, i.target_translation, i.evidence, i.status].join('\t')).join('\n')}\n`);
    return shard;
  });
  return { kind, shards, ...mergeInventory(root, config, { shards, sites: sitesFile }) };
}
