// SPDX-License-Identifier: Apache-2.0
// An authorization copied to an isolated project is checked against its parent.
// It never replaces the production phase-03 gate or imports production receipts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath, readJSON, writeJSON, fileHash, contextHash, loadConfig, readManifest, reviewSources, filesUnder, verificationFiles, atomicWrite, lockRun, stamp, readMemo } from './core.mjs';
import { currentPhase, earliestStale, inputRead, readContext } from './phases.mjs';
import { autoModeOn } from './auto-mode.mjs';

export const executionPurpose = config => config.executionPurpose ?? 'production';
// Which files a pilot translates. Upstream pilots the same three files as the
// bakeoff and adds nothing ("run the same [3] files through the pilot run",
// prompts/03-stress-test.md at the UPSTREAM.json commit). This adaptation adds
// every manifest file they use, transitively, because a per-unit typecheck and
// a build, smoke or parity boundary need those as translated targets. A translation-only pilot without
// a unit typecheck does not: the reviewers read the original sources of what a
// file uses (lib/review.mjs) and the implementer translates from the source.
// Auto mode asks nobody about the count, so there such a pilot keeps only the
// chosen files (2026-11-01: three chosen files grew to 40, half a day, unasked).
export const pilotNeedsDependencies = (config, through) => through !== 'translation' || Boolean(config.commands?.typecheck);
const chosenOnly = (root, config, through) => !pilotNeedsDependencies(config, through) && autoModeOn(root);
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const within = (a, b) => a === b || a.startsWith(`${b}${path.sep}`);
function preparedJudge(root, config, context) {
  const judge = readJSON(safePath(root, 'migration/results/judge.json'));
  return judge.success && !judge.invalidatedAt && judge.executionId && judge.contextHash === context &&
    (judge.purpose ?? 'production') === 'production' &&
    !(judge.evidence?.some(([name, checksum]) => !checksum || fileHash(safePath(root, name)) !== checksum));
}

// context: the pilot's own contextHash when the caller has just computed it
// (the runner's input check), so it is not read a second time. memo: the
// readMemo of the caller's read (status, or the gates a phase command
// checks), shared by the parent's and the pilot's own reads; none of what a
// phase command writes is among those inputs.
export function requirePilot(root, config, { context, memo: shared } = {}) {
  if (executionPurpose(config) !== 'pilot') return null;
  const ref = config.pilot;
  if (!ref || !idPattern.test(ref.id) || !path.isAbsolute(ref.parentRoot)) throw new Error('Pilot requires a parent authorization reference');
  const child = fs.realpathSync(root), parent = fs.realpathSync(ref.parentRoot);
  if (within(child, parent) || within(parent, child)) throw new Error('Pilot must be outside its production project');
  const local = safePath(child, 'migration/pilot.json'), original = safePath(parent, `migration/pilots/${ref.id}.json`);
  if (!fileHash(local) || fileHash(local) !== fileHash(original)) throw new Error('Pilot authorization missing, changed or revoked');
  // One read of the parent for this check: its context, the phase 02 chain
  // (the fingerprint of every phase and the 00b judge inputs) and the judge
  // read each parent file once. The runner checks before and after every
  // worker call, so on 2026-11-01 a pilot read each parent source file
  // about 11 times per check, and each file of its own copy 6 times.
  const memo = shared ?? readMemo();
  const grant = readJSON(local), parentConfig = loadConfig(parent), parentContext = contextHash(parent, parentConfig, memo);
  if (grant.schemaVersion !== 1 || grant.purpose !== 'pilot' || grant.id !== ref.id || grant.childRoot !== child || grant.parentRoot !== parent ||
      !grant.note?.trim() || executionPurpose(parentConfig) !== 'production' || grant.parentContext !== parentContext ||
      grant.phase02Hash !== fileHash(safePath(parent, 'migration/phases/02.json')) ||
      grant.judgeHash !== fileHash(safePath(parent, 'migration/results/judge.json'))) throw new Error('Pilot parent preparation or judge changed; prepare a new isolated pilot');
  // The record this pilot was prepared on is still there but not current,
  // often because a note was added to a report of phases 00 to 02. Removing
  // that note makes the pilot usable again; recording again ends it. One read
  // of the parent for these checks (its context is known already, and the
  // memo shares the file reads of that context with the phase chain).
  const parentRead = { contextKnown: true, context: parentContext, memo };
  if (!currentPhase(parent, parentConfig, '02', parentRead)) {
    const first = earliestStale(parent, parentConfig, ['00', '00b', '01', '02'], parentRead), next = `phase next --root "${parent}"`;
    throw Object.assign(new Error(first?.reportsOnly
      ? `Pilot parent phase 02 is out of date since this pilot was prepared: in ${parent}, ${first.reasons.map(x => x.what).join(', ')} changed after phase ${first.phase} was recorded. If that edit only noted progress or a later result (such as the formal judge outcome), remove exactly what was added with a file edit tool, not git, and this pilot works again (in auto mode do this without asking); ${next} says the same. Recording those phases again instead ends this pilot (pilot prepare and pilot run again).`
      : `Pilot parent phase 02 is out of date since this pilot was prepared; ${next} says what to record again, which ends this pilot (pilot prepare and pilot run again).`), { code: 'pilot-parent-stale', parentRoot: parent });
  }
  if (!preparedJudge(parent, parentConfig, parentContext)) throw new Error('Pilot requires current parent judge validation and unchanged evidence');
  if (grant.context !== (context ?? contextHash(child, config, memo)) || JSON.stringify(grant.targets) !== JSON.stringify(readManifest(child, config, undefined, memo).map(u => u.target))) throw new Error('Pilot scope or sealed inputs changed');
  if (!['translation', 'build', 'smoke', 'parity'].includes(grant.through)) throw new Error('Invalid pilot execution boundary');
  return grant;
}

// The checks and scope shared by plan and prepare, so a count the person
// approved from plan is the one prepare authorizes (or prepare refuses).
function pilotScope(parent, config, sources, through) {
  if (executionPurpose(config) !== 'production') throw new Error('A pilot cannot authorize another pilot');
  if (config.mode !== 'preserve') throw new Error('The pilot file runner currently supports preserve mode only');
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) throw new Error('Pilot needs explicit source selections (--sources)');
  if (!['translation', 'build', 'smoke', 'parity'].includes(through) || (through === 'parity' && config.verificationMode === 'source-only')) throw new Error('Invalid pilot boundary for this verification mode');
  // A recorded phase out of date (a note added to its report, often) gets
  // what it needs, which may be removing the note rather than recording again.
  // One read of the parent for these checks and its context.
  const read = inputRead();
  if (!currentPhase(parent, config, '02', read)) {
    const first = earliestStale(parent, config, ['00', '00b', '01', '02'], read);
    throw new Error(first ? `Phase ${first.phase}'s record is out of date, so a pilot cannot be authorized yet. ${first.next}` : 'Review parent phases 00 through 02 before authorizing a pilot');
  }
  const context = readContext(parent, config, read);
  if (!preparedJudge(parent, config, context)) throw new Error('Run parent judge successfully with unchanged evidence before preparing a pilot');
  const units = readManifest(parent, config), bySource = new Map(units.map(u => [u.source, u]));
  for (const source of sources) if (!bySource.has(source)) throw new Error(`Pilot source is not in the manifest: ${source}`);
  // Walked in both cases: a missing declaration stops plan, not the run.
  const used = new Set(sources.flatMap(source => reviewSources(parent, config, source)).filter(source => bySource.has(source)));
  const only = chosenOnly(parent, config, through), selected = only ? new Set(sources) : used;
  const scope = units.filter(u => selected.has(u.source));
  // In manifest order, like the scope: the files the chosen ones use that stay untranslated.
  const readOnly = only ? units.filter(u => used.has(u.source) && !selected.has(u.source)).map(u => u.source) : [];
  const stages = ['translation', 'build', 'smoke', 'parity'].slice(0, ['translation', 'build', 'smoke', 'parity'].indexOf(through) + 1);
  for (const stage of stages.filter(s => s !== 'translation')) if (!config.commands?.[stage]) throw new Error(`Configure commands.${stage} before authorizing that pilot boundary`);
  for (const argv of Object.values(config.commands ?? {})) for (const [i, arg] of (argv ?? []).entries()) {
    const value = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if ((path.isAbsolute(value) && within(value, parent)) || (i > 0 && /^\.\.([/\\]|$)/.test(value))) throw new Error('Pilot commands must use project-relative inputs, not parent paths');
  }
  return { context, units, scope, scopeKind: only ? 'chosen-only' : 'with-dependencies', readOnly };
}

// Read-only preview of a pilot's scope: the chosen sources plus every declared
// review dependency, which pilot prepare adds without asking (in auto mode,
// for a translation-only pilot without a unit typecheck, the chosen sources
// only). Shown before the one approval so the person approves the final file
// count, not a smaller one.
export function planPilot(root, config, { sources, through = 'translation' } = {}) {
  const parent = fs.realpathSync(root), { scope: units, scopeKind, readOnly } = pilotScope(parent, config, sources, through);
  const scope = units.map(u => u.source), added = scope.filter(s => !sources.includes(s)), only = scopeKind === 'chosen-only';
  // Pilot run starts with judge, which runs the original's tests in runtime mode only.
  const runsTests = config.verificationMode !== 'source-only';
  // No template nests another, so the plainness test reads each sentence whole.
  const readOnlyNote = readOnly.length
    ? { ja: `自動モードなので、それらが使っている ${readOnly.length} ファイルは変換せず、AIの確認で元のコードを読むだけにします。`,
      en: ` In auto mode the ${readOnly.length === 1 ? 'file' : readOnly.length + ' files'} used by ${sources.length === 1 ? 'it' : 'them'} ${readOnly.length === 1 ? 'is' : 'are'} not translated; the AI check reads the original code.` }
    : { ja: '', en: '' };
  const files = only
    ? { ja: `選んだ ${sources.length} ファイルだけを、プロジェクトの外のコピーで試します。${readOnlyNote.ja}`,
      en: `Try only the ${sources.length === 1 ? 'chosen file' : sources.length + ' chosen files'} in a copy outside the project.${readOnlyNote.en}` }
    : { ja: `選んだ ${sources.length} ファイルと、それらが使っている ${added.length} ファイル、合わせて ${scope.length} ファイルを、プロジェクトの外のコピーで試します。`,
      en: `Try ${sources.length} chosen files plus the ${added.length} files they use, ${scope.length} in all, in a copy outside the project.` };
  return { requestedSources: sources, sources: scope, added, scopeKind, ...(only ? { readOnly } : {}),
    counts: { requested: sources.length, added: added.length, total: scope.length, ...(only ? { readOnly: readOnly.length } : {}) }, through,
    plain: { ja: `${files.ja}${through === 'translation' ? '変換とAIの確認までで、変換後のビルドや動作確認はしません。' : (through === 'parity' ? '変換とAIの確認のあと、変換後のビルドと動作確認を行い、元のコードと動きを比べます。' : '変換とAIの確認のあと、変換後のビルドや動作確認も行います。')}${runsTests ? '最初に元のコードのテストを動かします。' : ''}あなたのコードは変わらず、プロジェクトには試運転の許可記録が1つ増えるだけです。`,
      en: `${files.en} ${through === 'translation' ? 'It translates and has AI check the result; it does not build or run the translated code.' : (through === 'parity' ? 'After translation and the AI check it builds and runs the translated code and compares it with the original.' : 'After translation and the AI check it also builds and runs the translated code.')}${runsTests ? ' It first runs the original code\'s tests.' : ''} Your code does not change; the project only gains one pilot permission record.` } };
}

export function preparePilot(root, config, { target, sources, through = 'translation', note, expectTotal } = {}) {
  if (!note?.trim() || !Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) throw new Error('Pilot needs explicit source selections and an authorization --note');
  if (!target) throw new Error('Pilot requires a new --target directory outside the production project');
  const parent = fs.realpathSync(root), requested = path.resolve(target);
  let ancestor = path.dirname(requested);
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const destination = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, requested));
  if (within(destination, parent) || within(parent, destination)) throw new Error('Pilot target must be outside the production project');
  if (fs.existsSync(destination)) throw new Error('Pilot target must be a new directory; never overwrite existing work');
  const release = lockRun(parent, 'pilot-prepare');
  let created = false, grantFile;
  try {
    const { context, units, scope, scopeKind, readOnly } = pilotScope(parent, config, sources, through), judgeFile = safePath(parent, 'migration/results/judge.json');
    // The person approved the count pilot plan showed; a different scope now needs a new question.
    if (expectTotal !== undefined && Number(expectTotal) !== scope.length) throw new Error(`Pilot scope is ${scope.length} files, not the ${expectTotal} approved; run pilot plan again and ask with the new count`);
    const names = new Set([
      ...[...config.sourceRoots, ...config.verificationRoots, 'migration-kit', '.github', 'AGENTS.md'].flatMap(p => filesUnder(parent, p)),
      ...units.map(u => u.source), ...Object.keys(readJSON(safePath(parent, config.reviewDependencyMap ?? 'migration/review-dependencies.json')).dependencies),
      ...verificationFiles(parent, config), 'migration/RULEBOOK.md', 'migration/inventory.tsv', config.reviewDependencyMap ?? 'migration/review-dependencies.json',
      'migration/feasibility.md', 'migration/judge-report.md', 'migration/depmap/report.md', 'migration/gap-report.md',
      ...(config.verificationMode === 'source-only' ? ['migration/judge-plan.json'] : []),
      ...(config.packageMap ? [config.packageMap] : [])
    ]);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    // Exclusive creation also rejects a competing creator after the early check.
    fs.mkdirSync(destination); created = true;
    const child = fs.realpathSync(destination);
    for (const name of names) {
      const input = safePath(parent, name);
      if (fs.existsSync(input) && fs.statSync(input).isFile()) {
        const output = safePath(child, name); atomicWrite(output, fs.readFileSync(input));
        fs.chmodSync(output, fs.statSync(input).mode & 0o777);
      }
    }
    const id = crypto.randomUUID(), childConfig = { ...config, phasePolicy: 'strict', executionPurpose: 'pilot', pilot: { id, parentRoot: parent } };
    writeJSON(safePath(child, 'migration/config.json'), childConfig);
    atomicWrite(safePath(child, 'migration/manifest.tsv'), 'source\ttarget\n' + scope.map(u => `${u.source}\t${u.target}\n`).join(''));
    const grant = { schemaVersion: 1, purpose: 'pilot', id, parentRoot: parent, childRoot: child, parentContext: context,
      phase02Hash: fileHash(safePath(parent, 'migration/phases/02.json')), judgeHash: fileHash(judgeFile),
      context: contextHash(child, childConfig), requestedSources: sources, sources: scope.map(u => u.source), targets: scope.map(u => u.target), through, scopeKind, ...(scopeKind === 'chosen-only' ? { readOnly } : {}), note: note.trim(), authorizedAt: stamp() };
    if (contextHash(parent, config) !== context) throw new Error('Parent inputs changed while preparing the pilot');
    grantFile = safePath(parent, `migration/pilots/${id}.json`);
    writeJSON(grantFile, grant);
    writeJSON(safePath(child, 'migration/pilot.json'), grant);
    requirePilot(child, childConfig);
    return grant;
  } catch (e) {
    if (created) fs.rmSync(destination, { recursive: true, force: true });
    if (grantFile) fs.rmSync(grantFile, { force: true });
    throw e;
  } finally { release(); }
}
