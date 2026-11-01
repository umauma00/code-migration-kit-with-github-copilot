// SPDX-License-Identifier: Apache-2.0
// A RULEBOOK amendment after phase 02, the way upstream handles it: the
// change is the person's, the finished work stays, and only the slice the
// change touches is done again (upstream rule 6). `rulebook changes` shows the
// change against the reviewed version and the finished units it may touch;
// `rulebook accept` (a human gate) records it, so phases 02 and 03, the
// approvals and the finished units stay current, and sends back to review only
// the units the person chose.
import fs from 'node:fs';
import { safePath, readJSON, writeJSON, fileHash, stamp, lockRun, readManifest, unitState, statePath,
  rulebookFile, rulebookAmendmentsFile, rulebookVersionPath, readRulebookAmendments, rulebookIdentity, saveRulebookVersion } from './core.mjs';
import { phaseStaleness, currentPhase, autoPhases } from './phases.mjs';

const receipt = root => { try { return readJSON(safePath(root, 'migration/phases/02.json')); } catch { return null; } };
const recordedIdentity = r => Array.isArray(r?.evidence) ? r.evidence.find(e => Array.isArray(e) && e[0] === rulebookFile)?.[1] ?? null : null;

// Sections by Markdown heading; text before the first heading is its own section.
function sections(text) {
  const out = new Map();
  let heading = '(top)', body = [];
  const flush = () => { const key = out.has(heading) ? `${heading} (${out.size})` : heading; out.set(key, body); };
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) { flush(); heading = line.replace(/^#+\s*/, '').trim(); body = []; }
    else body.push(line);
  }
  flush();
  return out;
}
const meaningful = line => line.trim() && !/^[-*_=\s|:]+$/.test(line);
export function rulebookDiff(before, after) {
  const a = sections(before), b = sections(after), changed = [];
  for (const heading of new Set([...a.keys(), ...b.keys()])) {
    const old = a.get(heading) ?? [], now = b.get(heading) ?? [];
    const oldSet = new Set(old.map(l => l.trim())), nowSet = new Set(now.map(l => l.trim()));
    const added = now.filter(l => meaningful(l) && !oldSet.has(l.trim())), removed = old.filter(l => meaningful(l) && !nowSet.has(l.trim()));
    if (added.length || removed.length || a.has(heading) !== b.has(heading)) {
      // A construct tag anywhere in the section names what the section rules on.
      const tags = [...new Set([...old, ...now].flatMap(l => [...l.matchAll(/\bconstruct:\s*([^\s,;)]+)/giu)].map(m => m[1])))];
      changed.push({ heading, added, removed, tags, ...(!a.has(heading) ? { new: true } : !b.has(heading) ? { deleted: true } : {}) });
    }
  }
  return changed;
}
function inventoryRows(root) {
  let text = '';
  try { text = fs.readFileSync(safePath(root, 'migration/inventory.tsv'), 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map(l => Object.fromEntries(l.split('\t').map((v, i) => [header[i], v])));
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, term) => term.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(term)}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
// A finished unit may be touched when an inventory row of its source names a
// construct, classification or symbol the changed lines (or a changed section's
// construct tag) name. Best effort: a rule written without those words is
// listed as matching no file (also when it names only unfinished files), so
// the person can widen the choice.
function touched(root, config, changed) {
  const rows = inventoryRows(root), units = readManifest(root, config);
  const finished = units.filter(u => unitState(root, u)?.status === 'done');
  const bySource = new Map();
  const unmatched = [];
  for (const section of changed) {
    const text = [...section.added, ...section.removed].join('\n');
    let hit = false;
    for (const row of rows) {
      const terms = [row.source_construct, row.classification, row.symbol].filter(t => typeof t === 'string' && t !== 'UNKNOWN');
      const matched = terms.filter(t => mentions(text, t) || section.tags.some(tag => tag.toLowerCase() === t.toLowerCase()));
      if (!matched.length || !row.file) continue;
      if (finished.some(u => u.source === row.file)) hit = true;
      const set = bySource.get(row.file) ?? new Set();
      matched.forEach(t => set.add(t)); bySource.set(row.file, set);
    }
    if (!hit) unmatched.push(section.heading);
  }
  const candidates = finished.filter(u => bySource.has(u.source)).map(u => ({ target: u.target, source: u.source, matched: [...bySource.get(u.source)].sort() }));
  return { candidates, unmatched, finished: finished.length, units };
}
function previousVersion(root, identity) {
  // The last accepted version with this identity, else the reviewed one itself.
  const log = readRulebookAmendments(root)?.log ?? [];
  const last = [...log].reverse().find(e => e.identity === identity)?.to ?? identity;
  const rel = rulebookVersionPath(last), file = safePath(root, rel);
  return fileHash(file) === last ? { rel, text: fs.readFileSync(file, 'utf8') } : null;
}
export function rulebookChanges(root, config) {
  const r = receipt(root), identity = recordedIdentity(r);
  if (!identity) throw new Error('Phase 02 is not recorded with a RULEBOOK; a RULEBOOK change before phase 02 needs no acceptance (record phase 02 when it is reviewed)');
  const raw = fileHash(safePath(root, rulebookFile));
  if (!raw) throw new Error(`Required artifact missing: ${rulebookFile}`);
  const current = rulebookIdentity(root) === identity;
  // Other inputs that changed since phase 02 cannot be accepted this way.
  let other = [];
  try {
    const stale = phaseStaleness(root, config, '02');
    other = (stale?.reasons ?? []).filter(x => !((x.kind === 'evidence' && x.files?.length === 1 && x.files[0] === rulebookFile) || x.part === 'rulebook' || x.kind === 'predecessor')).map(x => x.what);
  } catch (e) { other = [e.message]; }
  if (current) return { kind: 'rulebook-changes', changed: false, other, next: other.length ? `The RULEBOOK is the reviewed version, but ${other.join('; ')} changed: follow phase next.` : 'The RULEBOOK is the reviewed version; nothing to accept.' };
  const previous = previousVersion(root, identity);
  const changed = previous ? rulebookDiff(previous.text, fs.readFileSync(safePath(root, rulebookFile), 'utf8')) : null;
  const { candidates, unmatched, finished } = changed ? touched(root, config, changed) : { candidates: [], unmatched: [], finished: readManifest(root, config).filter(u => unitState(root, u)?.status === 'done').length };
  const cap = list => list.slice(0, 20);
  return { kind: 'rulebook-changes', changed: true, previous: previous?.rel ?? null, finished,
    sections: changed ? changed.map(s => ({ heading: s.heading, added: cap(s.added), removed: cap(s.removed), ...(s.new ? { new: true } : {}), ...(s.deleted ? { deleted: true } : {}) })) : null,
    candidates, unmatched, other,
    next: other.length ? `Besides the RULEBOOK, ${other.join('; ')} changed since phase 02, so the change cannot be accepted alone: follow phase next.`
      : !previous ? `The reviewed RULEBOOK version is not in ${rulebookFile.replace('RULEBOOK.md', 'rulebook-history/')}, so the touched units cannot be listed. ${autoPhases(root) ? 'In auto mode pass --redo listed (nothing is listed): the run goes on and the report warns that the change was not checked against finished units.' : 'Ask the person which finished units to send back (rulebook accept --note TEXT --redo all|none|PATH,...).'}`
      : `Tell the person what changed and which of the ${finished} finished units it may touch (${candidates.length} listed${unmatched.length ? `; changed sections matching no file: ${unmatched.join(', ')}` : ''}), then run rulebook accept --note TEXT --redo listed|all|none|PATH,... with their choice (in auto mode: listed; for a changed section matching no file, read it and add the files it affects, none when nothing is listed and it cannot affect translated code; when you cannot tell, pass listed: the run goes on and the report warns).` };
}
export function acceptRulebook(root, config, { note, redo } = {}) {
  if (!note?.trim()) throw new Error('rulebook accept requires --note saying what changed and why');
  if (typeof redo !== 'string' || !redo.trim()) throw new Error('rulebook accept requires --redo listed|all|none|PATH,PATH');
  redo = redo.trim();
  if (['listed', 'all', 'none'].includes(redo.toLowerCase())) redo = redo.toLowerCase();
  // A list that names no file ("," from a template) is none, under none's checks.
  else if (!redo.split(',').some(t => t.trim())) redo = 'none';
  const release = lockRun(root, 'rulebook-accept');
  try {
    const changes = rulebookChanges(root, config);
    if (!changes.changed) throw new Error(changes.next);
    if (changes.other.length) throw new Error(changes.next);
    const identity = recordedIdentity(receipt(root)), raw = fileHash(safePath(root, rulebookFile));
    const units = readManifest(root, config);
    // Auto mode decides without the person and never stops for it. It never
    // drops a listed file. For a changed section no file matches by words,
    // the agent reads it and names the files it affects (none when nothing is
    // listed and it cannot affect translated code); when it cannot tell, it
    // passes listed and the run goes on with a warning in the report, instead
    // of sending every finished unit back.
    let unresolved = [];
    if (autoPhases(root) && redo !== 'all') {
      const listed = changes.candidates.map(c => c.target), named = ['listed', 'none'].includes(redo) ? null : redo.split(',').map(t => t.trim()).filter(Boolean);
      const missing = named ? listed.filter(t => !named.includes(t)) : [];
      if (redo === 'none' && listed.length) throw new Error(`In auto mode --redo none is refused while ${listed.length} listed file(s) may be touched: pass listed, or the listed files with more`);
      if (missing.length) throw new Error(`In auto mode a file list keeps every listed file; missing: ${missing.join(', ')}`);
      if (redo === 'listed') unresolved = changes.previous === null ? ['(the reviewed RULEBOOK version is not kept; what changed is unknown)'] : changes.unmatched;
    }
    const finished = units.filter(u => unitState(root, u)?.status === 'done');
    let targets;
    if (redo === 'all') targets = units.map(u => u.target);
    else if (redo === 'none') targets = [];
    else if (redo === 'listed') {
      if (changes.previous === null) throw new Error('--redo listed needs the reviewed RULEBOOK version, which is not kept; choose all, none or name the files');
      targets = changes.candidates.map(c => c.target);
    } else {
      targets = [...new Set(redo.split(',').map(t => t.trim()).filter(Boolean))];
      const unknown = targets.filter(t => !units.some(u => u.target === t));
      if (unknown.length) throw new Error(`Not manifest targets: ${unknown.join(', ')}`);
    }
    // The chosen units go back to review first (their output stays): a stop
    // before the acceptance is written leaves them to be reviewed, never a
    // logged redo that did not happen. A unit still in review, arbitration or
    // a fix is sent back too, since its reviews read the old rules.
    const sent = [];
    for (const u of units) {
      const state = unitState(root, u);
      if (!state || state.stage === 'implement') continue;
      if (!targets.includes(u.target) && state.status === 'done') continue;
      Object.assign(state, { status: 'pending', stage: 'review', round: 0, reviewMap: {}, reviews: [], reviewEvidence: [], redoAfterAmendment: stamp() });
      for (const key of ['arbitration', 'singlePass', 'markerEvidence', 'error', 'diagnostic', 'repairIntentId', 'repairIntentHash', 'repairDiagnosticHash']) delete state[key];
      writeJSON(statePath(root, u), state); sent.push(u.target);
    }
    const before = readRulebookAmendments(root) ?? { schemaVersion: 1, accepted: {}, log: [] };
    const previous = [...before.log].reverse().find(e => e.identity === identity)?.to ?? identity;
    const entry = { at: stamp(), identity, from: previous, to: raw, note: note.trim(), redo: sent, ...(autoPhases(root) ? { auto: true } : {}), ...(unresolved.length ? { unresolved } : {}) };
    const after = { schemaVersion: 1, accepted: { ...before.accepted, [raw]: identity }, log: [...before.log, entry] };
    const file = safePath(root, rulebookAmendmentsFile), old = fs.existsSync(file) ? fs.readFileSync(file) : null;
    writeJSON(file, after);
    // The record must hold again; otherwise nothing was accepted.
    let holds = false;
    try { holds = Boolean(currentPhase(root, config, '02')); } catch {}
    if (!holds) {
      if (old) fs.writeFileSync(file, old); else fs.rmSync(file, { force: true });
      let why = 'follow phase next';
      try { why = phaseStaleness(root, config, '02')?.next ?? why; } catch {}
      throw new Error(`Phase 02 is still out of date after accepting the RULEBOOK: ${why}`);
    }
    saveRulebookVersion(root);
    const kept = finished.filter(u => !sent.includes(u.target)).length;
    return { kind: 'rulebook-accept', accepted: raw, identity, redo: sent, kept, ...(entry.auto ? { auto: true } : {}), ...(unresolved.length ? { unresolved } : {}),
      ...(unresolved.length ? { warning: `Not checked against finished units: ${unresolved.join(', ')}. Put this warning in the report; finished code may still follow the old rule there.` } : {}),
      next: sent.length ? `Run translate: ${sent.length} unit(s) are reviewed again under the amended RULEBOOK; the other ${kept} finished units stay done.` : 'No unit was sent back; phases, approvals and finished units stay current.' };
  } finally { release(); }
}
export function rulebookMarkdown(result) {
  if (result.kind === 'rulebook-accept') return `# RULEBOOK accepted\n\n- Sent back to review: ${result.redo.length}${result.redo.length ? ` (${result.redo.slice(0, 20).join(', ')}${result.redo.length > 20 ? ', ...' : ''})` : ''}\n- Finished units kept: ${result.kept}\n${result.warning ? `- Warning: ${result.warning}\n` : ''}\n${result.next}`;
  if (!result.changed) return `# RULEBOOK changes\n\n${result.next}`;
  const lines = ['# RULEBOOK changes', '', `Compared with: ${result.previous ?? '(reviewed version not kept)'}`, ''];
  for (const s of result.sections ?? []) {
    lines.push(`## ${s.heading}${s.new ? ' (new)' : s.deleted ? ' (deleted)' : ''}`);
    for (const l of s.removed) lines.push(`- removed: ${l.trim()}`);
    for (const l of s.added) lines.push(`- added: ${l.trim()}`);
    lines.push('');
  }
  lines.push(`Finished units: ${result.finished}; may be touched: ${result.candidates.length}`);
  for (const c of result.candidates.slice(0, 50)) lines.push(`- ${c.target} (${c.matched.join(', ')})`);
  if (result.candidates.length > 50) lines.push(`- ... and ${result.candidates.length - 50} more`);
  if (result.unmatched.length) lines.push('', `Changed sections that match no file: ${result.unmatched.join(', ')}`);
  lines.push('', result.next);
  return lines.join('\n');
}
