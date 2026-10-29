// SPDX-License-Identifier: Apache-2.0
// An authorization copied to an isolated project is checked against its parent.
// It never replaces the production phase-03 gate or imports production receipts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath, readJSON, writeJSON, fileHash, contextHash, loadConfig, readManifest, reviewSources, filesUnder, verificationFiles, atomicWrite, lockRun, stamp } from './core.mjs';
import { currentPhase } from './phases.mjs';

export const executionPurpose = config => config.executionPurpose ?? 'production';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const within = (a, b) => a === b || a.startsWith(`${b}${path.sep}`);
function preparedJudge(root, config, context) {
  const judge = readJSON(safePath(root, 'migration/results/judge.json'));
  return judge.success && !judge.invalidatedAt && judge.executionId && judge.contextHash === context &&
    (judge.purpose ?? 'production') === 'production' &&
    !(judge.evidence?.some(([name, checksum]) => !checksum || fileHash(safePath(root, name)) !== checksum));
}

export function requirePilot(root, config) {
  if (executionPurpose(config) !== 'pilot') return null;
  const ref = config.pilot;
  if (!ref || !idPattern.test(ref.id) || !path.isAbsolute(ref.parentRoot)) throw new Error('Pilot requires a parent authorization reference');
  const child = fs.realpathSync(root), parent = fs.realpathSync(ref.parentRoot);
  if (within(child, parent) || within(parent, child)) throw new Error('Pilot must be outside its production project');
  const local = safePath(child, 'migration/pilot.json'), original = safePath(parent, `migration/pilots/${ref.id}.json`);
  if (!fileHash(local) || fileHash(local) !== fileHash(original)) throw new Error('Pilot authorization missing, changed or revoked');
  const grant = readJSON(local), parentConfig = loadConfig(parent), parentContext = contextHash(parent, parentConfig);
  if (grant.schemaVersion !== 1 || grant.purpose !== 'pilot' || grant.id !== ref.id || grant.childRoot !== child || grant.parentRoot !== parent ||
      !grant.note?.trim() || executionPurpose(parentConfig) !== 'production' || grant.parentContext !== parentContext ||
      grant.phase02Hash !== fileHash(safePath(parent, 'migration/phases/02.json')) || !currentPhase(parent, parentConfig, '02') ||
      grant.judgeHash !== fileHash(safePath(parent, 'migration/results/judge.json'))) throw new Error('Pilot parent preparation or judge changed; prepare a new isolated pilot');
  if (!preparedJudge(parent, parentConfig, parentContext)) throw new Error('Pilot requires current parent judge validation and unchanged evidence');
  if (grant.context !== contextHash(child, config) || JSON.stringify(grant.targets) !== JSON.stringify(readManifest(child, config).map(u => u.target))) throw new Error('Pilot scope or sealed inputs changed');
  if (!['translation', 'build', 'smoke', 'parity'].includes(grant.through)) throw new Error('Invalid pilot execution boundary');
  return grant;
}

export function preparePilot(root, config, { target, sources, through = 'translation', note } = {}) {
  if (executionPurpose(config) !== 'production') throw new Error('A pilot cannot authorize another pilot');
  if (config.mode !== 'preserve') throw new Error('The pilot file runner currently supports preserve mode only');
  if (!note?.trim() || !Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) throw new Error('Pilot needs explicit source selections and an authorization --note');
  if (!['translation', 'build', 'smoke', 'parity'].includes(through) || (through === 'parity' && config.verificationMode === 'source-only')) throw new Error('Invalid pilot boundary for this verification mode');
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
    if (!currentPhase(parent, config, '02')) throw new Error('Review parent phases 00 through 02 before authorizing a pilot');
    const context = contextHash(parent, config), judgeFile = safePath(parent, 'migration/results/judge.json');
    if (!preparedJudge(parent, config, context)) throw new Error('Run parent judge successfully with unchanged evidence before preparing a pilot');
    const units = readManifest(parent, config), bySource = new Map(units.map(u => [u.source, u]));
    for (const source of sources) if (!bySource.has(source)) throw new Error(`Pilot source is not in the manifest: ${source}`);
    const selected = new Set(sources.flatMap(source => reviewSources(parent, config, source)).filter(source => bySource.has(source)));
    const scope = units.filter(u => selected.has(u.source));
    const stages = ['translation', 'build', 'smoke', 'parity'].slice(0, ['translation', 'build', 'smoke', 'parity'].indexOf(through) + 1);
    for (const stage of stages.filter(s => s !== 'translation')) if (!config.commands?.[stage]) throw new Error(`Configure commands.${stage} before authorizing that pilot boundary`);
    for (const argv of Object.values(config.commands ?? {})) for (const [i, arg] of (argv ?? []).entries()) {
      const value = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
      if ((path.isAbsolute(value) && within(value, parent)) || (i > 0 && /^\.\.([/\\]|$)/.test(value))) throw new Error('Pilot commands must use project-relative inputs, not parent paths');
    }
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
      context: contextHash(child, childConfig), requestedSources: sources, sources: scope.map(u => u.source), targets: scope.map(u => u.target), through, note: note.trim(), authorizedAt: stamp() };
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
