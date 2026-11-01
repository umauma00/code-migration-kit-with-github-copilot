// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pluginRoot } from './runtime.mjs';
import { safePath, readJSON, writeJSON, fileHash, filesUnder, treeHash, hash, stamp, contextHash, contextParts, sourceOnlyPlan, pathMemo, readManifest, loadReviewDependencies, reviewDependencyPath, specPlaceholder, missingRootMessage, evidenceHash, saveRulebookVersion, rulebookFile } from './core.mjs';
import { costEvent, recordCost } from './cost.mjs';
import { judgeInputHash } from './judge.mjs';
import { readPreferences } from './preferences.mjs';
import { autoModeOn } from './auto-mode.mjs';

export const orderedPhases = ['00', '00b', '01', '02', '03', '04', '05', '05b', '05c', '06'];
const manual = new Set(['00', '00b', '01', '02', '03']);
const receiptPath = (root, phase) => safePath(root, `migration/phases/${phase}.json`);
const startPath = (root, phase) => safePath(root, `migration/phases/starts/${phase}.json`);
// Whether the phase was ever recorded, current or not.
export const phaseRecorded = (root, phase) => fs.existsSync(receiptPath(root, phase));
const waiverPath = (root, phase) => safePath(root, `migration/phases/waivers/${phase}.json`);
// Phases a waiver can stand in for. 06 is the end of the migration: nothing
// follows it to proceed to.
export const waivablePhases = orderedPhases.filter(id => id !== '06');

// Relaxed mode (preferences phaseMode). Normal mode never reads a waiver, so
// everything below is inert there and every check stays as strict as before.
export function relaxedPhases(root) {
  try { return ['relaxed', 'auto'].includes(readPreferences(root).phaseMode); } catch { return false; }
}
// Auto mode: relaxed without the person. Records it makes carry auto: true.
// Only with its deviation record (written when the person chose auto), so a
// hand-edited preferences file never turns it on.
export function autoPhases(root) {
  return autoModeOn(root);
}
// The waiver that lets relaxed mode proceed past an unfinished phase, with
// the hash later records bind to: a waiver rewritten later no longer vouches
// for them. A completed phase never needs its waiver.
export function phaseWaiver(root, phase) {
  if (!waivablePhases.includes(phase) || !relaxedPhases(root)) return false;
  const file = waiverPath(root, phase);
  if (!fs.existsSync(file)) return false;
  let value;
  try { value = readJSON(file); } catch { return false; }
  if (value?.schemaVersion !== 1 || value.phase !== phase || !value.note?.trim()) return false;
  return { ...value, hash: fileHash(file) };
}
// A gate failure. In relaxed mode it names the phase whose waiver would let
// the work proceed, so the parent can ask the person: fix it, or proceed.
export function gateError(root, message, phase) {
  if (!relaxedPhases(root) || !waivablePhases.includes(phase)) return new Error(message);
  const error = new Error(autoPhases(root)
    ? `${message} Relaxed mode (auto): if the phase's own work cannot supply it, proceed without asking; record why with phase waive ${phase} --note TEXT, then retry.`
    : `${message} Relaxed mode: ask the person whether to fix this first or proceed without it; to proceed, record their reason with phase waive ${phase} --note TEXT.`);
  error.waivablePhase = phase;
  return error;
}
export function strictPhases(root, config) {
  const policy = safePath(root, 'migration/phases/policy.json');
  if (fs.existsSync(policy)) {
    const value = readJSON(policy);
    if (value.schemaVersion !== 1 || value.policy !== 'strict') throw new Error('Invalid phase policy record');
    return true;
  }
  return config.phasePolicy === 'strict';
}
export function initializePhases(root) {
  const policy = safePath(root, 'migration/phases/policy.json');
  if (fs.existsSync(policy)) {
    const old = readJSON(policy);
    if (old.schemaVersion !== 1 || old.policy !== 'strict') throw new Error('Invalid existing phase policy');
    return old;
  }
  const value = { schemaVersion: 1, policy: 'strict', createdAt: stamp() };
  writeJSON(policy, value); return value;
}
function foundation(root, config, read) {
  return foundationRead(root, config, read).value;
}
// The fingerprint and its two parts: the source tree and the settings.
function foundationRead(root, config, read) {
  if (read?.foundationParts !== undefined) return read.foundationParts;
  for (const p of config.sourceRoots) if (!fs.existsSync(safePath(root, p))) throw new Error(missingRootMessage(config, p, 'Input root missing'));
  const source = treeHash(root, config.sourceRoots, pathMemo()), settings = { sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage, mode: config.mode, verificationMode: config.verificationMode ?? 'runtime',
    sourceRoots: config.sourceRoots, outputRoots: config.outputRoots, verificationRoots: config.verificationRoots };
  const value = { value: hash(JSON.stringify({ source, ...settings })), parts: { source, settings: hash(JSON.stringify(settings)) } };
  if (read) read.foundationParts = value;
  return value;
}
function artifacts(config, phase) {
  const paths = { '00':['migration/feasibility.md'], '00b':['migration/judge-report.md'],
    '01':['migration/depmap/report.md', 'migration/manifest.tsv', reviewDependencyPath(config)],
    '02':['migration/gap-report.md', 'migration/RULEBOOK.md', 'migration/inventory.tsv', 'migration/manifest.tsv', reviewDependencyPath(config)],
    '03':['migration/stress-test/report.md', 'migration/results/judge.json'],
    '05c':['migration/results/smoke.json'], '06':['migration/handoff.md', 'migration/results/parity.json'] }[phase];
  return paths.concat(phase === '01' && config.packageMap ? [config.packageMap, 'migration/depmap/package-cycles.json'] : []);
}
export function currentPhase(root, config, phase, read) {
  const file = receiptPath(root, phase);
  if (!fs.existsSync(file)) return false;
  const r = readJSON(file);
  if (r?.schemaVersion !== 1 || r.phase !== phase || !r.executionId || !r.note?.trim() || r.foundation !== foundation(root, config, read) || !Array.isArray(r.evidence) || !r.evidence.length) return false;
  if (r.evidence.some(([p, h]) => !h || evidenceHash(root, p) !== h)) return false;
  // A read-only report reuses one judge fingerprint across the predecessor chains.
  if (phase === '00b' && r.judgeInputHash && r.judgeInputHash !== (read ? (read.judgeInput ??= judgeInputHash(root, config)) : judgeInputHash(root, config))) return false;
  if (phase === '05c' && (config.verificationMode !== 'source-only' || r.outcome !== 'not-applicable' || r.equivalence !== 'unverified')) return false;
  const index = orderedPhases.indexOf(phase);
  if (index < 0) return false;
  // A predecessor is its current receipt, or in relaxed mode the waiver the
  // record was made under. Completing a waived phase later (or leaving relaxed
  // mode) changes that hash, so records made on the waiver are checked again.
  const predecessorHolds = prev => currentPhase(root, config, prev, read) ? r.predecessorHash === fileHash(receiptPath(root, prev))
    : Boolean(r.predecessorHash) && r.predecessorHash === phaseWaiver(root, prev).hash;
  if (manual.has(phase) && index > 0 && !predecessorHolds(orderedPhases[index - 1])) return false;
  if (['05c','06'].includes(phase) && !predecessorHolds('03')) return false;
  if (['02','03','05c','06'].includes(phase) && r.contextHash !== (read?.contextKnown ? read.context : contextHash(root, config))) return false;
  return r;
}
export function requirePhase(root, config, phase) {
  if (!strictPhases(root, config)) return;
  if (currentPhase(root, config, phase) || phaseWaiver(root, phase)) return;
  let stale = null;
  try { stale = phaseStaleness(root, config, phase); } catch {}
  throw gateError(root, stale ? `Phase ${phase}'s record is out of date. ${stale.next}` : `Phase ${phase} is not reviewed for current inputs. Use phase next; review its artifacts and record phase complete ${phase} --note TEXT before proceeding.`, phase);
}
// The phase is done for real: its waiver moves to waivers/retired/ (kept as
// history), so it never stands in again if the phase later goes stale, and
// records made on it are checked again. Any mode, so a waiver left from
// relaxed mode cannot come back after a switch.
export function retireWaiver(root, phase) {
  const file = waiverPath(root, phase);
  if (!fs.existsSync(file)) return false;
  const retired = safePath(root, `migration/phases/waivers/retired/${phase}-${stamp().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(retired), { recursive: true });
  fs.renameSync(file, retired);
  return true;
}
// The hash a record binds its predecessor to: the receipt, or the waiver.
function predecessorHash(root, config, prev) {
  return currentPhase(root, config, prev) ? fileHash(receiptPath(root, prev)) : phaseWaiver(root, prev).hash ?? fileHash(receiptPath(root, prev));
}
// Records that the person chose to proceed past an unfinished phase. Relaxed
// mode only; unmet says what was missing when they chose.
export function waivePhase(root, config, phase, note, unmet) {
  if (!relaxedPhases(root)) throw new Error('phase waive is available only in relaxed mode. Normal mode finishes each phase first; the person can switch with preferences --phase-mode relaxed (or phaseMode in migration/run-settings.json)');
  if (!waivablePhases.includes(phase)) throw new Error(`Phase ${phase} cannot be waived; waivable phases: ${waivablePhases.join(', ')}`);
  if (!note?.trim()) throw new Error('phase waive requires --note with the person\'s reason for proceeding');
  if (currentPhase(root, config, phase)) return { phase, waived: false, complete: true };
  // Auto mode keeps a waiver the person recorded instead of replacing it.
  const old = autoPhases(root) && phaseWaiver(root, phase);
  if (old && !old.auto) return { ...old, waived: true, kept: true };
  const value = { schemaVersion: 1, phase, note: note.trim(), waivedAt: stamp(), ...(unmet ? { unmet } : {}), ...(autoPhases(root) ? { auto: true } : {}) };
  writeJSON(waiverPath(root, phase), value);
  return { ...value, waived: true };
}
// Waivers that still stand in for an unfinished phase, for status and the
// handoff report. done tells which phases are complete now.
export function activeWaivers(root, done = {}) {
  return waivablePhases.filter(id => !done[id]).map(id => phaseWaiver(root, id)).filter(Boolean)
    .map(({ phase, note, waivedAt, unmet, auto }) => ({ phase, note, waivedAt, ...(unmet ? { unmet } : {}), ...(auto ? { auto } : {}) }));
}
export function checkPreparation(root, config, phase, { completing = false } = {}) {
  const index = orderedPhases.indexOf(phase);
  if (index < 0) throw new Error('Unknown phase; use 00, 00b, 01, 02, 03, 04, 05, 05b, 05c, 06');
  // Source-as-spec drafts 00b, 01 and 02 as one package and records them
  // together after one review, so 01 and 02 start once 00 is reviewed.
  // Completion still checks every package phase in order.
  if (!completing && config.preparationProfile === 'source-as-spec' && ['01', '02'].includes(phase)) { requirePhase(root, config, '00'); return; }
  if (index > 0) requirePhase(root, config, orderedPhases[Math.min(index - 1, 4)]);
}
export function startPhase(root, config, phase) {
  checkPreparation(root, config, phase);
  const value = { schemaVersion:1, phase, executionId:crypto.randomUUID(), startedAt:stamp(), foundation:foundation(root, config) };
  writeJSON(startPath(root, phase), value); return value;
}
// dryRun runs every check without writing. assumePredecessor skips the
// predecessor-receipt check when that predecessor is validated in the same
// dry run, so a multi-phase completion is checked whole before anything is written.
// Phase 02 reviews rules written for this project. The installed templates are
// nonempty, so an existence check alone would let them pass as reviewed rules.
function requireDraftedRules(root) {
  const read = rel => fs.readFileSync(safePath(root, rel), 'utf8');
  const template = rel => fs.readFileSync(path.join(pluginRoot, 'templates', rel), 'utf8');
  const rulebook = read('migration/RULEBOOK.md');
  if (rulebook === template('RULEBOOK.md') || /\[source language\]|\[target language\]/.test(rulebook)) throw new Error('migration/RULEBOOK.md is still the installed template (its [source language] / [target language] placeholders remain). Draft the project rules before phase 02 review');
  const examples = template('inventory.tsv').split(/\r?\n/).slice(2).filter(Boolean);
  const inventory = read('migration/inventory.tsv').split(/\r?\n/);
  if (examples.some(row => inventory.includes(row))) throw new Error('migration/inventory.tsv still contains the template example rows. Replace them with this project\'s sites before phase 02 review');
}
export function completePhase(root, config, phase, note, {tokens, subagents, model} = {}, {dryRun = false, assumePredecessor = false, confirmNoDependencies = false} = {}) {
  if (!note?.trim()) throw new Error('Phase completion requires a concrete review --note');
  if (!assumePredecessor) checkPreparation(root, config, phase, { completing: true });
  if (!manual.has(phase) && phase !== '05c' && phase !== '06') throw new Error('This phase is completed by current runner receipts, not manual confirmation');
  if (phase === '05c' && config.verificationMode !== 'source-only') throw new Error('Runtime parity requires actual runner validation');
  if (phase === '06' && config.verificationMode === 'source-only') throw new Error('Source-only phase 06 requires the handoff runner receipt');
  const old = currentPhase(root, config, phase);
  // An auto receipt is recorded again when the person completes the phase
  // outside auto mode, so their review replaces it.
  if (old && !(old.auto && !autoPhases(root))) { if (old.cost && !dryRun) recordCost(root, old.cost); return old; }
  const evidence = artifacts(config, phase).map(p => {
    const f = safePath(root, p);
    if (!fileHash(f) || fs.statSync(f).size === 0) throw new Error(`Nonempty phase artifact required: ${p}`);
    return [p, evidenceHash(root, p)];
  });
  if (phase === '00b') {
    if (config.verificationMode === 'source-only') {
      const { plan, files } = sourceOnlyPlan(root, config);
      // A drafted contract skeleton is not a reviewed specification.
      // The TODO(spec) skeleton exists only in source-as-spec; other source-only
      // plans may legitimately contain the literal text.
      const unfilled = config.preparationProfile !== 'source-as-spec' ? [] : plan.scenarios.map(s => s.path).filter(p => fs.readFileSync(safePath(root, p), 'utf8').includes(specPlaceholder));
      if (unfilled.length) throw new Error(`Source-derived contracts still contain ${specPlaceholder}: ${unfilled.join(', ')}. Fill every item from cited source lines before phase 00b review`);
      evidence.push(...files);
    }
    else if (!config.commands?.original || !config.commands?.mutation || !config.commands?.parity || !config.verificationRoots.some(p => fs.existsSync(safePath(root,p)))) throw new Error('Prepare runtime judge inputs and original/mutation/parity commands before phase 00b review');
  }
  if (phase === '01') {
    const units = readManifest(root, config);
    if (!units.length) throw new Error('Manifest is empty');
    const graph = loadReviewDependencies(root, config);
    // An all-empty map usually means the parser ran from the wrong --root
    // (imports unresolved), which silently starves reviewers of dependency
    // sources. Independent files are possible, so the person can confirm it.
    if (units.length > 1 && Object.values(graph).every(deps => !deps.length) && !confirmNoDependencies) {
      throw new Error(`Review dependency map declares no dependencies between ${units.length} manifest files. This usually means the dependency parser ran from the wrong --root and could not resolve imports. Check migration/depmap/edges.tsv; if the files really are independent, record phase 01 with --confirm-no-dependencies`);
    }
  }
  if (phase === '02') requireDraftedRules(root);
  // The hashes validate their inputs too (e.g. review dependency declarations),
  // so a dry run computes them: a multi-phase package fails before any write.
  const judgeHash = phase === '00b' ? judgeInputHash(root, config) : null;
  const contextRead = ['02','03','05c','06'].includes(phase) ? contextParts(root, config, true) : null, context = contextRead?.hash ?? null;
  if (dryRun) return { phase, checked: true };
  const index = orderedPhases.indexOf(phase), finishedAt = stamp(), executionId = crypto.randomUUID();
  const start = fs.existsSync(startPath(root, phase)) ? readJSON(startPath(root, phase)) : null;
  const { value: currentFoundation, parts: foundationParts } = foundationRead(root, config);
  const value = { schemaVersion:1, phase, executionId, note:note.trim(), completedAt:finishedAt, foundation:currentFoundation, foundationParts, evidence,
    // judgeInputSchema 2 (0.40.1): the kit's own files are not hashed.
    ...(phase === '00b' ? { judgeInputHash: judgeHash, judgeInputSchema: 2 } : {}),
    ...(manual.has(phase) && index > 0 ? { predecessorHash:predecessorHash(root, config, orderedPhases[index-1]) } : ['05c','06'].includes(phase) ? {predecessorHash:predecessorHash(root, config, '03')} : {}),
    ...(context ? {contextHash:context, contextParts:contextRead.parts} : {}),
    ...(phase === '05c' ? {outcome:'not-applicable',equivalence:'unverified'} : {}),
    ...(phase === '01' && confirmNoDependencies ? {confirmedNoDependencies:true} : {}),
    // Auto mode records completion without the person's review; say so.
    ...(autoPhases(root) ? {auto:true} : {}) };
  // Replacing an auto receipt keeps its cost row: the work was done once.
  if (old?.auto && old.cost) value.cost = old.cost;
  else if (manual.has(phase) || phase === '05c' || phase === '06') value.cost = costEvent({id:`phase-${executionId}`,step:phase,finishedAt,
    startedAt:start?.foundation === currentFoundation ? start.startedAt : null,tokens,subagents,model});
  writeJSON(receiptPath(root, phase), value);
  // The reviewed rules are kept, so a later change can be shown as a diff.
  if (phase === '02') saveRulebookVersion(root);
  retireWaiver(root, phase);
  if (value.cost) recordCost(root, value.cost);
  return value;
}

// Why a recorded phase is no longer current, so the next step can say what
// changed instead of only "not reviewed for current inputs". Read-only; null
// when the phase has no record or its record is current.
const contextNames = { config: 'migration/config.json settings', configFile: 'migration/config.json settings', sourceOnlyPlan: 'files of the source-only judge plan',
  source: 'source files', judge: 'verification files', packageMap: 'the package map', reviewDependencies: 'the review dependency map or a file it names',
  manifestSources: 'manifest source files', verificationInputs: 'verification inputs', rulebook: 'migration/RULEBOOK.md', artifacts: 'inventory.tsv or manifest.tsv',
  generatedFiles: 'migration/generated-files.json', runtime: 'kit files (a kit update or a local edit)' };
// Parts of the approved inputs whose change leaves the phase's own work as it
// was: the files it recorded and the kit. Every other part (sources,
// verification files, settings, commands) means its work may no longer hold.
const recordedParts = new Set(['rulebook', 'artifacts', 'reviewDependencies', 'generatedFiles', 'runtime']);
// Settings, verification files and manifest sources outside sourceRoots
// written after a time (file modification times; a checkout counts as written).
function writtenSince(root, config, at) {
  if (!Number.isFinite(at)) return ['(record time unknown)'];
  const memo = pathMemo(), files = new Set(['migration/config.json', ...config.verificationRoots.flatMap(dir => { try { return filesUnder(root, dir, memo); } catch { return []; } })]);
  try { for (const u of readManifest(root, config, undefined, memo)) if (!config.sourceRoots.some(dir => u.source === dir || u.source.startsWith(`${dir.replace(/\/$/, '')}/`))) files.add(u.source); } catch {}
  if (config.packageMap) files.add(config.packageMap);
  return [...files].filter(p => { try { return fs.statSync(safePath(root, p, memo)).mtimeMs > at + 1000; } catch { return false; } }).sort();
}
export function phaseStaleness(root, config, phase, read) {
  const file = receiptPath(root, phase);
  if (!fs.existsSync(file)) return null;
  let r = null, current = false;
  try { r = readJSON(file); current = Boolean(currentPhase(root, config, phase, read)); } catch {}
  if (current) return null;
  const reasons = [];
  if (r?.schemaVersion !== 1 || r.phase !== phase || !r.executionId || !r.note?.trim() || !Array.isArray(r.evidence) || !r.evidence.length || r.evidence.some(e => !Array.isArray(e))) reasons.push({ kind: 'unreadable', what: `migration/phases/${phase}.json (not a valid record)` });
  else {
    const now = foundationRead(root, config, read);
    if (r.foundation !== now.value) {
      const parts = r.foundationParts ? Object.keys(now.parts).filter(k => r.foundationParts[k] !== now.parts[k]) : null;
      for (const k of parts ?? ['source', 'settings']) reasons.push(k === 'source' ? { kind: 'source', what: 'source files under sourceRoots', ...(parts ? {} : { unsure: true }) }
        : { kind: 'settings', what: 'languages, mode or roots in migration/config.json', ...(parts ? {} : { unsure: true }) });
    }
    const files = r.evidence.filter(([p, h]) => !h || evidenceHash(root, p) !== h).map(([p]) => p);
    if (files.length) reasons.push({ kind: 'evidence', what: files.join(', '), files });
    // A record made before 0.40.1 hashed the kit too: the format, not the
    // project, differs, so it is checked and recorded again, not redone.
    if (phase === '00b' && r.judgeInputHash && r.judgeInputHash !== judgeInputHash(root, config)) reasons.push(r.judgeInputSchema === 2
      ? { kind: 'judge-inputs', what: 'judge plan inputs (verification files or commands)' }
      : { kind: 'judge-format', what: 'the judge fingerprint format (made before kit 0.40.1, which no longer hashes the kit)' });
    const index = orderedPhases.indexOf(phase), prev = manual.has(phase) && index > 0 ? orderedPhases[index - 1] : ['05c', '06'].includes(phase) ? '03' : null;
    if (prev) {
      const holds = currentPhase(root, config, prev, read) ? r.predecessorHash === fileHash(receiptPath(root, prev)) : Boolean(r.predecessorHash) && r.predecessorHash === phaseWaiver(root, prev).hash;
      if (!holds) reasons.push({ kind: 'predecessor', what: `phase ${prev}'s record (recorded again or no longer current)`, phase: prev });
    }
    if (['02', '03', '05c', '06'].includes(phase) && r.contextHash !== (read?.contextKnown ? read.context : contextHash(root, config))) {
      let parts = null;
      if (r.contextParts) { const now = contextParts(root, config); parts = [...new Set([...Object.keys(now), ...Object.keys(r.contextParts)])].filter(k => r.contextParts[k] !== now[k]); }
      if (!parts?.length) {
        // A record made before the breakdown: files written since it decide.
        // Settings, verification files or sources outside sourceRoots written
        // after the record mean redo; none written means the kit changed.
        const since = writtenSince(root, config, Date.parse(r.completedAt));
        reasons.push(since.length ? { kind: 'inputs', what: `files written since the record: ${since.slice(0, 5).join(', ')}${since.length > 5 ? ` and ${since.length - 5} more` : ''}`, files: since, unsure: true }
          : { kind: 'recorded-input', what: 'kit files (no settings, verification or other input file was written since the record)', unsure: true });
      }
      else for (const k of parts) reasons.push({ kind: recordedParts.has(k) ? 'recorded-input' : k === 'source' || k === 'manifestSources' ? 'source' : 'inputs', part: k, what: contextNames[k] ?? k });
    }
    if (phase === '05c' && (config.verificationMode !== 'source-only' || r.outcome !== 'not-applicable' || r.equivalence !== 'unverified')) reasons.push({ kind: 'settings', what: 'verification mode' });
  }
  // record-again: only files the phase recorded, an earlier record or the kit
  // changed; check that change and record again. redo: sources, settings or
  // verification inputs changed, or the record is unreadable. check: a record
  // made before the breakdown, where only "something else" is known.
  const action = reasons.some(x => ['source', 'settings', 'judge-inputs', 'unreadable', 'inputs'].includes(x.kind)) ? 'redo' : 'record-again';
  const onlyPredecessor = reasons.length && reasons.every(x => x.kind === 'predecessor');
  const packaged = config.preparationProfile === 'source-as-spec' && ['00b', '01', '02'].includes(phase);
  const record = packaged ? ['00b', '01', '02'].slice(['00b', '01', '02'].indexOf(phase)).join(',') : phase;
  const later = orderedPhases.slice(orderedPhases.indexOf(phase) + 1).filter(id => (manual.has(id) || ['05c', '06'].includes(id)) && !record.split(',').includes(id) && fs.existsSync(receiptPath(root, id)));
  const what = [...new Set(reasons.map(x => x.what))].join('; ');
  const command = ['05c', '06'].includes(phase) && config.verificationMode !== 'source-only' ? `the ${phase === '05c' ? 'parity' : 'post-parity'} run and approval` : `phase complete ${record} --note TEXT`;
  const then = later.length ? `, then phases ${later.join(', ')} in order` : '';
  const ask = 'In auto mode do this without asking. Otherwise ask the person once, recommending it and naming what changed; never ask about the difference between status --fast and phase next.';
  // Only the RULEBOOK changed (and records made on it): the person can accept
  // the change and keep phases 02 and 03, approvals and finished units, sending
  // back only the units it touches.
  const rulebookReason = x => (x.kind === 'evidence' && x.files?.length === 1 && x.files[0] === rulebookFile) || x.part === 'rulebook';
  // Only while 02's own record still names another version: once 02 is
  // recorded again on the new RULEBOOK there is nothing to accept.
  let recorded02 = null;
  try { recorded02 = readJSON(receiptPath(root, '02')).evidence?.find(e => Array.isArray(e) && e[0] === rulebookFile)?.[1] ?? null; } catch {}
  const rulebookOnly = Boolean(recorded02) && recorded02 !== evidenceHash(root, rulebookFile) && orderedPhases.indexOf(phase) >= orderedPhases.indexOf('02') && reasons.some(rulebookReason) && reasons.every(x => rulebookReason(x) || x.kind === 'predecessor');
  if (rulebookOnly) return { phase, reasons, action: 'accept-rulebook', record: 'rulebook accept', next: `Only migration/RULEBOOK.md changed since phase ${phase} was recorded. Show the person what changed and which finished units it may touch with \`rulebook changes\`, then run \`rulebook accept --note TEXT --redo listed|all|none|PATH,...\`: phases 02 and 03, the approvals and every finished unit stay current, and only the units chosen go back to review (the host asks the person to confirm; in auto mode choose listed; for a changed section matching no file, read it and add the files it affects). Recording phase ${phase} again instead makes every finished unit be reviewed again.` };
  const formatOnly = reasons.length && reasons.every(x => x.kind === 'judge-format');
  const next = formatOnly
    ? `Phase ${phase}'s record was made before kit 0.40.1 changed its judge fingerprint; that alone is no project change. Check that the verification files and commands are the reviewed ones (phase check ${record} must pass), then record again with ${command}${then}; finished units and approvals are kept. ${ask}`
    : action === 'redo'
    ? `Phase ${phase} was recorded, then ${what} changed, so its work may no longer hold. Run phase start ${phase} and follow its prompt for what changed (surveys rerun only scopes whose inputs changed), check it, then record again with ${command}${then}. ${ask}`
    : onlyPredecessor
      ? `Phase ${phase}'s own files and the sources are unchanged; only ${what} changed. Check that the new record of phase ${reasons[0].phase} does not change phase ${phase}'s work (phase check ${record} must pass), then record again with ${command}${then}. ${ask}`
      : `Phase ${phase} was recorded, then ${what} changed; the source files, settings and verification files did not. Check only that change (git diff of those files) and fix anything it affects (phase check ${record} must pass), then record again with ${command} (the note says what changed and why it still holds)${then}. This is not a new review of the whole phase. ${ask}`;
  return { phase, reasons, action, record: command, ...(later.length ? { later } : {}), next };
}
